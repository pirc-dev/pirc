package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	"pirc.dev/relay/internal/registry"
)

// A push gateway that records the handles it is asked to wake.
type gateway struct {
	t      *testing.T
	url    string
	woken  chan string
	mu     sync.Mutex
	status int
	// Closed to let requests held on it go.
	hold chan struct{}
}

func startGateway(t *testing.T) *gateway {
	g := &gateway{t: t, woken: make(chan string, 64), status: http.StatusOK}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Handle string }
		if r.Method != http.MethodPost || r.URL.Path != "/v1/wake" || r.Header.Get("Content-Type") != "application/json" || r.Header.Get("User-Agent") != Software || json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Errorf("unexpected request %s %s %v", r.Method, r.URL, r.Header)
		}
		g.mu.Lock()
		status, hold := g.status, g.hold
		g.mu.Unlock()
		if hold != nil {
			<-hold
		}
		g.woken <- body.Handle
		w.WriteHeader(status)
	}))
	t.Cleanup(ts.Close)
	g.url = ts.URL
	return g
}

// next returns the next handle woken, or "" when none comes within wait.
func (g *gateway) next(wait time.Duration) string {
	select {
	case h := <-g.woken:
		return h
	case <-time.After(wait):
		return ""
	}
}

func pushed(r *pb.SessionRef, payload string) *pb.Frame {
	f := announce(r, payload)
	f.GetSessionAnnounce().Push = true
	return f
}

func registerPush(p *peer, handle string) {
	p.t.Helper()
	p.send(&pb.Frame{Body: &pb.Frame_RegisterPush{RegisterPush: &pb.RegisterPush{RequestId: "p", Handle: handle}}})
	if f := p.next(func(f *pb.Frame) bool { return f.GetPushChanged() != nil || f.GetError() != nil }); f.GetPushChanged() == nil {
		p.t.Fatalf("register: %v", f)
	}
}

// A flagged announcement wakes the clients registered for push that are
// connected under neither key; one not flagged wakes none.
func TestWakesClientsAsleep(t *testing.T) {
	g := startGateway(t)
	r := startRelayWith(t, func(c *Config) { c.PushGateway = g.url })
	host := r.registered(registry.RoleHost, "desk")
	s1 := ref(host, "s-1", "i-1")

	asleep := r.registered(registry.RoleClient, "asleep")
	registerPush(asleep, "h-asleep")
	asleep.ws.CloseNow()
	open := r.registered(registry.RoleClient, "open")
	registerPush(open, "h-open")
	fetching := r.registered(registry.RoleClient, "fetching")
	registerPush(fetching, "h-fetching")
	readPub, readPriv := newKey(t)
	registerReadKey(fetching, "k", readPub)
	fetching.ws.CloseNow()
	r.dial(readPub, readPriv).mustLogin(pb.Role_ROLE_CLIENT, "", "")
	r.registered(registry.RoleClient, "unregistered").ws.CloseNow()
	for r.connCount() != 3 {
		time.Sleep(10 * time.Millisecond)
	}

	host.send(announce(s1, "working"))
	if h := g.next(300 * time.Millisecond); h != "" {
		t.Fatalf("woke %q for an announcement not flagged", h)
	}
	host.send(pushed(s1, "finished"))
	if h := g.next(5 * time.Second); h != "h-asleep" {
		t.Fatalf("woke %q", h)
	}
	if h := g.next(300 * time.Millisecond); h != "" {
		t.Fatalf("also woke %q", h)
	}
}

