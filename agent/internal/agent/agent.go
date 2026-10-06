// Package agent runs the accounting loop.
package agent

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
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
	neighborInterval = 5 * time.Second
	topologyInterval = 30 * time.Second
	closeInterval    = time.Minute
	partialInterval  = 30 * time.Second
	statsInterval    = time.Hour
	// closeGrace allows hardware offload to sync counters past a boundary.
	closeGrace = 2 * time.Second
	// forceClose finalises buckets even when dumps keep failing.
	forceClose = time.Minute
	// clockStepLimit is the difference between wall and monotonic elapsed
	// time above which the system clock is reported as stepped.
	clockStepLimit = 2 * time.Second
)

type stats struct {
	dumps, dumpErrors, destroys, eventErrors, finals uint64
	dumpTime, maxDump                                time.Duration
}

type Agent struct {
	cfg     config.Config
	ledger  *store.Memory
	hub     *server.Hub
	view    *netinfo.View
	tracker *account.Tracker
	acc     *account.Accumulator
	live    map[string]*account.Counters
	// lastDump keeps its monotonic clock reading, so time since the previous
	// dump is measured even if the wall clock is stepped.
	lastDump   time.Time
	lastLive   time.Time
	clockSteps uint64
	stats      stats
	events     chan error
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

// agentID reads the ID created by manage.sh install. The agent never writes
// it, so a missing file gives an ID that lasts for this run only.
func agentID(dataDir string) (string, error) {
	data, err := os.ReadFile(filepath.Join(dataDir, "state", "agent-id"))
	if id := string(bytes.TrimSpace(data)); err == nil && id != "" {
		return id, nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("read agent id: %w", err)
	}
	id, err := randomID()
	if err != nil {
		return "", err
	}
	log.Printf("state/agent-id is missing; using a temporary agent ID for this run (run manage.sh install to create one)")
	return id, nil
}

// Run blocks until ctx ends. Traffic data stays in memory; the agent only
// reads configuration from disk.
func Run(ctx context.Context, cfg config.Config, version string) error {
	if err := ctsource.CheckAccounting(); err != nil {
		return err
	}
	id, err := agentID(cfg.DataDir)
	if err != nil {
		return err
	}
	runID, err := randomID()
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
	log.Printf("client interfaces %v, WAN interfaces %v, %d client networks; buffering %s of buckets in memory",
		topo.ClientLinks, topo.WANLinks, len(topo.ClientPrefixes), cfg.BufferWindow)
	a := &Agent{cfg: cfg, ledger: store.NewMemory(cfg.BufferWindow), hub: server.NewHub(), view: netinfo.NewView(topo, neigh),
		tracker: account.NewTracker(), acc: account.NewAccumulator(), live: map[string]*account.Counters{},
		events: make(chan error, 16)}
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
	// The server outlives ctx briefly so the last partial buckets reach
	// connected collectors before the streams close.
	srvCtx, srvCancel := context.WithCancel(context.Background())
	defer srvCancel()
	srv := server.New(srvCtx, cfg.Token, a.ledger, a.hub, server.Info{AgentID: id, RunID: runID, Version: version})
	go srv.Serve(srvCtx, cfg.Listen, cfg.CertFile(), cfg.KeyFile())
	a.loop(ctx, dumper, destroyed)
	a.shutdown(dumper, destroyed)
	srvCancel()
	srv.Wait(3 * time.Second)
	return nil
}

// shutdown counts traffic since the last dump and sends the open buckets as
// partial values. Collectors keep them; the next run starts from zero.
func (a *Agent) shutdown(dumper *ctsource.Dumper, destroyed <-chan account.Flow) {
	a.drain(destroyed)
	if flows, err := dumper.Dump(nil); err == nil {
		a.dump(flows, time.Now())
	} else {
		log.Printf("final conntrack dump failed: %v", err)
	}
	a.broadcastPartial(time.Now())
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
		"close": time.NewTicker(closeInterval), "partial": time.NewTicker(partialInterval),
		"stats": time.NewTicker(statsInterval),
	}
	for _, t := range tickers {
		defer t.Stop()
	}
	var flows []account.Flow
	var err error
	for {
		select {
		case <-ctx.Done():
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
		case <-tickers["close"].C:
			a.closeBuckets(time.Now().Add(-forceClose))
		case <-tickers["partial"].C:
			if a.hub.Count() > 0 {
				a.broadcastPartial(time.Now())
			}
		case <-tickers["stats"].C:
			avg := time.Duration(0)
			if a.stats.dumps > 0 {
				avg = a.stats.dumpTime / time.Duration(a.stats.dumps)
			}
			log.Printf("stats: flows=%d dumps=%d dump_errors=%d avg_dump=%s max_dump=%s destroys=%d event_restarts=%d missed=%d final_buckets=%d buffered=%d consumers=%d",
				a.tracker.Tracked(), a.stats.dumps, a.stats.dumpErrors, avg.Round(time.Microsecond), a.stats.maxDump.Round(time.Microsecond),
				a.stats.destroys, a.stats.eventErrors, a.tracker.Missed, a.stats.finals, a.ledger.Len(), a.hub.Count())
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
	from, to := accountingSpan(a.lastDump, now)
	a.attribute(d, from, to)
}

// accountingSpan returns the wall clock interval that the time since prev
// covers. It ends at the current wall time and lasts as long as the monotonic
// clock measured, so a wall clock step (NTP, a manual change) neither
// stretches nor shrinks the interval. A zero prev gives an empty interval.
func accountingSpan(prev, now time.Time) (from, to time.Time) {
	to = now.Round(0)
	if prev.IsZero() {
		return to, to
	}
	return to.Add(-max(now.Sub(prev), 0)), to
}

// noteClockStep logs when the wall clock moved by a different amount than
// the monotonic clock since the previous dump.
func (a *Agent) noteClockStep(now time.Time) {
	if a.lastDump.IsZero() {
		return
	}
	step := now.Round(0).Sub(a.lastDump.Round(0)) - now.Sub(a.lastDump)
	if step < clockStepLimit && step > -clockStepLimit {
		return
	}
	a.clockSteps++
	if a.clockSteps <= 5 || a.clockSteps%100 == 0 {
		log.Printf("system clock stepped by %s; traffic is placed at the corrected time (%d steps)", step.Round(time.Millisecond), a.clockSteps)
	}
}

func (a *Agent) dump(flows []account.Flow, now time.Time) {
	// After a backward step the corrected times fall before buckets that were
	// already sent as final. The accumulator then adds the bytes to its first
	// open bucket, so no final bucket is sent twice with different values.
	a.noteClockStep(now)
	baselined := a.tracker.Baselined()
	deltas := a.tracker.Dump(flows, now)
	from, to := accountingSpan(a.lastDump, now)
	if baselined && !a.lastDump.IsZero() {
		a.acc.Cover(from, to)
	} else {
		from = to
	}
	for _, d := range deltas {
		a.attribute(d, from, to)
	}
	a.lastDump = now
	a.closeBuckets(to.Add(-closeGrace))
	a.emitLive(now)
}

func (a *Agent) closeBuckets(before time.Time) {
	a.finalize(a.acc.CloseBefore(before))
}

func (a *Agent) finalize(buckets []*account.Bucket) {
	for _, b := range buckets {
		rec := protocol.FromAccount(b, true)
		a.ledger.AppendFinal(rec)
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
