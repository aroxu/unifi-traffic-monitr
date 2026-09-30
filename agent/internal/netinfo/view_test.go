package netinfo

import (
	"net/netip"
	"testing"

	"github.com/aroxu/unifi-traffic-monitr/agent/internal/account"
)

func testView() *View {
	addr := netip.MustParseAddr
	prefix := netip.MustParsePrefix
	topo := Topology{
		ClientPrefixes: []netip.Prefix{prefix("10.24.20.0/24"), prefix("10.24.30.0/24")},
		LocalPrefixes:  []netip.Prefix{prefix("10.24.20.0/24"), prefix("10.24.30.0/24"), prefix("100.100.1.2/32")},
		Gateway: map[netip.Addr]struct{}{addr("10.24.20.254"): {}, addr("10.24.30.254"): {},
			addr("203.0.113.5"): {}},
		Broadcast: map[netip.Addr]struct{}{addr("10.24.20.255"): {}},
	}
	neigh := Neighbors{ByIP: map[netip.Addr]string{addr("10.24.20.10"): "aa:aa:aa:aa:aa:01",
		addr("10.24.30.10"): "aa:aa:aa:aa:aa:02"}}
	return NewView(topo, neigh)
}

func fl(origSrc, replySrc string) account.Flow {
	return account.Flow{OrigSrc: netip.MustParseAddr(origSrc), ReplySrc: netip.MustParseAddr(replySrc)}
}

func TestClassify(t *testing.T) {
	v := testView()
	cases := []struct {
		name string
		flow account.Flow
		want []account.Attribution
	}{
		{"client to internet", fl("10.24.20.10", "8.8.8.8"),
			[]account.Attribution{{Subject: "aa:aa:aa:aa:aa:01", Scope: account.Internet, Initiator: true}}},
		{"port forward from internet", fl("8.8.8.8", "10.24.20.10"),
			[]account.Attribution{{Subject: "aa:aa:aa:aa:aa:01", Scope: account.Internet, Initiator: false}}},
		{"routed between networks", fl("10.24.20.10", "10.24.30.10"), []account.Attribution{
			{Subject: "aa:aa:aa:aa:aa:01", Scope: account.LAN, Initiator: true},
			{Subject: "aa:aa:aa:aa:aa:02", Scope: account.LAN, Initiator: false}}},
		{"client to gateway", fl("10.24.20.10", "10.24.20.254"),
			[]account.Attribution{{Subject: "aa:aa:aa:aa:aa:01", Scope: account.LAN, Initiator: true}}},
		{"client to vpn peer", fl("10.24.30.10", "100.100.1.2"),
			[]account.Attribution{{Subject: "aa:aa:aa:aa:aa:02", Scope: account.LAN, Initiator: true}}},
		{"multicast", fl("10.24.20.10", "224.0.0.251"),
			[]account.Attribution{{Subject: "aa:aa:aa:aa:aa:01", Scope: account.LAN, Initiator: true}}},
		{"broadcast is not a client", fl("10.24.20.10", "10.24.20.255"),
			[]account.Attribution{{Subject: "aa:aa:aa:aa:aa:01", Scope: account.LAN, Initiator: true}}},
		{"unknown mac", fl("10.24.20.77", "8.8.8.8"),
			[]account.Attribution{{Subject: account.Unattributed, Scope: account.Internet, Initiator: true}}},
		{"gateway own traffic", fl("203.0.113.5", "8.8.8.8"), []account.Attribution{}},
	}
	for _, c := range cases {
		got := v.Classify(c.flow)
		if len(got) != len(c.want) {
			t.Fatalf("%s: got %+v want %+v", c.name, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("%s: got %+v want %+v", c.name, got, c.want)
			}
		}
	}
}

func TestLastAddr(t *testing.T) {
	b, ok := lastAddr(netip.MustParsePrefix("10.0.0.0/25"))
	if !ok || b != netip.MustParseAddr("10.0.0.127") {
		t.Fatalf("got %v %v", b, ok)
	}
	if _, ok := lastAddr(netip.MustParsePrefix("10.0.0.1/32")); ok {
		t.Fatal("host prefix has no broadcast")
	}
}
