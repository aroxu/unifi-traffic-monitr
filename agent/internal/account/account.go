// Package account turns cumulative conntrack counters into per-client byte totals.
package account

import (
	"math/bits"
	"net/netip"
	"sort"
	"time"
)

// BucketSize matches the collector's five-minute rollups.
const BucketSize = 5 * time.Minute

// Unattributed collects client-subnet traffic whose MAC address is unknown.
const Unattributed = "unattributed"

// Scope tells whether the peer of a client was reached through a WAN link.
type Scope uint8

const (
	Internet Scope = iota
	LAN
)

// FlowKey identifies one conntrack entry. The kernel may reuse IDs, so the
// original tuple is part of the key.
type FlowKey struct {
	ID           uint32
	Zone         uint16
	Proto        uint8
	Src, Dst     netip.Addr
	SPort, DPort uint16
}

// Flow is the subset of a conntrack entry the accounting needs.
type Flow struct {
	Key        FlowKey
	OrigSrc    netip.Addr // initiator
	ReplySrc   netip.Addr // responder, after destination NAT
	OrigBytes  uint64
	ReplyBytes uint64
}

// Delta holds the bytes a flow moved since it was last observed.
type Delta struct {
	Flow       Flow
	OrigBytes  uint64
	ReplyBytes uint64
}

// Attribution assigns one side of a flow to a client.
type Attribution struct {
	Subject   string
	Scope     Scope
	Initiator bool
}

// UpDown converts flow directions to the client's upload and download.
func (a Attribution) UpDown(d Delta) (up, down uint64) {
	if a.Initiator {
		return d.OrigBytes, d.ReplyBytes
	}
	return d.ReplyBytes, d.OrigBytes
}

type flowState struct {
	orig, reply uint64
	seen        uint64
}

type tombstone struct {
	orig, reply uint64
	expires     time.Time
}

// tombstoneTTL keeps the last counters of flows that left the table without a
// processed destroy event, so a late event adds only the remaining bytes.
const tombstoneTTL = time.Minute

// Tracker compares successive conntrack dumps and destroy events.
type Tracker struct {
	flows      map[FlowKey]*flowState
	tombstones map[FlowKey]tombstone
	gen        uint64
	baselined  bool
	// Missed counts flows that disappeared without a destroy event. Their
	// bytes after the last dump are unknown.
	Missed uint64
}

func NewTracker() *Tracker {
	return &Tracker{flows: map[FlowKey]*flowState{}, tombstones: map[FlowKey]tombstone{}}
}

// Baselined reports whether a first dump has been recorded.
func (t *Tracker) Baselined() bool { return t.baselined }

// Tracked returns the number of live flows being compared.
func (t *Tracker) Tracked() int { return len(t.flows) }

// Reset forgets all flows. The next dump becomes a new baseline.
func (t *Tracker) Reset() {
	t.flows = map[FlowKey]*flowState{}
	t.tombstones = map[FlowKey]tombstone{}
	t.baselined = false
}

func advance(s *flowState, f Flow) (uint64, uint64) {
	var o, r uint64
	if f.OrigBytes < s.orig || f.ReplyBytes < s.reply {
		// A decreasing counter means a new entry reused the key.
		o, r = f.OrigBytes, f.ReplyBytes
	} else {
		o, r = f.OrigBytes-s.orig, f.ReplyBytes-s.reply
	}
	s.orig, s.reply = f.OrigBytes, f.ReplyBytes
	return o, r
}

// Dump compares a complete conntrack table with the previous one. The first
// dump only records baselines because earlier bytes cannot be placed in time.
func (t *Tracker) Dump(flows []Flow, now time.Time) []Delta {
	t.gen++
	out := make([]Delta, 0, 64)
	for _, f := range flows {
		s := t.flows[f.Key]
		if s == nil {
			tb, ok := t.tombstones[f.Key]
			if !ok {
				t.flows[f.Key] = &flowState{orig: f.OrigBytes, reply: f.ReplyBytes, seen: t.gen}
				if t.baselined && (f.OrigBytes > 0 || f.ReplyBytes > 0) {
					out = append(out, Delta{Flow: f, OrigBytes: f.OrigBytes, ReplyBytes: f.ReplyBytes})
				}
				continue
			}
			delete(t.tombstones, f.Key)
			s = &flowState{orig: tb.orig, reply: tb.reply}
			t.flows[f.Key] = s
		}
		o, r := advance(s, f)
		s.seen = t.gen
		if o > 0 || r > 0 {
			out = append(out, Delta{Flow: f, OrigBytes: o, ReplyBytes: r})
		}
	}
	for key, s := range t.flows {
		if t.gen-s.seen >= 2 {
			delete(t.flows, key)
			t.tombstones[key] = tombstone{orig: s.orig, reply: s.reply, expires: now.Add(tombstoneTTL)}
		}
	}
	for key, tb := range t.tombstones {
		if !now.Before(tb.expires) {
			delete(t.tombstones, key)
			t.Missed++
		}
	}
	t.baselined = true
	return out
}

// Destroy accounts the final counters carried by a destroy event.
func (t *Tracker) Destroy(f Flow) (Delta, bool) {
	if s := t.flows[f.Key]; s != nil {
		delete(t.flows, f.Key)
		o, r := advance(s, f)
		return Delta{Flow: f, OrigBytes: o, ReplyBytes: r}, o > 0 || r > 0
	}
	if tb, ok := t.tombstones[f.Key]; ok {
		delete(t.tombstones, f.Key)
		s := flowState{orig: tb.orig, reply: tb.reply}
		o, r := advance(&s, f)
		return Delta{Flow: f, OrigBytes: o, ReplyBytes: r}, o > 0 || r > 0
	}
	if !t.baselined {
		return Delta{}, false
	}
	// A flow that started and ended between dumps.
	return Delta{Flow: f, OrigBytes: f.OrigBytes, ReplyBytes: f.ReplyBytes}, f.OrigBytes > 0 || f.ReplyBytes > 0
}

