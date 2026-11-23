package main

import (
	"bufio"
	"crypto/tls"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pires/go-proxyproto"

	"pirc.dev/relay/internal/proxy"
)

// serveAddrs serves, on a loopback listener wrapped for routers, a page
// that answers with the address the caps would count (TLS when tlsCfg
// is given), and returns the listener's address.
func serveAddrs(t *testing.T, listen string, routers []netip.Prefix, tlsCfg *tls.Config) string {
	t.Helper()
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		t.Fatal(err)
	}
	l := proxyListener(ln, routers)
	if tlsCfg != nil {
		l = tls.NewListener(l, tlsCfg)
	}
	hs := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key, _ := proxy.ClientAddr(r, nil)
		io.WriteString(w, key)
	}), ErrorLog: log.New(io.Discard, "", 0)}
	go hs.Serve(l)
	t.Cleanup(func() { hs.Close() })
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	return net.JoinHostPort("127.0.0.1", port)
}

// ask connects, writes header (if any), then asks for the page, over TLS
// when tlsCfg is given; it returns the body, or "" when the connection
// ends without an answer or the answer is an error.
func ask(t *testing.T, addr string, header []byte, tlsCfg *tls.Config) string {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.Write(header); err != nil {
		return ""
	}
	var rw io.ReadWriter = c
	if tlsCfg != nil {
		tc := tls.Client(c, tlsCfg)
		if err := tc.Handshake(); err != nil {
			return ""
		}
		rw = tc
	}
	if _, err := io.WriteString(rw, "GET / HTTP/1.0\r\nHost: relay\r\n\r\n"); err != nil {
		return ""
	}
	resp, err := http.ReadResponse(bufio.NewReader(rw), nil)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}

func header(t *testing.T, version byte, cmd proxyproto.ProtocolVersionAndCommand, src string) []byte {
	t.Helper()
	h := proxyproto.HeaderProxyFromAddrs(version, net.TCPAddrFromAddrPort(netip.MustParseAddrPort(src)), &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 8443})
	h.Command = cmd
	b, err := h.Format()
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestProxyProtocol(t *testing.T) {
	loopback := []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	other := []netip.Prefix{netip.MustParsePrefix("192.0.2.1/32")}

	dir := t.TempDir()
	certPath, keyPath := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	writePair(t, certPath, keyPath, "relay", time.Now())
	pair, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		t.Fatal(err)
	}
	serverTLS := &tls.Config{Certificates: []tls.Certificate{pair}}
	clientTLS := &tls.Config{InsecureSkipVerify: true}

	cases := []struct {
		name    string
		routers []netip.Prefix
		header  []byte
		want    string
	}{
		{"router gives an IPv4 client", loopback, header(t, 2, proxyproto.PROXY, "203.0.113.7:4000"), "203.0.113.7"},
		{"router gives an IPv6 client, counted by its /64", loopback, header(t, 2, proxyproto.PROXY, "[2001:db8:1:2::5]:4000"), "2001:db8:1:2::/64"},
		{"router's LOCAL header keeps its own address", loopback, header(t, 2, proxyproto.LOCAL, "203.0.113.7:4000"), "127.0.0.1"},
		{"router without a header is refused", loopback, nil, ""},
		{"router with a version 1 header is refused", loopback, header(t, 1, proxyproto.PROXY, "203.0.113.7:4000"), ""},
		{"anyone else with a header is refused", other, header(t, 2, proxyproto.PROXY, "203.0.113.7:4000"), ""},
		{"anyone else without a header is served as itself", other, nil, "127.0.0.1"},
		{"no routers: served as itself", nil, nil, "127.0.0.1"},
		{"no routers: a header is refused", nil, header(t, 2, proxyproto.PROXY, "203.0.113.7:4000"), ""},
	}
	for _, c := range cases {
		for _, withTLS := range []bool{false, true} {
			name := c.name
			var s, cl *tls.Config
			if withTLS {
				name += ", TLS"
				s, cl = serverTLS, clientTLS
			}
			t.Run(name, func(t *testing.T) {
				addr := serveAddrs(t, "127.0.0.1:0", c.routers, s)
				if got := ask(t, addr, c.header, cl); got != c.want {
					t.Errorf("served as %q, want %q", got, c.want)
				}
			})
		}
	}
}

// A listener on every address, IPv4 and IPv6, still knows an IPv4
// router.
func TestProxyProtocolDualStack(t *testing.T) {
	addr := serveAddrs(t, "[::]:0", []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}, nil)
	if got := ask(t, addr, header(t, 2, proxyproto.PROXY, "203.0.113.7:4000"), nil); got != "203.0.113.7" {
		t.Errorf("served as %q", got)
	}
}

func TestProxyProtocolFlag(t *testing.T) {
	for _, v := range []string{"10.0.0.1", "10.0.0.0/24, fd00::1"} {
		t.Setenv("PIRC_RELAY_PROXY_PROTOCOL_FROM", v)
		n := testNetFlags(t, "--plaintext")
		if _, _, err := n.check(); err != nil || len(n.routers) != len(strings.Split(v, ",")) {
			t.Errorf("%q: routers %v, %v", v, n.routers, err)
		}
	}
	t.Setenv("PIRC_RELAY_PROXY_PROTOCOL_FROM", "not-an-address")
	if _, _, err := testNetFlags(t, "--plaintext").check(); err == nil || !strings.Contains(err.Error(), "--proxy-protocol-from") {
		t.Errorf("bad address: %v", err)
	}
}

func testNetFlags(t *testing.T, args ...string) *netFlags {
	t.Helper()
	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	n, err := addNetFlags(fs, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if err := fs.Parse(args); err != nil {
		t.Fatal(err)
	}
	return n
}
