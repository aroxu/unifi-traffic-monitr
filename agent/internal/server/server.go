// Package server exposes the agent's authenticated WebSocket stream.
package server

import (
	"context"
	"crypto/subtle"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/aroxu/unifi-traffic-monitr/agent/internal/protocol"
	"github.com/aroxu/unifi-traffic-monitr/agent/internal/store"
)

const (
	maxConnections = 4
	maxPending     = 4096
	sendQueue      = 512
	replayBatch    = 100
	failureLimit   = 5
	failureWindow  = time.Minute
	pingInterval   = 15 * time.Second
	pingTimeout    = 30 * time.Second
	resumeTimeout  = 10 * time.Second
	writeTimeout   = 15 * time.Second
)

type client struct {
	send      chan []byte
	pending   [][]byte
	replaying bool
	done      chan struct{}
	once      sync.Once
}

func (c *client) stop() { c.once.Do(func() { close(c.done) }) }

// Hub fans messages out to connected consumers.
type Hub struct {
	mu      sync.Mutex
	clients map[*client]struct{}
	ready   chan struct{}
}

func NewHub() *Hub { return &Hub{clients: map[*client]struct{}{}, ready: make(chan struct{}, 1)} }

// Count returns the number of authenticated consumers.
func (h *Hub) Count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients)
}

// Ready is signalled when a consumer has finished its replay.
func (h *Hub) Ready() <-chan struct{} { return h.ready }

// Broadcast queues msg for every consumer. A consumer that cannot keep up is
// disconnected; it resumes from its last stored bucket after reconnecting.
func (h *Hub) Broadcast(msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		if c.replaying {
			if len(c.pending) >= maxPending {
				c.stop()
				continue
			}
			c.pending = append(c.pending, msg)
			continue
		}
		select {
		case c.send <- msg:
		default:
			c.stop()
		}
	}
}

func (h *Hub) register() (*client, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.clients) >= maxConnections {
		return nil, false
	}
	c := &client{send: make(chan []byte, sendQueue), replaying: true, done: make(chan struct{})}
	h.clients[c] = struct{}{}
	return c, true
}

func (h *Hub) unregister(c *client) {
	h.mu.Lock()
	delete(h.clients, c)
	h.mu.Unlock()
	c.stop()
}

// takePending returns queued messages. When none are left the consumer
// switches to direct delivery.
func (h *Hub) takePending(c *client) [][]byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(c.pending) == 0 {
		c.replaying = false
		return nil
	}
	out := c.pending
	c.pending = nil
	return out
}

func (h *Hub) signalReady() {
	select {
	case h.ready <- struct{}{}:
	default:
	}
}

// Info identifies the agent in hello messages.
type Info struct {
	AgentID string
	Version string
}

// Server authenticates consumers and replays stored buckets.
type Server struct {
	token    []byte
	store    *store.Store
	hub      *Hub
	info     Info
	base     context.Context
	mu       sync.Mutex
	failures map[string][]time.Time
	streams  sync.WaitGroup
}

func New(base context.Context, token string, st *store.Store, hub *Hub, info Info) *Server {
	return &Server{token: []byte(token), store: st, hub: hub, info: info, base: base, failures: map[string][]time.Time{}}
}

// Handler serves /healthz and /v1/stream.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		io.WriteString(w, "ok\n")
	})
	mux.HandleFunc("GET /v1/stream", s.handleStream)
	return mux
}

func remoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *Server) limited(ip string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.failures) > 1024 {
		s.failures = map[string][]time.Time{}
	}
	recent := s.failures[ip][:0]
	for _, t := range s.failures[ip] {
		if now.Sub(t) < failureWindow {
			recent = append(recent, t)
		}
	}
	if len(recent) == 0 {
		delete(s.failures, ip)
	} else {
		s.failures[ip] = recent
	}
	return len(recent) >= failureLimit
}

func (s *Server) fail(ip string, now time.Time) {
	s.mu.Lock()
	s.failures[ip] = append(s.failures[ip], now)
	s.mu.Unlock()
}

func (s *Server) authorized(r *http.Request) bool {
	value := r.Header.Get("Authorization")
	token, ok := strings.CutPrefix(value, "Bearer ")
	return ok && subtle.ConstantTimeCompare([]byte(token), s.token) == 1
}

func writeJSON(ctx context.Context, c *websocket.Conn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return writeRaw(ctx, c, b)
}

func writeRaw(ctx context.Context, c *websocket.Conn, b []byte) error {
	wctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return c.Write(wctx, websocket.MessageText, b)
}

