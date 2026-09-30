// Package store keeps final buckets and the open-bucket checkpoint on the
// gateway's persistent /data partition.
package store

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/aroxu/unifi-traffic-monitr/agent/internal/protocol"
)

const dayLayout = "2006-01-02"

// Store is safe for one writer and concurrent readers.
type Store struct {
	dir       string
	retention time.Duration
	mu        sync.Mutex
}

func Open(dataDir string, retention time.Duration) (*Store, error) {
	s := &Store{dir: dataDir, retention: retention}
	for _, d := range []string{s.bucketDir(), s.stateDir()} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func (s *Store) bucketDir() string { return filepath.Join(s.dir, "buckets") }
func (s *Store) stateDir() string  { return filepath.Join(s.dir, "state") }

func (s *Store) dayFiles() ([]string, error) {
	entries, err := os.ReadDir(s.bucketDir())
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		name := e.Name()
		if e.Type().IsRegular() && strings.HasSuffix(name, ".jsonl") {
			if _, err := time.Parse(dayLayout, strings.TrimSuffix(name, ".jsonl")); err == nil {
				names = append(names, name)
			}
		}
	}
	sort.Strings(names)
	return names, nil
}

// AppendFinal durably adds a final bucket.
func (s *Store) AppendFinal(b protocol.Bucket) error {
	if !b.Final {
		return errors.New("only final buckets are stored")
	}
	line, err := json.Marshal(b)
	if err != nil {
		return err
	}
	line = append(line, '\n')
	s.mu.Lock()
	defer s.mu.Unlock()
	name := filepath.Join(s.bucketDir(), b.Start.UTC().Format(dayLayout)+".jsonl")
	f, err := os.OpenFile(name, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(line); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func readDay(path string, fn func(protocol.Bucket) error) error {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var b protocol.Bucket
		// A line cut short by power loss is skipped.
		if json.Unmarshal(line, &b) != nil || !b.Final {
			continue
		}
		if err := fn(b); err != nil {
			return err
		}
	}
	return sc.Err()
}

// Replay calls fn for final buckets that start after since, in time order.
func (s *Store) Replay(since *time.Time, fn func(protocol.Bucket) error) error {
	names, err := s.dayFiles()
	if err != nil {
		return err
	}
	var last time.Time
	for _, name := range names {
		day, _ := time.Parse(dayLayout, strings.TrimSuffix(name, ".jsonl"))
		if since != nil && !day.Add(24*time.Hour).After(*since) {
			continue
		}
		err := readDay(filepath.Join(s.bucketDir(), name), func(b protocol.Bucket) error {
			if since != nil && !b.Start.After(*since) {
				return nil
			}
			// Skip duplicates if a bucket was appended twice.
			if !b.Start.After(last) {
				return nil
			}
			last = b.Start
			return fn(b)
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// Earliest returns the start of the oldest stored bucket.
func (s *Store) Earliest() (*time.Time, error) {
	names, err := s.dayFiles()
	if err != nil {
		return nil, err
	}
	for _, name := range names {
		var found *time.Time
		stop := errors.New("stop")
		err := readDay(filepath.Join(s.bucketDir(), name), func(b protocol.Bucket) error {
			t := b.Start
			found = &t
			return stop
		})
		if err != nil && !errors.Is(err, stop) {
			return nil, err
		}
		if found != nil {
			return found, nil
		}
	}
	return nil, nil
}

// LastFinal returns the start of the newest stored bucket.
func (s *Store) LastFinal() (*time.Time, error) {
	names, err := s.dayFiles()
	if err != nil {
		return nil, err
	}
	for i := len(names) - 1; i >= 0; i-- {
		var found *time.Time
		err := readDay(filepath.Join(s.bucketDir(), names[i]), func(b protocol.Bucket) error {
			if found == nil || b.Start.After(*found) {
				t := b.Start
				found = &t
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
		if found != nil {
			return found, nil
		}
	}
	return nil, nil
}

// Prune removes day files older than the retention period.
func (s *Store) Prune(now time.Time) (int, error) {
	names, err := s.dayFiles()
	if err != nil {
		return 0, err
	}
	cutoff := now.Add(-s.retention)
	removed := 0
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, name := range names {
		day, _ := time.Parse(dayLayout, strings.TrimSuffix(name, ".jsonl"))
		if day.Add(24 * time.Hour).Before(cutoff) {
			if err := os.Remove(filepath.Join(s.bucketDir(), name)); err != nil {
				return removed, err
			}
			removed++
		}
	}
	return removed, nil
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (s *Store) openPath() string { return filepath.Join(s.stateDir(), "open-buckets.json") }

// SaveOpen checkpoints the open buckets so a restart keeps partial counts.
func (s *Store) SaveOpen(buckets []protocol.Bucket) error {
	data, err := json.Marshal(buckets)
	if err != nil {
		return err
	}
	return writeAtomic(s.openPath(), data, 0o600)
}

// LoadOpen reads the last checkpoint. A missing or damaged file is empty.
func (s *Store) LoadOpen() ([]protocol.Bucket, error) {
	data, err := os.ReadFile(s.openPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []protocol.Bucket
	if json.Unmarshal(data, &out) != nil {
		return nil, nil
	}
	return out, nil
}

// AgentID returns a stable random identifier created on first use.
func (s *Store) AgentID(generate func() (string, error)) (string, error) {
	path := filepath.Join(s.stateDir(), "agent-id")
	data, err := os.ReadFile(path)
	if err == nil && len(bytes.TrimSpace(data)) > 0 {
		return string(bytes.TrimSpace(data)), nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	id, err := generate()
	if err != nil {
		return "", err
	}
	if err := writeAtomic(path, []byte(id+"\n"), 0o600); err != nil {
		return "", fmt.Errorf("save agent id: %w", err)
	}
	return id, nil
}
