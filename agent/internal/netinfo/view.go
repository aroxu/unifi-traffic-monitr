// Package netinfo reads the gateway's addresses, routes, and neighbours and
// classifies conntrack endpoints.
package netinfo

import (
	"net/netip"
	"sort"

	"github.com/aroxu/unifi-traffic-monitr/agent/internal/account"
)

// Topology is the address and routing state that changes rarely.
type Topology struct {
	// ClientPrefixes are networks attached to client interfaces.
	ClientPrefixes []netip.Prefix
	// LocalPrefixes are non-default routes through non-WAN interfaces,
	// including client networks and VPN peers.
	LocalPrefixes []netip.Prefix
	// Gateway holds every address owned by the gateway.
	Gateway map[netip.Addr]struct{}
	// Broadcast holds directed broadcast addresses of client networks.
	Broadcast   map[netip.Addr]struct{}
	WANLinks    []string
	ClientLinks []string
}

// Neighbors maps client IP addresses to MAC addresses.
type Neighbors struct {
	ByIP map[netip.Addr]string
	// MACs lists clients with a usable neighbour entry.
	MACs []string
}

type addrInfo struct {
	client  bool
	local   bool
	subject string
}

// View classifies flows. It is used by one goroutine.
type View struct {
	topo  Topology
	neigh Neighbors
	memo  map[netip.Addr]addrInfo
}

func NewView(topo Topology, neigh Neighbors) *View {
	return &View{topo: topo, neigh: neigh, memo: map[netip.Addr]addrInfo{}}
}

func (v *View) SetTopology(topo Topology) {
	v.topo = topo
	v.memo = map[netip.Addr]addrInfo{}
}

func (v *View) SetNeighbors(neigh Neighbors) {
	v.neigh = neigh
	v.memo = map[netip.Addr]addrInfo{}
}

func (v *View) Topology() Topology { return v.topo }

// LiveMACs returns clients present in the neighbour table.
func (v *View) LiveMACs() []string { return v.neigh.MACs }

func contains(prefixes []netip.Prefix, a netip.Addr) bool {
	for _, p := range prefixes {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

var limitedBroadcast = netip.MustParseAddr("255.255.255.255")

func (v *View) info(a netip.Addr) addrInfo {
	if cached, ok := v.memo[a]; ok {
		return cached
	}
	_, gateway := v.topo.Gateway[a]
	_, broadcast := v.topo.Broadcast[a]
	special := a.IsMulticast() || a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() ||
		a.IsLoopback() || a.IsUnspecified() || a == limitedBroadcast || broadcast
	info := addrInfo{}
	info.client = !gateway && !special && contains(v.topo.ClientPrefixes, a)
	info.local = gateway || special || info.client || contains(v.topo.LocalPrefixes, a)
	if info.client {
		info.subject = v.neigh.ByIP[a]
		if info.subject == "" {
			info.subject = account.Unattributed
		}
	}
	if len(v.memo) > 65536 {
		v.memo = map[netip.Addr]addrInfo{}
	}
	v.memo[a] = info
	return info
}

// Classify returns the clients involved in a flow. A routed flow between two
// client networks is attributed to both sides as LAN traffic. Traffic of the
// gateway itself is not attributed.
func (v *View) Classify(f account.Flow) []account.Attribution {
	a, b := v.info(f.OrigSrc), v.info(f.ReplySrc)
	out := make([]account.Attribution, 0, 2)
	if a.client {
		scope := account.Internet
		if b.local {
			scope = account.LAN
		}
		out = append(out, account.Attribution{Subject: a.subject, Scope: scope, Initiator: true})
	}
	if b.client && f.ReplySrc != f.OrigSrc {
		scope := account.Internet
		if a.local {
			scope = account.LAN
		}
		out = append(out, account.Attribution{Subject: b.subject, Scope: scope, Initiator: false})
	}
	return out
}

func sortedPrefixes(set map[netip.Prefix]struct{}) []netip.Prefix {
	out := make([]netip.Prefix, 0, len(set))
	for p := range set {
		out = append(out, p)
	}
	// Longer prefixes first keeps common client lookups short.
	sort.Slice(out, func(i, j int) bool {
		if out[i].Bits() != out[j].Bits() {
			return out[i].Bits() > out[j].Bits()
		}
		return out[i].Addr().Less(out[j].Addr())
	})
	return out
}

func lastAddr(p netip.Prefix) (netip.Addr, bool) {
	if !p.Addr().Is4() || p.Bits() >= 31 {
		return netip.Addr{}, false
	}
	b := p.Masked().Addr().As4()
	host := uint32(1)<<(32-p.Bits()) - 1
	v := uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
	v |= host
	return netip.AddrFrom4([4]byte{byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)}), true
}
