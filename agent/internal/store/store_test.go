package store

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aroxu/unifi-traffic-monitr/agent/internal/protocol"
)

func bucket(start time.Time) protocol.Bucket {
	return protocol.Bucket{Start: start, Final: true, CoverageSeconds: 300,
		Subjects: []protocol.Subject{{MAC: "aa:bb:cc:dd:ee:ff", Internet: protocol.Pair{Up: 1, Down: 1 << 60}}}}
}

func TestAppendReplayAndPrune(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, 7*24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	day1 := time.Date(2026, 9, 20, 23, 55, 0, 0, time.UTC)
	for _, start := range []time.Time{day1, day1.Add(5 * time.Minute), day1.Add(10 * time.Minute)} {
		if err := s.AppendFinal(bucket(start)); err != nil {
			t.Fatal(err)
		}
	}
	// Duplicate and damaged lines must not be replayed.
	if err := s.AppendFinal(bucket(day1.Add(10 * time.Minute))); err != nil {
		t.Fatal(err)
	}
	f, _ := os.OpenFile(filepath.Join(dir, "buckets", "2026-09-21.jsonl"), os.O_APPEND|os.O_WRONLY, 0o600)
	f.WriteString("{\"start\":\"2026-09-21T00:1")
	f.Close()
	var got []time.Time
	since := day1
	if err := s.Replay(&since, func(b protocol.Bucket) error {
		got = append(got, b.Start)
		if b.Subjects[0].Internet.Down != 1<<60 {
			t.Fatalf("large counter changed: %d", b.Subjects[0].Internet.Down)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || !got[0].Equal(day1.Add(5*time.Minute)) {
		t.Fatalf("unexpected replay %v", got)
	}
	earliest, _ := s.Earliest()
	last, _ := s.LastFinal()
	if earliest == nil || !earliest.Equal(day1) || last == nil || !last.Equal(day1.Add(10*time.Minute)) {
		t.Fatalf("unexpected bounds %v %v", earliest, last)
	}
	removed, err := s.Prune(day1.Add(8 * 24 * time.Hour))
	if err != nil || removed != 1 {
		t.Fatalf("prune removed %d: %v", removed, err)
	}
}

func TestOpenCheckpointAndAgentID(t *testing.T) {
	s, _ := Open(t.TempDir(), time.Hour)
	b := bucket(time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC))
	b.Final = false
	if err := s.SaveOpen([]protocol.Bucket{b}); err != nil {
		t.Fatal(err)
	}
	loaded, err := s.LoadOpen()
	if err != nil || len(loaded) != 1 || loaded[0].Subjects[0].Internet.Up != 1 {
		t.Fatalf("unexpected checkpoint %+v %v", loaded, err)
	}
	id1, _ := s.AgentID(func() (string, error) { return "first", nil })
	id2, _ := s.AgentID(func() (string, error) { return "second", nil })
	if id1 != "first" || id2 != "first" {
		t.Fatalf("agent id not stable: %s %s", id1, id2)
	}
}
