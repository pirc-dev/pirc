package hosted

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	pb1 "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

// fakeGateway records the handles it is asked to wake.
type fakeGateway struct {
	*httptest.Server
	mu      sync.Mutex
	handles []string
	status  int
}

func newFakeGateway(t *testing.T) *fakeGateway {
	g := &fakeGateway{status: http.StatusOK}
	g.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Handle string }
		json.NewDecoder(r.Body).Decode(&req)
		g.mu.Lock()
		g.handles = append(g.handles, req.Handle)
		st := g.status
		g.mu.Unlock()
		if r.URL.Path != "/v1/wake" || r.Method != http.MethodPost {
			st = http.StatusNotFound
		}
		w.WriteHeader(st)
	}))
	t.Cleanup(g.Close)
	return g
}

// woken waits a little for the gateway's calls and returns the handles
// asked for, sorted.
func (g *fakeGateway) woken(want int) []string {
	for i := 0; i < 100; i++ {
		g.mu.Lock()
		n := len(g.handles)
		g.mu.Unlock()
		if n >= want {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond)
	g.mu.Lock()
	defer g.mu.Unlock()
	out := append([]string(nil), g.handles...)
	sort.Strings(out)
	return out
}

func registerPush(c *client, handle string) {
	c.t.Helper()
	c.send(&pb.Frame{Body: &pb.Frame_RegisterPush{RegisterPush: &pb.RegisterPush{RequestId: "rp", Handle: handle}}})
	c.done("rp")
}

func announcePush(hc *client, host dev, session string, push bool) {
	ref := &pb1.SessionRef{HostKey: host.pub, SessionId: session, InstanceId: "i1"}
	f := announceFrame(ref, nil, nil)
	f.GetSessionAnnounce().Push = push
	hc.send(f)
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestWakePhones(t *testing.T) {
	g := newFakeGateway(t)
	h := newHarness(t, func(c *Config) { c.PushGateway = g.URL })
	ta, _, host, _, p, hc, b, r := listAccount(h)
	// Another account's phone, registered for push.
	other := newDev(7)
	otherID := h.signUp(other)
	otherHost := newDev(8)
	h.add(otherID, otherHost, pb.DeviceRole_DEVICE_ROLE_HOST)
	// Its computer stays connected, which keeps the account loaded.
	h.login(otherHost, otherID)
	oc, _ := h.login(other, otherID)
	registerPush(oc, "other-phone")
	oc.ws.Close(websocket.StatusNormalClosure, "")
	// A device the list does not have, with a handle left in the store.
	if err := h.srv.store.SetPush(ta.id, newDev(30).pub, "ghost"); err != nil {
		t.Fatal(err)
	}
	registerPush(p, "phone")
	registerPush(b, "browser")
	p.ws.Close(websocket.StatusNormalClosure, "")
	b.ws.Close(websocket.StatusNormalClosure, "")
	r.ws.Close(websocket.StatusNormalClosure, "")
	time.Sleep(100 * time.Millisecond)

	announcePush(hc, host, "quiet", false)
	hc.quiet("anything", func(f *pb.Frame) bool { return f.GetError() != nil })
	if got := g.woken(0); len(got) != 0 {
		t.Fatalf("an announcement without push woke %v", got)
	}
	announcePush(hc, host, "loud", true)
	if got := g.woken(2); !equal(got, []string{"browser", "phone"}) {
		t.Fatalf("woken %v", got)
	}
}

func TestWakeSkipsConnectedPhones(t *testing.T) {
	g := newFakeGateway(t)
	h := newHarness(t, func(c *Config) { c.PushGateway = g.URL })
	_, _, host, _, p, hc, b, _ := listAccount(h)
	registerPush(p, "phone")
	registerPush(b, "browser")
	b.ws.Close(websocket.StatusNormalClosure, "")
	time.Sleep(100 * time.Millisecond)
	announcePush(hc, host, "s", true)
	if got := g.woken(1); !equal(got, []string{"browser"}) {
		t.Fatalf("woken %v", got)
	}
}

func TestWakeWindow(t *testing.T) {
	g := newFakeGateway(t)
	h := newHarness(t, func(c *Config) { c.PushGateway = g.URL; c.WakeWindow = 300 * time.Millisecond })
	_, _, host, _, _, hc, b, _ := listAccount(h)
	registerPush(b, "browser")
	b.ws.Close(websocket.StatusNormalClosure, "")
	time.Sleep(100 * time.Millisecond)
	for i := 0; i < 3; i++ {
		announcePush(hc, host, "s", true)
	}
	if got := g.woken(1); len(got) != 1 {
		t.Fatalf("three announcements in one window woke %v", got)
	}
	// The one asked for meanwhile goes when the window ends.
	if got := g.woken(2); len(got) != 2 {
		t.Fatalf("woken %v", got)
	}
}

func TestWakeGoneHandleUnregistered(t *testing.T) {
	g := newFakeGateway(t)
	g.status = http.StatusGone
	h := newHarness(t, func(c *Config) { c.PushGateway = g.URL })
	ta, _, host, browser, _, hc, b, _ := listAccount(h)
	registerPush(b, "browser")
	b.ws.Close(websocket.StatusNormalClosure, "")
	time.Sleep(100 * time.Millisecond)
	announcePush(hc, host, "s", true)
	g.woken(1)
	for i := 0; i < 100; i++ {
		h.srv.mu.Lock()
		rows, _ := h.srv.store.Devices(ta.id)
		h.srv.mu.Unlock()
		if rows[string(browser.pub)].pushHandle == "" {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("a handle the gateway no longer knows stayed registered")
}

// A window's wake at its end looks at the account as loaded then: one
// unloaded and loaded again meanwhile, whose phone is now connected, is
// not woken.
func TestWakeWindowAcrossReload(t *testing.T) {
	g := newFakeGateway(t)
	h := newHarness(t, func(c *Config) { c.PushGateway = g.URL; c.WakeWindow = 500 * time.Millisecond })
	ta, _, host, browser, p, hc, b, r := listAccount(h)
	registerPush(b, "browser")
	for _, c := range []*client{p, b, r} {
		c.ws.Close(websocket.StatusNormalClosure, "")
	}
	time.Sleep(100 * time.Millisecond)
	announcePush(hc, host, "s", true)
	if got := g.woken(1); len(got) != 1 {
		t.Fatalf("woken %v", got)
	}
	hc.ws.Close(websocket.StatusNormalClosure, "")
	time.Sleep(100 * time.Millisecond)
	h.srv.mu.Lock()
	loaded := h.srv.accounts[string(ta.id)] != nil
	h.srv.mu.Unlock()
	if loaded {
		t.Fatal("the account is still loaded")
	}
	hc2, _ := h.login(host, ta.id)
	announcePush(hc2, host, "s", true)
	h.login(browser, ta.id)
	time.Sleep(600 * time.Millisecond)
	if got := g.woken(1); len(got) != 1 {
		t.Errorf("a connected phone was woken at the window's end: %v", got)
	}
}
