// Package proxy finds the address a request came from when it may have
// passed through trusted proxies: for the relay and the push gateway,
// which both limit by address.
package proxy

import (
	"fmt"
	"net/http"
	"net/netip"
	"strings"
)

// Parse reads a comma-separated list of addresses and CIDR prefixes,
// such as "10.0.0.1, 192.168.0.0/24". An empty list is none.
func Parse(s string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, f := range strings.Split(s, ",") {
		f = strings.TrimSpace(f)
		if f == "" {
			continue
		}
		if strings.Contains(f, "/") {
			p, err := netip.ParsePrefix(f)
			if err != nil {
				return nil, fmt.Errorf("trusted proxy %q: %w", f, err)
			}
			// Addresses are compared unmapped, so prefixes are too.
			if a := p.Addr(); a.Is4In6() {
				if p.Bits() < 96 {
					return nil, fmt.Errorf("trusted proxy %q: wider than the IPv4-mapped range", f)
				}
				p = netip.PrefixFrom(a.Unmap(), p.Bits()-96)
			}
			out = append(out, p.Masked())
			continue
		}
		a, err := netip.ParseAddr(f)
		if err != nil {
			return nil, fmt.Errorf("trusted proxy %q: %w", f, err)
		}
		a = a.Unmap()
		out = append(out, netip.PrefixFrom(a, a.BitLen()))
	}
	return out, nil
}

func trusted(a netip.Addr, proxies []netip.Prefix) bool {
	for _, p := range proxies {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// ClientAddr is the peer's address: addr, to limit it by, and shown, for
// logs and approval requests. addr is an IPv4 address bare, and an IPv6
// address as its /64, since one network has every address of its /64 to
// pass for many peers with. From a trusted proxy it is
// the rightmost X-Forwarded-For entry that is not itself a trusted proxy:
// each proxy appends the address it saw, so anything left of that was
// written by the client and may be forged. From anyone else the header is
// ignored.
func ClientAddr(r *http.Request, proxies []netip.Prefix) (addr, shown string) {
	ap, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr, r.RemoteAddr
	}
	if !trusted(ap.Addr().Unmap(), proxies) {
		return limitKey(ap.Addr()), r.RemoteAddr
	}
	var hops []string
	for _, v := range r.Header.Values("X-Forwarded-For") {
		hops = append(hops, strings.Split(v, ",")...)
	}
	client, key := "", ""
	for i := len(hops) - 1; i >= 0; i-- {
		a, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			break
		}
		client = a.Unmap().String()
		key = limitKey(a)
		if !trusted(a.Unmap(), proxies) {
			break
		}
	}
	if client == "" {
		return limitKey(ap.Addr()), r.RemoteAddr
	}
	return key, client + " via " + r.RemoteAddr
}

// limitKey is a as ClientAddr limits it: an IPv4 address (or IPv4-mapped
// one) bare, an IPv6 address as its /64.
func limitKey(a netip.Addr) string {
	a = a.Unmap()
	if a.Is4() {
		return a.String()
	}
	return netip.PrefixFrom(a, 64).Masked().String()
}

// Wide reports the prefixes that cover more than one address: any peer
// inside one can pass for any address, by sending the header itself.
func Wide(proxies []netip.Prefix) []netip.Prefix {
	var out []netip.Prefix
	for _, p := range proxies {
		if !p.IsSingleIP() {
			out = append(out, p)
		}
	}
	return out
}
