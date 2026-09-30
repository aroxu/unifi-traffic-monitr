// Package agent runs the accounting loop.
package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"time"

	"github.com/aroxu/unifi-traffic-monitr/agent/internal/account"
	"github.com/aroxu/unifi-traffic-monitr/agent/internal/config"
	"github.com/aroxu/unifi-traffic-monitr/agent/internal/ctsource"
	"github.com/aroxu/unifi-traffic-monitr/agent/internal/netinfo"
	"github.com/aroxu/unifi-traffic-monitr/agent/internal/protocol"
	"github.com/aroxu/unifi-traffic-monitr/agent/internal/server"
	"github.com/aroxu/unifi-traffic-monitr/agent/internal/store"
)

const (
	neighborInterval   = 5 * time.Second
	topologyInterval   = 30 * time.Second
	checkpointInterval = time.Minute
	partialInterval    = 30 * time.Second
	statsInterval      = 5 * time.Minute
	// closeGrace allows hardware offload to sync counters past a boundary.
	closeGrace = 2 * time.Second
	// forceClose finalises buckets even when dumps keep failing.
	forceClose = time.Minute
)

type stats struct {
	dumps, dumpErrors, destroys, eventErrors, finals uint64
	dumpTime, maxDump                                time.Duration
}

type Agent struct {
	cfg      config.Config
	store    *store.Store
	hub      *server.Hub
	view     *netinfo.View
	tracker  *account.Tracker
	acc      *account.Accumulator
	live     map[string]*account.Counters
	lastDump time.Time
	lastLive time.Time
	stats    stats
	events   chan error
}

