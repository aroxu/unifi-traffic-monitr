package account

import (
	"net/netip"
	"testing"
	"time"
)

var t0 = time.Date(2026, 9, 30, 3, 0, 0, 0, time.UTC)

func flow(id uint32, orig, reply uint64) Flow {
	src := netip.MustParseAddr("10.0.0.10")
	dst := netip.MustParseAddr("1.1.1.1")
	return Flow{Key: FlowKey{ID: id, Proto: 6, Src: src, Dst: dst, SPort: 1000, DPort: 443},
		OrigSrc: src, ReplySrc: dst, OrigBytes: orig, ReplyBytes: reply}
}

func TestSplitPreservesTotalAcrossBoundary(t *testing.T) {
	parts := Split(101, t0.Add(-30*time.Second), t0.Add(30*time.Second))
	if len(parts) != 2 || parts[0].Bytes+parts[1].Bytes != 101 {
		t.Fatalf("unexpected parts %+v", parts)
	}
	if !parts[0].Start.Equal(t0.Add(-BucketSize)) || !parts[1].Start.Equal(t0) {
		t.Fatalf("unexpected bucket starts %+v", parts)
	}
	huge := uint64(1) << 62
	sum := uint64(0)
	for _, p := range Split(huge, t0, t0.Add(17*time.Minute)) {
		sum += p.Bytes
	}
	if sum != huge {
		t.Fatalf("large split lost bytes: %d", sum)
	}
	if p := Split(7, t0, t0); len(p) != 1 || p[0].Bytes != 7 || !p[0].Start.Equal(t0) {
		t.Fatalf("instant split %+v", p)
	}
}

func TestTrackerBaselineDeltaAndDestroy(t *testing.T) {
	tr := NewTracker()
	if d := tr.Dump([]Flow{flow(1, 100, 1000)}, t0); len(d) != 0 {
		t.Fatalf("baseline produced deltas: %+v", d)
	}
	d := tr.Dump([]Flow{flow(1, 150, 1600), flow(2, 10, 20)}, t0.Add(time.Second))
	if len(d) != 2 || d[0].OrigBytes != 50 || d[0].ReplyBytes != 600 || d[1].OrigBytes != 10 {
		t.Fatalf("unexpected deltas %+v", d)
	}
	final, ok := tr.Destroy(flow(1, 170, 1700))
	if !ok || final.OrigBytes != 20 || final.ReplyBytes != 100 {
		t.Fatalf("unexpected destroy delta %+v", final)
	}
	short, ok := tr.Destroy(flow(9, 5, 6))
	if !ok || short.OrigBytes != 5 || short.ReplyBytes != 6 {
		t.Fatalf("short flow not counted: %+v", short)
	}
}

func TestTrackerTombstoneAndReuse(t *testing.T) {
	tr := NewTracker()
	tr.Dump([]Flow{flow(1, 100, 100)}, t0)
	tr.Dump(nil, t0.Add(time.Second))
	tr.Dump(nil, t0.Add(2*time.Second))
	if tr.Tracked() != 0 {
		t.Fatal("missing flow was not moved to a tombstone")
	}
	late, ok := tr.Destroy(flow(1, 130, 110))
	if !ok || late.OrigBytes != 30 || late.ReplyBytes != 10 {
		t.Fatalf("late destroy did not use tombstone: %+v", late)
	}
	tr.Dump([]Flow{flow(3, 500, 500)}, t0.Add(3*time.Second))
	reused := tr.Dump([]Flow{flow(3, 40, 60)}, t0.Add(4*time.Second))
	if len(reused) != 1 || reused[0].OrigBytes != 40 || reused[0].ReplyBytes != 60 {
		t.Fatalf("reused key not treated as new flow: %+v", reused)
	}
	tr.Dump(nil, t0.Add(5*time.Second))
	tr.Dump(nil, t0.Add(6*time.Second))
	tr.Dump(nil, t0.Add(2*time.Minute))
	if tr.Missed != 1 {
		t.Fatalf("expired tombstone not counted as missed: %d", tr.Missed)
	}
}

func TestAccumulatorCoverageCloseAndLateBytes(t *testing.T) {
	acc := NewAccumulator()
	acc.Cover(t0.Add(-10*time.Second), t0.Add(10*time.Second))
	acc.Add("aa", Internet, 20, 40, t0.Add(-10*time.Second), t0.Add(10*time.Second))
	acc.Touch([]string{"bb"}, t0.Add(time.Second))
	closed := acc.CloseBefore(t0.Add(2 * time.Second))
	if len(closed) != 1 || closed[0].Coverage != 10*time.Second {
		t.Fatalf("unexpected closed buckets %+v", closed)
	}
	if c := closed[0].Subjects["aa"]; c.InternetUp != 10 || c.InternetDown != 20 {
		t.Fatalf("unexpected first bucket counters %+v", c)
	}
	acc.Add("aa", LAN, 5, 0, t0.Add(-20*time.Second), t0.Add(-10*time.Second))
	open := acc.Snapshot()
	if len(open) != 1 || !open[0].Start.Equal(t0) {
		t.Fatalf("late bytes created a closed bucket: %+v", open)
	}
	if c := open[0].Subjects["aa"]; c.LANUp != 5 || c.InternetUp != 10 {
		t.Fatalf("late bytes not moved to open bucket: %+v", c)
	}
	if _, ok := open[0].Subjects["bb"]; !ok {
		t.Fatal("touched subject missing")
	}
}
