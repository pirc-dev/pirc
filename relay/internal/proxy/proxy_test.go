package proxy

import (
	"net/http"
	"testing"
)

func TestParse(t *testing.T) {
	ps, err := Parse(" 10.0.0.1, 192.168.1.7/24,::ffff:10.0.0.2,fd00::/8 ,::ffff:10.1.0.0/112,")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"10.0.0.1/32", "192.168.1.0/24", "10.0.0.2/32", "fd00::/8", "10.1.0.0/16"}
	if len(ps) != len(want) {
		t.Fatalf("got %v", ps)
	}
	for i, p := range ps {
		if p.String() != want[i] {
			t.Fatalf("got %v, want %v", ps, want)
		}
	}
	if ps, err := Parse(""); err != nil || ps != nil {
		t.Fatalf("empty: %v %v", ps, err)
	}
	if w := Wide(ps); len(w) != 3 {
		t.Fatalf("wide %v", w)
	}
	for _, bad := range []string{"proxy.example", "10.0.0.1:80", "10.0.0.0/33", "::ffff:0:0/95"} {
		if _, err := Parse(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestClientAddr(t *testing.T) {
	proxies, err := Parse("10.0.0.1, 10.0.1.0/24")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		remote string
		xff    []string
		want   string
	}{
		{"direct, no header", "198.51.100.4:5000", nil, "198.51.100.4:5000"},
		{"direct, forged header", "198.51.100.4:5000", []string{"203.0.113.9"}, "198.51.100.4:5000"},
		{"proxy, no header", "10.0.0.1:5000", nil, "10.0.0.1:5000"},
		{"proxy", "10.0.0.1:5000", []string{"203.0.113.9"}, "203.0.113.9 via 10.0.0.1:5000"},
		{"client's own entry is ignored", "10.0.0.1:5000", []string{"192.0.2.1, 203.0.113.9"}, "203.0.113.9 via 10.0.0.1:5000"},
		{"chain of proxies", "10.0.0.1:5000", []string{"203.0.113.9, 10.0.1.5"}, "203.0.113.9 via 10.0.0.1:5000"},
		{"several headers", "10.0.0.1:5000", []string{"192.0.2.1", "203.0.113.9"}, "203.0.113.9 via 10.0.0.1:5000"},
		{"garbage stops the walk", "10.0.0.1:5000", []string{"203.0.113.9, junk"}, "10.0.0.1:5000"},
		{"garbage to the left", "10.0.0.1:5000", []string{"junk, 203.0.113.9"}, "203.0.113.9 via 10.0.0.1:5000"},
		{"mapped proxy address", "[::ffff:10.0.0.1]:5000", []string{"2001:db8::1"}, "2001:db8::1 via [::ffff:10.0.0.1]:5000"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &http.Request{RemoteAddr: tc.remote, Header: http.Header{}}
			for _, v := range tc.xff {
				r.Header.Add("X-Forwarded-For", v)
			}
			if _, got := ClientAddr(r, proxies); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestClientAddrKey(t *testing.T) {
	proxies, _ := Parse("10.0.0.1")
	for _, tc := range []struct{ remote, xff, want string }{
		{"198.51.100.4:5000", "", "198.51.100.4"},
		{"[::ffff:198.51.100.4]:5000", "", "198.51.100.4"},
		{"198.51.100.4:5000", "203.0.113.9", "198.51.100.4"},
		{"10.0.0.1:5000", "203.0.113.9", "203.0.113.9"},
		{"10.0.0.1:5000", "", "10.0.0.1"},
	} {
		r := &http.Request{RemoteAddr: tc.remote, Header: http.Header{}}
		if tc.xff != "" {
			r.Header.Set("X-Forwarded-For", tc.xff)
		}
		if got, _ := ClientAddr(r, proxies); got != tc.want {
			t.Errorf("%s %q: got %q, want %q", tc.remote, tc.xff, got, tc.want)
		}
	}
}