func randomID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func waitTopology(ctx context.Context, patterns []string) (netinfo.Topology, error) {
	for {
		topo, err := netinfo.LoadTopology(patterns)
		if err == nil {
			return topo, nil
		}
		log.Printf("network not ready: %v; retrying", err)
		select {
		case <-ctx.Done():
			return topo, ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
}

// Run blocks until ctx ends.
func Run(ctx context.Context, cfg config.Config, version string) error {
	if err := ctsource.CheckAccounting(); err != nil {
		return err
	}
	st, err := store.Open(cfg.DataDir, cfg.Retention)
	if err != nil {
		return fmt.Errorf("open ledger: %w", err)
	}
	id, err := st.AgentID(randomID)
	if err != nil {
		return err
	}
	topo, err := waitTopology(ctx, cfg.ClientInterfaces)
	if err != nil {
		return nil
	}
	neigh, err := netinfo.LoadNeighbors(cfg.ClientInterfaces)
	if err != nil {
		log.Printf("read neighbours: %v", err)
	}
	log.Printf("client interfaces %v, WAN interfaces %v, %d client networks", topo.ClientLinks, topo.WANLinks, len(topo.ClientPrefixes))
	a := &Agent{cfg: cfg, store: st, hub: server.NewHub(), view: netinfo.NewView(topo, neigh),
		tracker: account.NewTracker(), acc: account.NewAccumulator(), live: map[string]*account.Counters{},
		events: make(chan error, 16)}
	a.restore(time.Now())
	dumper, err := ctsource.OpenDumper()
	if err != nil {
		return err
	}
	defer dumper.Close()
	destroyed := make(chan account.Flow, 16384)
	go ctsource.ListenDestroy(ctx, destroyed, func(err error) {
		select {
		case a.events <- err:
		default:
		}
	})
	srv := server.New(ctx, cfg.Token, st, a.hub, server.Info{AgentID: id, Version: version})
	go srv.Serve(ctx, cfg.Listen, cfg.CertFile(), cfg.KeyFile())
	a.loop(ctx, dumper, destroyed)
	srv.Wait(3 * time.Second)
	return nil
}

func (a *Agent) restore(now time.Time) {
	last, err := a.store.LastFinal()
	if err != nil {
		log.Printf("read last bucket: %v", err)
	}
	if last != nil {
		a.acc.SetClosedThrough(last.Add(account.BucketSize))
	}
	open, err := a.store.LoadOpen()
	if err != nil {
		log.Printf("read checkpoint: %v", err)
	}
	sort.Slice(open, func(i, j int) bool { return open[i].Start.Before(open[j].Start) })
	for _, rec := range open {
		if last != nil && !rec.Start.After(*last) {
			continue
		}
		if !rec.Start.Add(account.BucketSize).After(now) {
			rec.Final = true
			if err := a.store.AppendFinal(rec); err != nil {
				log.Printf("store restored bucket: %v", err)
			}
			a.acc.SetClosedThrough(rec.Start.Add(account.BucketSize))
			continue
		}
		a.acc.Restore(rec.ToAccount())
	}
}

func (a *Agent) interval() time.Duration {
	if a.hub.Count() > 0 {
		return a.cfg.LiveInterval
	}
	return a.cfg.IdleInterval
}

func (a *Agent) loop(ctx context.Context, dumper *ctsource.Dumper, destroyed <-chan account.Flow) {
	dumpTimer := time.NewTimer(0)
	defer dumpTimer.Stop()
	tickers := map[string]*time.Ticker{
		"neighbor": time.NewTicker(neighborInterval), "topology": time.NewTicker(topologyInterval),
		"checkpoint": time.NewTicker(checkpointInterval), "partial": time.NewTicker(partialInterval),
		"prune": time.NewTicker(time.Hour), "stats": time.NewTicker(statsInterval),
	}
	for _, t := range tickers {
		defer t.Stop()
	}
	var flows []account.Flow
	var err error
	for {
		select {
		case <-ctx.Done():
			a.checkpoint()
			return
		case f := <-destroyed:
			a.destroy(f, time.Now())
		case err := <-a.events:
			a.stats.eventErrors++
			if a.stats.eventErrors <= 5 || a.stats.eventErrors%100 == 0 {
				log.Printf("conntrack event subscription restarted (%d): %v", a.stats.eventErrors, err)
			}
		case <-dumpTimer.C:
			a.drain(destroyed)
			started := time.Now()
			flows, err = dumper.Dump(flows)
			elapsed := time.Since(started)
			if err != nil {
				a.stats.dumpErrors++
				if a.stats.dumpErrors <= 5 || a.stats.dumpErrors%100 == 0 {
					log.Printf("conntrack dump failed (%d): %v", a.stats.dumpErrors, err)
				}
			} else {
				a.stats.dumps++
				a.stats.dumpTime += elapsed
				if elapsed > a.stats.maxDump {
					a.stats.maxDump = elapsed
				}
				a.dump(flows, time.Now())
			}
			dumpTimer.Reset(a.interval())
		case <-a.hub.Ready():
			a.broadcastPartial(time.Now())
			dumpTimer.Reset(0)
		case <-tickers["neighbor"].C:
			neigh, err := netinfo.LoadNeighbors(a.cfg.ClientInterfaces)
			if err != nil {
				log.Printf("read neighbours: %v", err)
				continue
			}
			a.view.SetNeighbors(neigh)
			a.acc.Touch(neigh.MACs, time.Now())
		case <-tickers["topology"].C:
			topo, err := netinfo.LoadTopology(a.cfg.ClientInterfaces)
			if err != nil {
				log.Printf("read topology: %v", err)
				continue
			}
			a.view.SetTopology(topo)
		case <-tickers["checkpoint"].C:
			a.closeBuckets(time.Now().Add(-forceClose))
			a.checkpoint()
		case <-tickers["partial"].C:
			if a.hub.Count() > 0 {
				a.broadcastPartial(time.Now())
			}
		case <-tickers["prune"].C:
			if n, err := a.store.Prune(time.Now()); err != nil {
				log.Printf("prune ledger: %v", err)
			} else if n > 0 {
				log.Printf("removed %d expired ledger files", n)
			}
		case <-tickers["stats"].C:
			avg := time.Duration(0)
			if a.stats.dumps > 0 {
				avg = a.stats.dumpTime / time.Duration(a.stats.dumps)
			}
			log.Printf("stats: flows=%d dumps=%d dump_errors=%d avg_dump=%s max_dump=%s destroys=%d event_restarts=%d missed=%d final_buckets=%d consumers=%d",
				a.tracker.Tracked(), a.stats.dumps, a.stats.dumpErrors, avg.Round(time.Microsecond), a.stats.maxDump.Round(time.Microsecond),
				a.stats.destroys, a.stats.eventErrors, a.tracker.Missed, a.stats.finals, a.hub.Count())
			a.stats.dumps, a.stats.dumpTime, a.stats.maxDump = 0, 0, 0
		}
	}
}

func (a *Agent) drain(destroyed <-chan account.Flow) {
	for {
		select {
		case f := <-destroyed:
			a.destroy(f, time.Now())
		default:
			return
		}
	}
}

func (a *Agent) attribute(d account.Delta, from, to time.Time) {
	collectLive := a.hub.Count() > 0
	for _, att := range a.view.Classify(d.Flow) {
		up, down := att.UpDown(d)
		a.acc.Add(att.Subject, att.Scope, up, down, from, to)
		if collectLive {
			c := a.live[att.Subject]
			if c == nil {
				c = &account.Counters{}
				a.live[att.Subject] = c
			}
			c.Add(att.Scope, up, down)
		}
	}
}

func (a *Agent) destroy(f account.Flow, now time.Time) {
	a.stats.destroys++
	d, ok := a.tracker.Destroy(f)
	if !ok {
		return
	}
	from := a.lastDump
	if from.IsZero() || from.After(now) {
		from = now
	}
	a.attribute(d, from, now)
}

func (a *Agent) dump(flows []account.Flow, now time.Time) {
	if !a.lastDump.IsZero() && now.Before(a.lastDump.Add(-time.Minute)) {
		log.Printf("system clock moved backwards; finalising open buckets and starting a new baseline")
		a.finalize(a.acc.CloseAll())
		a.acc = account.NewAccumulator()
		a.tracker.Reset()
		a.lastDump = time.Time{}
	}
	baselined := a.tracker.Baselined()
	deltas := a.tracker.Dump(flows, now)
	from := a.lastDump
	if baselined && !from.IsZero() {
		a.acc.Cover(from, now)
	} else {
		from = now
	}
	for _, d := range deltas {
		a.attribute(d, from, now)
	}
	a.lastDump = now
	a.closeBuckets(now.Add(-closeGrace))
	a.emitLive(now)
}

func (a *Agent) closeBuckets(before time.Time) {
	a.finalize(a.acc.CloseBefore(before))
}

func (a *Agent) finalize(buckets []*account.Bucket) {
	for _, b := range buckets {
		rec := protocol.FromAccount(b, true)
		if err := a.store.AppendFinal(rec); err != nil {
			log.Printf("store bucket %s: %v", rec.Start.Format(time.RFC3339), err)
		}
		a.stats.finals++
		a.broadcast(protocol.BucketUpdate{Type: "bucket", Bucket: rec})
	}
}

func (a *Agent) broadcast(v any) {
	if a.hub.Count() == 0 {
		return
	}
	b, err := json.Marshal(v)
	if err != nil {
		log.Printf("encode message: %v", err)
		return
	}
	a.hub.Broadcast(b)
}

func (a *Agent) broadcastPartial(now time.Time) {
	for _, b := range a.acc.Snapshot() {
		if b.Start.After(now) {
			continue
		}
		a.broadcast(protocol.BucketUpdate{Type: "bucket", Bucket: protocol.FromAccount(b, false)})
	}
}

func (a *Agent) emitLive(now time.Time) {
	if a.hub.Count() == 0 || a.lastLive.IsZero() {
		a.live = map[string]*account.Counters{}
		a.lastLive = now
		return
	}
	msg := protocol.Live{Type: "live", At: now.UTC(), IntervalMs: now.Sub(a.lastLive).Milliseconds(),
		Subjects: make([]protocol.LiveSubject, 0, len(a.live))}
	for name, c := range a.live {
		if c.Zero() {
			continue
		}
		msg.Subjects = append(msg.Subjects, protocol.LiveSubject{MAC: name,
			Internet: protocol.LivePair{Up: c.InternetUp, Down: c.InternetDown},
			LAN:      protocol.LivePair{Up: c.LANUp, Down: c.LANDown}})
	}
	sort.Slice(msg.Subjects, func(i, j int) bool { return msg.Subjects[i].MAC < msg.Subjects[j].MAC })
	a.broadcast(msg)
	a.live = map[string]*account.Counters{}
	a.lastLive = now
}

func (a *Agent) checkpoint() {
	open := a.acc.Snapshot()
	recs := make([]protocol.Bucket, 0, len(open))
	for _, b := range open {
		recs = append(recs, protocol.FromAccount(b, false))
	}
	if err := a.store.SaveOpen(recs); err != nil {
		log.Printf("save checkpoint: %v", err)
	}
}
