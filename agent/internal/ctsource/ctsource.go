// Package ctsource reads the kernel conntrack table over netlink.
package ctsource

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/ti-mo/conntrack"
	"github.com/ti-mo/netfilter"

	"github.com/aroxu/unifi-traffic-monitr/agent/internal/account"
)

// CheckAccounting verifies that the kernel keeps per-flow byte counters.
func CheckAccounting() error {
	data, err := os.ReadFile("/proc/sys/net/netfilter/nf_conntrack_acct")
	if err != nil {
		return fmt.Errorf("read nf_conntrack_acct: %w", err)
	}
	if strings.TrimSpace(string(data)) != "1" {
		return fmt.Errorf("conntrack byte accounting is disabled (net.netfilter.nf_conntrack_acct=0)")
	}
	return nil
}

// Convert extracts the fields used for accounting.
func Convert(f conntrack.Flow) (account.Flow, bool) {
	origSrc := f.TupleOrig.IP.SourceAddress.Unmap()
	origDst := f.TupleOrig.IP.DestinationAddress.Unmap()
	replySrc := f.TupleReply.IP.SourceAddress.Unmap()
	if !origSrc.IsValid() || !replySrc.IsValid() {
		return account.Flow{}, false
	}
	key := account.FlowKey{ID: f.ID, Zone: f.Zone, Proto: f.TupleOrig.Proto.Protocol, Src: origSrc, Dst: origDst,
		SPort: f.TupleOrig.Proto.SourcePort, DPort: f.TupleOrig.Proto.DestinationPort}
	return account.Flow{Key: key, OrigSrc: origSrc, ReplySrc: replySrc,
		OrigBytes: f.CountersOrig.Bytes, ReplyBytes: f.CountersReply.Bytes}, true
}

// Dumper reads the whole table.
type Dumper struct{ conn *conntrack.Conn }

func OpenDumper() (*Dumper, error) {
	c, err := conntrack.Dial(nil)
	if err != nil {
		return nil, fmt.Errorf("open conntrack netlink: %w", err)
	}
	return &Dumper{conn: c}, nil
}

// Dump returns every flow. On error the netlink socket is reopened.
func (d *Dumper) Dump(buf []account.Flow) ([]account.Flow, error) {
	flows, err := d.conn.Dump(nil)
	if err != nil {
		d.conn.Close()
		if c, derr := conntrack.Dial(nil); derr == nil {
			d.conn = c
		}
		return buf, err
	}
	buf = buf[:0]
	for _, f := range flows {
		if conv, ok := Convert(f); ok {
			buf = append(buf, conv)
		}
	}
	return buf, nil
}

func (d *Dumper) Close() error { return d.conn.Close() }

// ListenDestroy forwards destroy events until ctx ends. The library stops its
// worker on any receive error, including a full socket buffer, so the
// subscription is recreated after each error.
func ListenDestroy(ctx context.Context, out chan<- account.Flow, onError func(error)) {
	for ctx.Err() == nil {
		if err := listenOnce(ctx, out); err != nil && ctx.Err() == nil {
			onError(err)
			select {
			case <-ctx.Done():
			case <-time.After(200 * time.Millisecond):
			}
		}
	}
}

func listenOnce(ctx context.Context, out chan<- account.Flow) error {
	c, err := conntrack.Dial(nil)
	if err != nil {
		return err
	}
	_ = c.SetReadBuffer(16 << 20)
	events := make(chan conntrack.Event, 4096)
	errs, err := c.Listen(events, 1, []netfilter.NetlinkGroup{netfilter.GroupCTDestroy})
	if err != nil {
		c.Close()
		return err
	}
	shutdown := func() {
		// Close waits for the worker, which may be blocked sending an event.
		done := make(chan struct{})
		go func() {
			for {
				select {
				case <-events:
				case <-done:
					return
				}
			}
		}()
		c.Close()
		close(done)
	}
	for {
		select {
		case <-ctx.Done():
			shutdown()
			return nil
		case err := <-errs:
			shutdown()
			return err
		case ev := <-events:
			if ev.Type != conntrack.EventDestroy || ev.Flow == nil {
				continue
			}
			if f, ok := Convert(*ev.Flow); ok {
				select {
				case out <- f:
				case <-ctx.Done():
					shutdown()
					return nil
				}
			}
		}
	}
}