// Within a client's window a second wake waits for its end, and goes then
// only if the client still sleeps: never more than two for a burst.
func TestWakeWindow(t *testing.T) {
	g := startGateway(t)
	r := startRelayWith(t, func(c *Config) { c.PushGateway = g.url; c.WakeWindow = 400 * time.Millisecond })
	host := r.registered(registry.RoleHost, "desk")
	s1 := ref(host, "s-1", "i-1")
	pub, priv := newKey(t)
	phone := r.dial(pub, priv)
	phone.mustLogin(pb.Role_ROLE_CLIENT, r.token(registry.RoleClient, "phone", time.Minute), "")
	registerPush(phone, "h")
	phone.ws.CloseNow()
	for r.connCount() != 1 {
		time.Sleep(10 * time.Millisecond)
	}

	start := time.Now()
	for _, p := range []string{"a", "b", "c"} {
		host.send(pushed(s1, p))
	}
	if h := g.next(5 * time.Second); h != "h" {
		t.Fatalf("first wake %q", h)
	}
	if h := g.next(5 * time.Second); h != "h" {
		t.Fatalf("trailing wake %q", h)
	}
	if took := time.Since(start); took < 400*time.Millisecond {
		t.Fatalf("trailing wake after %v, within the window", took)
	}
	if h := g.next(600 * time.Millisecond); h != "" {
		t.Fatalf("a third wake %q", h)
	}

	// The window after the trailing wake has passed: the next goes at
	// once, and one asked for meanwhile is not sent if the phone has
	// connected by the window's end.
	host.send(pushed(s1, "d"))
	if h := g.next(5 * time.Second); h != "h" {
		t.Fatalf("wake %q", h)
	}
	host.send(pushed(s1, "e"))
	r.dial(pub, priv).mustLogin(pb.Role_ROLE_CLIENT, "", "")
	if h := g.next(800 * time.Millisecond); h != "" {
		t.Fatalf("woke %q, connected by the window's end", h)
	}
}

// A handle the gateway no longer knows is unregistered; another status
// leaves it.
func TestWakeGoneUnregisters(t *testing.T) {
	g := startGateway(t)
	r := startRelayWith(t, func(c *Config) { c.PushGateway = g.url; c.WakeWindow = 50 * time.Millisecond })
	host := r.registered(registry.RoleHost, "desk")
	s1 := ref(host, "s-1", "i-1")
	phone := r.registered(registry.RoleClient, "phone")
	registerPush(phone, "h")
	phone.ws.CloseNow()
	handle := func() string {
		d, _ := r.reg.Load()
		k, _ := d.Lookup(phone.pub)
		return k.PushHandle
	}

	g.mu.Lock()
	g.status = http.StatusTooManyRequests
	g.mu.Unlock()
	host.send(pushed(s1, "a"))
	g.next(5 * time.Second)
	time.Sleep(100 * time.Millisecond)
	if handle() != "h" {
		t.Fatalf("unregistered after a 429: %q", handle())
	}

	// A gateway without the platform's credentials yet.
	g.mu.Lock()
	g.status = http.StatusServiceUnavailable
	g.mu.Unlock()
	host.send(pushed(s1, "a2"))
	g.next(5 * time.Second)
	time.Sleep(100 * time.Millisecond)
	if handle() != "h" {
		t.Fatalf("unregistered after a 503: %q", handle())
	}

	g.mu.Lock()
	g.status = http.StatusGone
	g.mu.Unlock()
	host.send(pushed(s1, "b"))
	g.next(5 * time.Second)
	deadline := time.Now().Add(5 * time.Second)
	for handle() != "" {
		if time.Now().After(deadline) {
			t.Fatal("still registered after a 410")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A gateway that does not answer holds up no announcement.
func TestSlowGatewayHoldsNothingUp(t *testing.T) {
	g := startGateway(t)
	g.hold = make(chan struct{})
	t.Cleanup(func() { close(g.hold) })
	r := startRelayWith(t, func(c *Config) { c.PushGateway = g.url })
	host := r.registered(registry.RoleHost, "desk")
	s1 := ref(host, "s-1", "i-1")
	for _, label := range []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j"} {
		p := r.registered(registry.RoleClient, label)
		registerPush(p, "h-"+label)
		p.ws.CloseNow()
	}
	watcher := r.registered(registry.RoleClient, "watcher")
	watcher.send(subscribe())
	watcher.recv()
	host.send(pushed(s1, "first"))
	for _, p := range []string{"second", "third"} {
		host.send(pushed(s1, p))
		if u := watcher.next(func(f *pb.Frame) bool { return f.GetSessionUpdated() != nil }); string(u.GetSessionUpdated().GetEntry().GetPayload()) == "" {
			t.Fatalf("update %v", u)
		}
	}
}

func TestParseGateway(t *testing.T) {
	for in, want := range map[string]string{"": "", "https://pirc.dev": "https://pirc.dev", "https://pirc.dev/": "https://pirc.dev", "http://192.0.2.1:8080/push": "http://192.0.2.1:8080/push"} {
		if got, err := ParseGateway(in); err != nil || got != want {
			t.Errorf("%q: %q %v", in, got, err)
		}
	}
	for _, in := range []string{"pirc.dev", "ftp://pirc.dev", "https://", "https://pirc.dev/?x=1"} {
		if _, err := ParseGateway(in); err == nil {
			t.Errorf("%q accepted", in)
		}
	}
}
