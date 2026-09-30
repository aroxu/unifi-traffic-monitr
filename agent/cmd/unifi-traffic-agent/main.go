// Command unifi-traffic-agent measures per-client traffic on a UniFi gateway.
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/aroxu/unifi-traffic-monitr/agent/internal/agent"
	"github.com/aroxu/unifi-traffic-monitr/agent/internal/certs"
	"github.com/aroxu/unifi-traffic-monitr/agent/internal/config"
)

var version = "dev"

func usage() {
	fmt.Fprintf(os.Stderr, "usage: unifi-traffic-agent [run|gen-cert|fingerprint|gen-token|version] [-data-dir DIR]\n")
	os.Exit(2)
}

func main() {
	log.SetFlags(0)
	cmd := "run"
	args := os.Args[1:]
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	dataDir := fs.String("data-dir", config.DefaultDataDir, "persistent data directory")
	hosts := fs.String("hosts", "", "comma-separated certificate IP addresses or names")
	fs.Parse(args)
	switch cmd {
	case "run":
		cfg, err := config.FromEnv(*dataDir)
		if err != nil {
			log.Fatalf("configuration: %v", err)
		}
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer stop()
		log.Printf("unifi-traffic-agent %s starting", version)
		if err := agent.Run(ctx, cfg, version); err != nil {
			log.Fatalf("agent stopped: %v", err)
		}
		log.Printf("agent stopped")
	case "gen-cert":
		dir := filepath.Join(*dataDir, "tls")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			log.Fatal(err)
		}
		if err := certs.Generate(filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem"), strings.Split(*hosts, ",")); err != nil {
			log.Fatalf("generate certificate: %v", err)
		}
	case "fingerprint":
		fp, err := certs.Fingerprint(filepath.Join(*dataDir, "tls", "cert.pem"))
		if err != nil {
			log.Fatalf("read certificate: %v", err)
		}
		fmt.Println(fp)
	case "gen-token":
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			log.Fatal(err)
		}
		fmt.Println(base64.RawURLEncoding.EncodeToString(b))
	case "version":
		fmt.Println(version)
	default:
		usage()
	}
}
