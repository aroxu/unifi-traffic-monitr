package netinfo

import (
	"fmt"
	"net"
	"net/netip"
	"path"
	"sort"
	"strings"

	"github.com/vishvananda/netlink"
	"golang.org/x/sys/unix"
)

func toAddr(ip net.IP) (netip.Addr, bool) {
	a, ok := netip.AddrFromSlice(ip)
	if !ok {
		return netip.Addr{}, false
	}
	return a.Unmap(), true
}

func toPrefix(n *net.IPNet) (netip.Prefix, bool) {
	if n == nil {
		return netip.Prefix{}, false
	}
	a, ok := toAddr(n.IP)
	if !ok {
		return netip.Prefix{}, false
	}
	ones, _ := n.Mask.Size()
	if a.Is4() && ones > 32 {
		ones -= 96
	}
	p, err := a.Prefix(ones)
	if err != nil {
		return netip.Prefix{}, false
	}
	return p, true
}

func matchAny(patterns []string, name string) bool {
	for _, p := range patterns {
		if ok, _ := path.Match(p, name); ok {
			return true
		}
	}
	return false
}

type linkSet struct {
	names  map[int]string
	client map[int]bool
}

func loadLinks(patterns []string) (linkSet, error) {
	links, err := netlink.LinkList()
	if err != nil {
		return linkSet{}, fmt.Errorf("list links: %w", err)
	}
	set := linkSet{names: map[int]string{}, client: map[int]bool{}}
	for _, l := range links {
		attrs := l.Attrs()
		set.names[attrs.Index] = attrs.Name
		if matchAny(patterns, attrs.Name) {
			set.client[attrs.Index] = true
		}
	}
	return set, nil
}

// LoadTopology reads addresses and all routing tables.
func LoadTopology(clientPatterns []string) (Topology, error) {
	links, err := loadLinks(clientPatterns)
	if err != nil {
		return Topology{}, err
	}
	addrs, err := netlink.AddrList(nil, netlink.FAMILY_ALL)
	if err != nil {
		return Topology{}, fmt.Errorf("list addresses: %w", err)
	}
	routes, err := netlink.RouteListFiltered(netlink.FAMILY_ALL, &netlink.Route{Table: unix.RT_TABLE_UNSPEC}, netlink.RT_FILTER_TABLE)
	if err != nil {
		return Topology{}, fmt.Errorf("list routes: %w", err)
	}
	topo := Topology{Gateway: map[netip.Addr]struct{}{}, Broadcast: map[netip.Addr]struct{}{}}
	wan := map[int]bool{}
	isDefault := func(r netlink.Route) bool {
		if r.Dst == nil {
			return true
		}
		ones, _ := r.Dst.Mask.Size()
		return ones == 0
	}
	hops := func(r netlink.Route) []int {
		if len(r.MultiPath) == 0 {
			return []int{r.LinkIndex}
		}
		out := make([]int, 0, len(r.MultiPath))
		for _, h := range r.MultiPath {
			out = append(out, h.LinkIndex)
		}
		return out
	}
	for _, r := range routes {
		if r.Type != unix.RTN_UNICAST || !isDefault(r) {
			continue
		}
		for _, idx := range hops(r) {
			if idx > 0 {
				wan[idx] = true
			}
		}
	}
	clientSet := map[netip.Prefix]struct{}{}
	localSet := map[netip.Prefix]struct{}{}
	for _, addr := range addrs {
		a, ok := toAddr(addr.IP)
		if !ok {
			continue
		}
		topo.Gateway[a] = struct{}{}
		p, ok := toPrefix(addr.IPNet)
		if !ok || a.IsLinkLocalUnicast() {
			continue
		}
		p = p.Masked()
		if links.client[addr.LinkIndex] && !wan[addr.LinkIndex] {
			clientSet[p] = struct{}{}
			localSet[p] = struct{}{}
			if b, ok := lastAddr(p); ok {
				topo.Broadcast[b] = struct{}{}
			}
		}
	}
	for _, r := range routes {
		if (r.Type != unix.RTN_UNICAST && r.Type != unix.RTN_LOCAL) || isDefault(r) {
			continue
		}
		viaWAN := false
		for _, idx := range hops(r) {
			if wan[idx] {
				viaWAN = true
			}
		}
		if viaWAN {
			continue
		}
		if p, ok := toPrefix(r.Dst); ok {
			localSet[p.Masked()] = struct{}{}
		}
	}
	topo.ClientPrefixes = sortedPrefixes(clientSet)
	topo.LocalPrefixes = sortedPrefixes(localSet)
	for idx := range wan {
		topo.WANLinks = append(topo.WANLinks, links.names[idx])
	}
	for idx := range links.client {
		if !wan[idx] {
			topo.ClientLinks = append(topo.ClientLinks, links.names[idx])
		}
	}
	sort.Strings(topo.WANLinks)
	sort.Strings(topo.ClientLinks)
	if len(topo.ClientPrefixes) == 0 {
		return topo, fmt.Errorf("no client networks on interfaces matching %s", strings.Join(clientPatterns, ","))
	}
	return topo, nil
}

const usableNeighbor = netlink.NUD_REACHABLE | netlink.NUD_STALE | netlink.NUD_DELAY | netlink.NUD_PROBE | netlink.NUD_PERMANENT

// LoadNeighbors reads the ARP and NDP tables of client interfaces.
func LoadNeighbors(clientPatterns []string) (Neighbors, error) {
	links, err := loadLinks(clientPatterns)
	if err != nil {
		return Neighbors{}, err
	}
	list, err := netlink.NeighList(0, netlink.FAMILY_ALL)
	if err != nil {
		return Neighbors{}, fmt.Errorf("list neighbours: %w", err)
	}
	out := Neighbors{ByIP: map[netip.Addr]string{}}
	macs := map[string]struct{}{}
	for _, n := range list {
		if !links.client[n.LinkIndex] || len(n.HardwareAddr) != 6 || n.State&usableNeighbor == 0 {
			continue
		}
		a, ok := toAddr(n.IP)
		if !ok {
			continue
		}
		mac := strings.ToLower(n.HardwareAddr.String())
		if mac == "00:00:00:00:00:00" {
			continue
		}
		out.ByIP[a] = mac
		macs[mac] = struct{}{}
	}
	for mac := range macs {
		out.MACs = append(out.MACs, mac)
	}
	sort.Strings(out.MACs)
	return out, nil
}
