// Package protocol defines the agent's WebSocket messages and ledger records.
package protocol

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/aroxu/unifi-traffic-monitr/agent/internal/account"
)

// Version is the protocol version announced in hello.
const Version = 1

// U64 is encoded as a decimal string so JavaScript clients keep full precision.
type U64 uint64

func (v U64) MarshalJSON() ([]byte, error) {
	return []byte(strconv.Quote(strconv.FormatUint(uint64(v), 10))), nil
}

func (v *U64) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid byte count: %w", err)
	}
	*v = U64(n)
	return nil
}

type Pair struct {
	Up   U64 `json:"up"`
	Down U64 `json:"down"`
}

type Subject struct {
	MAC      string `json:"mac"`
	Internet Pair   `json:"internet"`
	LAN      Pair   `json:"lan"`
}

// Bucket is one five-minute ledger entry. Final buckets never change.
type Bucket struct {
	Start           time.Time `json:"start"`
	Final           bool      `json:"final"`
	CoverageSeconds int       `json:"coverageSeconds"`
	Subjects        []Subject `json:"subjects"`
}

// FromAccount converts an accumulator bucket to its wire form.
func FromAccount(b *account.Bucket, final bool) Bucket {
	out := Bucket{Start: b.Start.UTC(), Final: final, Subjects: make([]Subject, 0, len(b.Subjects))}
	cov := b.Coverage.Round(time.Second) / time.Second
	if cov > 300 {
		cov = 300
	}
	out.CoverageSeconds = int(cov)
	for name, c := range b.Subjects {
		out.Subjects = append(out.Subjects, Subject{MAC: name,
			Internet: Pair{Up: U64(c.InternetUp), Down: U64(c.InternetDown)},
			LAN:      Pair{Up: U64(c.LANUp), Down: U64(c.LANDown)}})
	}
	sort.Slice(out.Subjects, func(i, j int) bool { return out.Subjects[i].MAC < out.Subjects[j].MAC })
	return out
}

// ToAccount converts a stored bucket back into accumulator form.
func (b Bucket) ToAccount() *account.Bucket {
	out := &account.Bucket{Start: b.Start.UTC(), Coverage: time.Duration(b.CoverageSeconds) * time.Second,
		Subjects: make(map[string]*account.Counters, len(b.Subjects))}
	for _, s := range b.Subjects {
		out.Subjects[s.MAC] = &account.Counters{InternetUp: uint64(s.Internet.Up), InternetDown: uint64(s.Internet.Down),
			LANUp: uint64(s.LAN.Up), LANDown: uint64(s.LAN.Down)}
	}
	return out
}

type Hello struct {
	Type           string     `json:"type"`
	Protocol       int        `json:"protocol"`
	AgentID        string     `json:"agentId"`
	Version        string     `json:"version"`
	Now            time.Time  `json:"now"`
	EarliestBucket *time.Time `json:"earliestBucket"`
}

type Resume struct {
	Type  string     `json:"type"`
	Since *time.Time `json:"since"`
}

type Buckets struct {
	Type  string   `json:"type"`
	Items []Bucket `json:"items"`
}

type ReplayDone struct {
	Type    string     `json:"type"`
	Through *time.Time `json:"through"`
}

type BucketUpdate struct {
	Type   string `json:"type"`
	Bucket Bucket `json:"bucket"`
}

type LivePair struct {
	Up   uint64 `json:"up"`
	Down uint64 `json:"down"`
}

type LiveSubject struct {
	MAC      string   `json:"mac"`
	Internet LivePair `json:"internet"`
	LAN      LivePair `json:"lan"`
}

// Live carries the bytes moved since the previous live message.
type Live struct {
	Type       string        `json:"type"`
	At         time.Time     `json:"at"`
	IntervalMs int64         `json:"intervalMs"`
	Subjects   []LiveSubject `json:"subjects"`
}