// BucketStart returns the UTC five-minute bucket containing t.
func BucketStart(t time.Time) time.Time { return t.UTC().Truncate(BucketSize) }

// Part is a share of bytes assigned to one bucket.
type Part struct {
	Start time.Time
	Bytes uint64
}

func mulDiv(a, b, c uint64) uint64 {
	hi, lo := bits.Mul64(a, b)
	q, _ := bits.Div64(hi, lo, c)
	return q
}

// Split spreads n bytes over [from, to) in proportion to time. The parts
// always add up to n.
func Split(n uint64, from, to time.Time) []Part {
	if n == 0 {
		return nil
	}
	if !to.After(from) {
		return []Part{{Start: BucketStart(to), Bytes: n}}
	}
	total := uint64(to.Sub(from))
	var parts []Part
	var assigned uint64
	for b := BucketStart(from); b.Before(to); b = b.Add(BucketSize) {
		end := b.Add(BucketSize)
		if end.After(to) {
			end = to
		}
		cum := mulDiv(n, uint64(end.Sub(from)), total)
		if cum > assigned {
			parts = append(parts, Part{Start: b, Bytes: cum - assigned})
			assigned = cum
		}
	}
	return parts
}

// Counters are one client's bytes in one bucket.
type Counters struct {
	InternetUp, InternetDown, LANUp, LANDown uint64
}

// Add records bytes for a scope.
func (c *Counters) Add(scope Scope, up, down uint64) {
	if scope == Internet {
		c.InternetUp += up
		c.InternetDown += down
		return
	}
	c.LANUp += up
	c.LANDown += down
}

// Zero reports whether no bytes were recorded.
func (c Counters) Zero() bool { return c == Counters{} }

// Bucket is one five-minute ledger entry.
type Bucket struct {
	Start    time.Time
	Coverage time.Duration
	Subjects map[string]*Counters
}

func (b *Bucket) subject(name string) *Counters {
	c := b.Subjects[name]
	if c == nil {
		c = &Counters{}
		b.Subjects[name] = c
	}
	return c
}

// Clone returns a deep copy.
func (b *Bucket) Clone() *Bucket {
	out := &Bucket{Start: b.Start, Coverage: b.Coverage, Subjects: make(map[string]*Counters, len(b.Subjects))}
	for name, c := range b.Subjects {
		copied := *c
		out.Subjects[name] = &copied
	}
	return out
}

// Accumulator keeps the open buckets.
type Accumulator struct {
	open map[int64]*Bucket
	// Buckets starting before closedThrough are final. Late bytes move to the
	// first open bucket so they are not lost.
	closedThrough time.Time
}

func NewAccumulator() *Accumulator { return &Accumulator{open: map[int64]*Bucket{}} }

// SetClosedThrough marks buckets before t as already final.
func (a *Accumulator) SetClosedThrough(t time.Time) {
	if t.After(a.closedThrough) {
		a.closedThrough = t
	}
}

func (a *Accumulator) bucket(start time.Time) *Bucket {
	if start.Before(a.closedThrough) {
		start = a.closedThrough
	}
	key := start.Unix()
	b := a.open[key]
	if b == nil {
		b = &Bucket{Start: start, Subjects: map[string]*Counters{}}
		a.open[key] = b
	}
	return b
}

// Add records bytes moved during [from, to).
func (a *Accumulator) Add(subject string, scope Scope, up, down uint64, from, to time.Time) {
	for _, p := range Split(up, from, to) {
		a.bucket(p.Start).subject(subject).Add(scope, p.Bytes, 0)
	}
	for _, p := range Split(down, from, to) {
		a.bucket(p.Start).subject(subject).Add(scope, 0, p.Bytes)
	}
}

// Cover records that accounting was active during [from, to).
func (a *Accumulator) Cover(from, to time.Time) {
	for b := BucketStart(from); b.Before(to); b = b.Add(BucketSize) {
		if b.Before(a.closedThrough) {
			continue
		}
		start, end := b, b.Add(BucketSize)
		if from.After(start) {
			start = from
		}
		if to.Before(end) {
			end = to
		}
		bucket := a.bucket(b)
		bucket.Coverage += end.Sub(start)
		if bucket.Coverage > BucketSize {
			bucket.Coverage = BucketSize
		}
	}
}

// Touch ensures the given clients appear in the bucket containing at.
// A zero entry records that the client was present and moved no bytes.
func (a *Accumulator) Touch(subjects []string, at time.Time) {
	b := a.bucket(BucketStart(at))
	for _, name := range subjects {
		b.subject(name)
	}
}

// CloseBefore removes and returns buckets that ended at or before t.
func (a *Accumulator) CloseBefore(t time.Time) []*Bucket {
	var out []*Bucket
	for key, b := range a.open {
		if !b.Start.Add(BucketSize).After(t) {
			out = append(out, b)
			delete(a.open, key)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start.Before(out[j].Start) })
	if len(out) > 0 {
		a.SetClosedThrough(out[len(out)-1].Start.Add(BucketSize))
	}
	return out
}

// CloseAll removes and returns every open bucket.
func (a *Accumulator) CloseAll() []*Bucket {
	return a.CloseBefore(time.Unix(1<<40, 0))
}

// Snapshot returns copies of the open buckets in time order.
func (a *Accumulator) Snapshot() []*Bucket {
	out := make([]*Bucket, 0, len(a.open))
	for _, b := range a.open {
		out = append(out, b.Clone())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start.Before(out[j].Start) })
	return out
}
