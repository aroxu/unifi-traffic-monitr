package agent

import (
	"strings"
	"testing"
	"time"

	"github.com/aroxu/unifi-traffic-monitr/agent/internal/account"
)

func TestAccountingSpanUsesElapsedTimeAndWallClockEnd(t *testing.T) {
	prev := time.Now()
	now := prev.Add(1500 * time.Millisecond) // keeps the monotonic reading
	from, to := accountingSpan(prev, now)
	if !to.Equal(now.Round(0)) || to.Sub(from) != 1500*time.Millisecond {
		t.Fatalf("span %s..%s, want 1.5s ending at %s", from, to, now.Round(0))
	}
	// Bucket arithmetic must not see monotonic readings, or a clock step
	// between two dumps would scale the bytes.
	if strings.Contains(from.String(), "m=") || strings.Contains(to.String(), "m=") {
		t.Fatalf("span keeps a monotonic reading: %s, %s", from, to)
	}

	if from, to := accountingSpan(time.Time{}, now); !from.Equal(to) || !to.Equal(now.Round(0)) {
		t.Fatalf("first dump span %s..%s, want empty at %s", from, to, now.Round(0))
	}

	// Readings without a monotonic part fall back to the wall clock. Time
	// that runs backwards gives an empty span instead of a negative one.
	t0 := time.Date(2026, 10, 6, 3, 0, 0, 0, time.UTC)
	if from, to := accountingSpan(t0.Add(time.Minute), t0); !from.Equal(t0) || !to.Equal(t0) {
		t.Fatalf("backward span %s..%s", from, to)
	}
}

func TestSpanAfterClockStepKeepsBytesInCorrectedBucket(t *testing.T) {
	// The previous dump ran at 03:00:00 by the old clock. One second later the
	// clock was corrected to 03:10:01. The second of traffic belongs right
	// before 03:10:01 and must not be spread over the skipped ten minutes.
	corrected := time.Date(2026, 10, 6, 3, 10, 1, 0, time.UTC)
	from, to := corrected.Add(-time.Second), corrected
	parts := account.Split(1000, from, to)
	if len(parts) != 1 || parts[0].Bytes != 1000 || !parts[0].Start.Equal(time.Date(2026, 10, 6, 3, 10, 0, 0, time.UTC)) {
		t.Fatalf("parts %+v", parts)
	}
	acc := account.NewAccumulator()
	acc.Cover(from, to)
	snap := acc.Snapshot()
	if len(snap) != 1 || snap[0].Coverage != time.Second {
		t.Fatalf("coverage %+v", snap)
	}
}
