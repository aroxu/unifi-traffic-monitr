package store

import (
	"testing"
	"time"

	"github.com/aroxu/unifi-traffic-monitr/agent/internal/protocol"
)

func final(start time.Time, down uint64) protocol.Bucket {
	return protocol.Bucket{Start: start, Final: true, CoverageSeconds: 300,
		Subjects: []protocol.Subject{{MAC: "aa:bb:cc:dd:ee:ff", Internet: protocol.Pair{Down: protocol.U64(down)}}}}
}

func TestReplayOrderReplaceAndWindow(t *testing.T) {
	t0 := time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)
	m := NewMemory(time.Hour)
	m.AppendFinal(final(t0.Add(10*time.Minute), 1))
	m.AppendFinal(final(t0, 2))
	m.AppendFinal(final(t0.Add(5*time.Minute), 3))
	m.AppendFinal(final(t0.Add(5*time.Minute), 4)) // same start replaces
	var got []uint64
	since := t0
	if err := m.Replay(&since, func(b protocol.Bucket) error {
		got = append(got, uint64(b.Subjects[0].Internet.Down))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != 4 || got[1] != 1 {
		t.Fatalf("unexpected replay %v", got)
	}
	if e := m.Earliest(); e == nil || !e.Equal(t0) {
		t.Fatalf("unexpected earliest %v", e)
	}
	m.AppendFinal(final(t0.Add(65*time.Minute), 5))
	if e := m.Earliest(); e == nil || !e.Equal(t0.Add(5*time.Minute)) || m.Len() != 3 {
		t.Fatalf("window not applied: earliest %v len %d", e, m.Len())
	}
}
