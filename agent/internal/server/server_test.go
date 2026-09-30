package server

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/aroxu/unifi-traffic-monitr/agent/internal/protocol"
	"github.com/aroxu/unifi-traffic-monitr/agent/internal/store"
)

const token = "0123456789abcdef0123456789abcdef"

func setup(t *testing.T) (*httptest.Server, *Hub, *store.Memory, context.CancelFunc) {
	st := store.NewMemory(24 * time.Hour)
	hub := NewHub()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	srv := httptest.NewTLSServer(New(ctx, token, st, hub, Info{AgentID: "test", Version: "dev"}).Handler())
	t.Cleanup(srv.Close)
	return srv, hub, st, cancel
}

func dial(t *testing.T, srv *httptest.Server, auth string) (*websocket.Conn, *http.Response, error) {
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	url := strings.Replace(srv.URL, "https://", "wss://", 1) + "/v1/stream"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return websocket.Dial(ctx, url, &websocket.DialOptions{HTTPClient: client,
		HTTPHeader: http.Header{"Authorization": []string{auth}}})
}

func read(t *testing.T, c *websocket.Conn) map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestAuthenticationAndRateLimit(t *testing.T) {
	srv, _, _, _ := setup(t)
	for i := 0; i < failureLimit; i++ {
		_, resp, err := dial(t, srv, "Bearer wrong")
		if err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("attempt %d: expected 401, got %v %v", i, resp, err)
		}
	}
	_, resp, err := dial(t, srv, "Bearer "+token)
	if err == nil || resp == nil || resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("expected 429 after repeated failures, got %v %v", resp, err)
	}
}

func TestReplayThenLiveOrder(t *testing.T) {
	srv, hub, st, stop := setup(t)
	start := time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 3; i++ {
		b := protocol.Bucket{Start: start.Add(time.Duration(i) * 5 * time.Minute), Final: true, CoverageSeconds: 300}
		st.AppendFinal(b)
	}
	c, _, err := dial(t, srv, "Bearer "+token)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	hello := read(t, c)
	if hello["type"] != "hello" || hello["earliestBucket"] != "2026-09-30T00:00:00Z" {
		t.Fatalf("unexpected hello %v", hello)
	}
	since := start
	b, _ := json.Marshal(protocol.Resume{Type: "resume", Since: &since})
	if err := c.Write(context.Background(), websocket.MessageText, b); err != nil {
		t.Fatal(err)
	}
	buckets := read(t, c)
	if buckets["type"] != "buckets" || len(buckets["items"].([]any)) != 2 {
		t.Fatalf("unexpected replay %v", buckets)
	}
	done := read(t, c)
	if done["type"] != "replay_done" || done["through"] != "2026-09-30T00:10:00Z" {
		t.Fatalf("unexpected replay end %v", done)
	}
	deadline := time.Now().Add(2 * time.Second)
	for hub.Count() != 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	select {
	case <-hub.Ready():
	case <-time.After(2 * time.Second):
		t.Fatal("hub was not signalled after replay")
	}
	hub.Broadcast([]byte(`{"type":"live","subjects":[]}`))
	if live := read(t, c); live["type"] != "live" {
		t.Fatalf("unexpected live message %v", live)
	}
	// A message queued while stopping is delivered before the close frame.
	hub.Broadcast([]byte(`{"type":"bucket","final":false}`))
	stop()
	if last := read(t, c); last["type"] != "bucket" {
		t.Fatalf("queued message lost at shutdown: %v", last)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err = c.Read(ctx)
	if status := websocket.CloseStatus(err); status != websocket.StatusGoingAway {
		t.Fatalf("expected going-away close, got %v (%v)", status, err)
	}
}
