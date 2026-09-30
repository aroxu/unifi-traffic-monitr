// Package config reads the agent's environment file.
package config

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// DefaultDataDir is the persistent location on UniFi OS.
const DefaultDataDir = "/data/unifi-traffic-agent"

type Config struct {
	DataDir          string
	Listen           []string
	Token            string
	BufferWindow     time.Duration
	LiveInterval     time.Duration
	IdleInterval     time.Duration
	ClientInterfaces []string
}

func (c Config) CertFile() string { return filepath.Join(c.DataDir, "tls", "cert.pem") }
func (c Config) KeyFile() string  { return filepath.Join(c.DataDir, "tls", "key.pem") }

func intEnv(name string, def, min, max int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return def, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v < min || v > max {
		return 0, fmt.Errorf("%s must be an integer between %d and %d", name, min, max)
	}
	return v, nil
}

func list(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

// ListenHosts returns the host part of each listen address.
func (c Config) ListenHosts() []string {
	var out []string
	for _, addr := range c.Listen {
		if host, _, err := net.SplitHostPort(addr); err == nil {
			out = append(out, host)
		}
	}
	return out
}

// FromEnv validates the environment.
func FromEnv(dataDir string) (Config, error) {
	cfg := Config{DataDir: dataDir}
	cfg.Listen = list(os.Getenv("AGENT_LISTEN"))
	if len(cfg.Listen) == 0 {
		return cfg, errors.New("AGENT_LISTEN is required")
	}
	for _, addr := range cfg.Listen {
		host, port, err := net.SplitHostPort(addr)
		if err != nil || port == "" || (host != "" && net.ParseIP(host) == nil) {
			return cfg, fmt.Errorf("invalid AGENT_LISTEN entry %q; use IP:port", addr)
		}
	}
	cfg.Token = strings.TrimSpace(os.Getenv("AGENT_TOKEN"))
	if len(cfg.Token) < 32 {
		return cfg, errors.New("AGENT_TOKEN must be at least 32 characters")
	}
	// Final buckets wait in memory for collectors that were offline. The old
	// AGENT_RETENTION_DAYS setting is ignored because nothing is kept on disk.
	hours, err := intEnv("AGENT_BUFFER_HOURS", 24, 1, 168)
	if err != nil {
		return cfg, err
	}
	cfg.BufferWindow = time.Duration(hours) * time.Hour
	live, err := intEnv("AGENT_LIVE_INTERVAL_MS", 1000, 500, 10000)
	if err != nil {
		return cfg, err
	}
	idle, err := intEnv("AGENT_IDLE_INTERVAL_MS", 10000, 1000, 60000)
	if err != nil {
		return cfg, err
	}
	cfg.LiveInterval = time.Duration(live) * time.Millisecond
	cfg.IdleInterval = time.Duration(idle) * time.Millisecond
	cfg.ClientInterfaces = list(os.Getenv("AGENT_CLIENT_INTERFACES"))
	if len(cfg.ClientInterfaces) == 0 {
		cfg.ClientInterfaces = []string{"br*"}
	}
	for _, p := range cfg.ClientInterfaces {
		if _, err := filepath.Match(p, "x"); err != nil {
			return cfg, fmt.Errorf("invalid AGENT_CLIENT_INTERFACES pattern %q", p)
		}
	}
	return cfg, nil
}