// Wait blocks until open streams have closed or the timeout passes. Call it
// after the base context is cancelled so consumers receive a close frame.
func (s *Server) Wait(timeout time.Duration) {
	done := make(chan struct{})
	go func() {
		s.streams.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
	}
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	ip := remoteIP(r)
	now := time.Now()
	if s.limited(ip, now) {
		http.Error(w, "too many failed attempts", http.StatusTooManyRequests)
		return
	}
	if !s.authorized(r) {
		s.fail(ip, now)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if s.hub.Count() >= maxConnections {
		http.Error(w, "too many connections", http.StatusServiceUnavailable)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	s.streams.Add(1)
	defer s.streams.Done()
	defer conn.CloseNow()
	conn.SetReadLimit(64 << 10)
	ctx, cancel := context.WithCancel(s.base)
	defer cancel()

	earliest, err := s.store.Earliest()
	if err != nil {
		log.Printf("read ledger bounds: %v", err)
	}
	hello := protocol.Hello{Type: "hello", Protocol: protocol.Version, AgentID: s.info.AgentID,
		Version: s.info.Version, Now: time.Now().UTC(), EarliestBucket: earliest}
	if err := writeJSON(ctx, conn, hello); err != nil {
		return
	}
	since, err := readResume(ctx, conn)
	if err != nil {
		conn.Close(websocket.StatusPolicyViolation, "resume required")
		return
	}
	c, ok := s.hub.register()
	if !ok {
		conn.Close(websocket.StatusTryAgainLater, "too many connections")
		return
	}
	defer s.hub.unregister(c)
	log.Printf("consumer connected from %s", ip)
	defer log.Printf("consumer from %s disconnected", ip)

	through, err := s.replay(ctx, conn, since)
	if err != nil {
		log.Printf("replay failed: %v", err)
		return
	}
	if err := writeJSON(ctx, conn, protocol.ReplayDone{Type: "replay_done", Through: through}); err != nil {
		return
	}
	for {
		batch := s.hub.takePending(c)
		if batch == nil {
			break
		}
		for _, msg := range batch {
			if err := writeRaw(ctx, conn, msg); err != nil {
				return
			}
		}
	}
	s.hub.signalReady()

	ctx = conn.CloseRead(ctx)
	go func() {
		ticker := time.NewTicker(pingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				pctx, pcancel := context.WithTimeout(ctx, pingTimeout)
				err := conn.Ping(pctx)
				pcancel()
				if err != nil {
					c.stop()
					return
				}
			}
		}
	}()
	for {
		select {
		case <-ctx.Done():
			conn.Close(websocket.StatusGoingAway, "agent stopping")
			return
		case <-c.done:
			conn.Close(websocket.StatusTryAgainLater, "consumer too slow or unresponsive")
			return
		case msg := <-c.send:
			if err := writeRaw(ctx, conn, msg); err != nil {
				return
			}
		}
	}
}

func readResume(ctx context.Context, conn *websocket.Conn) (*time.Time, error) {
	rctx, cancel := context.WithTimeout(ctx, resumeTimeout)
	defer cancel()
	typ, data, err := conn.Read(rctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageText {
		return nil, errors.New("resume must be text")
	}
	var msg protocol.Resume
	if err := json.Unmarshal(data, &msg); err != nil || msg.Type != "resume" {
		return nil, errors.New("invalid resume")
	}
	return msg.Since, nil
}

func (s *Server) replay(ctx context.Context, conn *websocket.Conn, since *time.Time) (*time.Time, error) {
	var through *time.Time
	batch := make([]protocol.Bucket, 0, replayBatch)
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		err := writeJSON(ctx, conn, protocol.Buckets{Type: "buckets", Items: batch})
		batch = batch[:0]
		return err
	}
	err := s.store.Replay(since, func(b protocol.Bucket) error {
		batch = append(batch, b)
		t := b.Start
		through = &t
		if len(batch) == replayBatch {
			return flush()
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return through, flush()
}

// Serve listens on every address until ctx ends. Addresses that are not yet
// configured at boot are retried.
func (s *Server) Serve(ctx context.Context, addrs []string, certFile, keyFile string) {
	var wg sync.WaitGroup
	for _, addr := range addrs {
		wg.Add(1)
		go func(addr string) {
			defer wg.Done()
			s.serveOne(ctx, addr, certFile, keyFile)
		}(addr)
	}
	wg.Wait()
}

func (s *Server) serveOne(ctx context.Context, addr, certFile, keyFile string) {
	for ctx.Err() == nil {
		cert, err := tls.LoadX509KeyPair(certFile, keyFile)
		if err != nil {
			log.Printf("load TLS certificate: %v", err)
			sleep(ctx, 30*time.Second)
			continue
		}
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			log.Printf("listen %s: %v; retrying", addr, err)
			sleep(ctx, 5*time.Second)
			continue
		}
		srv := &http.Server{Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second,
			TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}},
			ErrorLog:  log.New(io.Discard, "", 0)}
		go func() {
			<-ctx.Done()
			sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			srv.Shutdown(sctx)
		}()
		log.Printf("listening on %s", addr)
		err = srv.ServeTLS(ln, "", "")
		if ctx.Err() != nil {
			return
		}
		log.Printf("server on %s stopped: %v; restarting", addr, err)
		sleep(ctx, 5*time.Second)
	}
}

func sleep(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}
