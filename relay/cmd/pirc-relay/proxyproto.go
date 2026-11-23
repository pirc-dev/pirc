package main

import (
	"errors"
	"net"
	"net/netip"
	"time"

	"github.com/pires/go-proxyproto"
)

// proxyListener is ln, but when routers are given a connection from one
// of them must open with a PROXY protocol v2 header, and the client's
// address in it is the connection's RemoteAddr, so the caps by address
// count the client and not the router. A connection from anyone else
// that opens with a header is refused: only a router may say whose
// connection it is. A router's LOCAL header, a health check's, leaves
// the router's own address.
func proxyListener(ln net.Listener, routers []netip.Prefix) net.Listener {
	if len(routers) == 0 {
		return ln
	}
	return &proxyproto.Listener{
		Listener: ln,
		ConnPolicy: func(o proxyproto.ConnPolicyOptions) (proxyproto.Policy, error) {
			if fromRouter(o.Upstream, routers) {
				return proxyproto.REQUIRE, nil
			}
			return proxyproto.REJECT, nil
		},
		ValidateHeader:    validHeader,
		ReadHeaderTimeout: 10 * time.Second,
	}
}

func fromRouter(a net.Addr, routers []netip.Prefix) bool {
	ap, err := netip.ParseAddrPort(a.String())
	if err != nil {
		return false
	}
	for _, p := range routers {
		if p.Contains(ap.Addr().Unmap()) {
			return true
		}
	}
	return false
}

// validHeader takes version 2 only, and of its commands LOCAL, or PROXY
// for a TCP connection: any other has no address to stand for the
// client's.
func validHeader(h *proxyproto.Header) error {
	if h.Version != 2 {
		return errors.New("PROXY protocol: version 2 only")
	}
	if h.Command.IsLocal() {
		return nil
	}
	if !h.Command.IsProxy() || (h.TransportProtocol != proxyproto.TCPv4 && h.TransportProtocol != proxyproto.TCPv6) {
		return errors.New("PROXY protocol: not a TCP connection")
	}
	if a, ok := h.SourceAddr.(*net.TCPAddr); !ok || a == nil {
		return errors.New("PROXY protocol: no source address")
	}
	return nil
}
