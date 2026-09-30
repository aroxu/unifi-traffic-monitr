// Package store keeps recent final buckets in memory so a reconnecting
// collector can fill the time it missed. Nothing is written to disk; the
// buffer is lost when the agent restarts.
package store

import (
	"sort"
	"sync"
	"time"

	"github.com/aroxu/unifi-traffic-monitr/agent/internal/protocol"
)

// Memory is safe for one writer and concurrent readers.
type Memory struct {
	mu      sync.RWMutex
	window  time.Duration
	buckets []protocol.Bucket // sorted by start, one per start
}

// NewMemory keeps final buckets that start within window of the newest one.
func NewMemory(window time.Duration) *Memory { return &Memory{window: window} }

// AppendFinal adds or replaces a final bucket and drops expired ones.
func (m *Memory) AppendFinal(b protocol.Bucket) {
	m.mu.Lock()
	defer m.mu.Unlock()
	i := sort.Search(len(m.buckets), func(i int) bool { return !m.buckets[i].Start.Before(b.Start) })
	switch {
	case i < len(m.buckets) && m.buckets[i].Start.Equal(b.Start):
		m.buckets[i] = b
	case i == len(m.buckets):
		m.buckets = append(m.buckets, b)
	default:
		m.buckets = append(m.buckets, protocol.Bucket{})
		copy(m.buckets[i+1:], m.buckets[i:])
		m.buckets[i] = b
	}
	cutoff := m.buckets[len(m.buckets)-1].Start.Add(-m.window)
	drop := sort.Search(len(m.buckets), func(i int) bool { return !m.buckets[i].Start.Before(cutoff) })
	if drop > 0 {
		m.buckets = append(m.buckets[:0:0], m.buckets[drop:]...)
	}
}

// Replay calls fn for buffered buckets that start after since, in time order.
func (m *Memory) Replay(since *time.Time, fn func(protocol.Bucket) error) error {
	m.mu.RLock()
	start := 0
	if since != nil {
		start = sort.Search(len(m.buckets), func(i int) bool { return m.buckets[i].Start.After(*since) })
	}
	items := append([]protocol.Bucket(nil), m.buckets[start:]...)
	m.mu.RUnlock()
	for _, b := range items {
		if err := fn(b); err != nil {
			return err
		}
	}
	return nil
}

// Earliest returns the start of the oldest buffered bucket.
func (m *Memory) Earliest() *time.Time {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if len(m.buckets) == 0 {
		return nil
	}
	t := m.buckets[0].Start
	return &t
}

// Len returns the number of buffered buckets.
func (m *Memory) Len() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.buckets)
}
