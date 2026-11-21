package hosted

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	pb1 "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

const origin = "wss://relay.test"

// The relay's clock.
var t0 = time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)

type harness struct {
	t   *testing.T
	dir string
	srv *Server
	ts  *httptest.Server
	cfg Config
}

func newHarness(t *testing.T, tweak func(*Config)) *harness {
	h := &harness{t: t, dir: t.TempDir()}
	h.start(tweak)
	return h
}

func (h *harness) start(tweak func(*Config)) {
	store, err := OpenStore(h.dir)
	if err != nil {
		h.t.Fatal(err)
	}
	h.cfg = Config{Store: store, Origin: origin, Verifier: TestVerifier{}, Now: func() time.Time { return t0 }, Logger: testLogger()}
	if tweak != nil {
		tweak(&h.cfg)
	}
	srv, err := New(h.cfg)
	if err != nil {
		h.t.Fatal(err)
	}
	h.srv = srv
	h.ts = httptest.NewServer(srv.Handler())
	h.t.Cleanup(h.stop)
}

func (h *harness) stop() {
	if h.ts == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	h.srv.Shutdown(ctx)
	h.ts.Close()
	h.cfg.Store.Close()
	h.ts = nil
}

func (h *harness) restart() {
	h.stop()
	h.start(nil)
}

type dev struct {
	pub  ed25519.PublicKey
	priv ed25519.PrivateKey
}

func newDev(seed byte) dev {
	priv := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{seed}, 32))
	return dev{pub: priv.Public().(ed25519.PublicKey), priv: priv}
}

// client is a test device's connection. Frames are read in the
// background, since a read that times out closes a coder/websocket
// connection.
type client struct {
	t      *testing.T
	ws     *websocket.Conn
	key    dev
	frames chan *pb.Frame
	// The error that ended the connection, once frames is closed.
	err error
}

func newClient(t *testing.T, ws *websocket.Conn, d dev) *client {
	c := &client{t: t, ws: ws, key: d, frames: make(chan *pb.Frame, 1024)}
	go func() {
		defer close(c.frames)
		for {
			_, b, err := ws.Read(context.Background())
			if err != nil {
				c.err = err
				return
			}
			f := &pb.Frame{}
			if err := proto.Unmarshal(b, f); err != nil {
				c.err = err
				return
			}
			c.frames <- f
		}
	}()
	return c
}

func (h *harness) dialRaw(path string) (*websocket.Conn, *http.Response, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return websocket.Dial(ctx, "ws"+strings.TrimPrefix(h.ts.URL, "http")+path, nil)
}

// login logs d in to account (nil for none), signing for signOrigin; it
// returns the connection and the frame that ended the login, a Welcome or
// an Error.
func (h *harness) loginAs(d dev, account []byte, signOrigin string, version pb.ProtocolVersion) (*client, *pb.Frame) {
	h.t.Helper()
	ws, _, err := h.dialRaw(Path)
	if err != nil {
		h.t.Fatal(err)
	}
	ws.SetReadLimit(64 << 20)
	c := newClient(h.t, ws, d)
	h.t.Cleanup(func() { ws.CloseNow() })
	c.send(&pb.Frame{Body: &pb.Frame_Hello{Hello: &pb.Hello{ProtocolVersion: version, PublicKey: d.pub, AccountId: account}}})
	f := c.next()
	ch := f.GetChallenge()
	if ch == nil {
		return c, f
	}
	c.send(&pb.Frame{Body: &pb.Frame_Auth{Auth: &pb.Auth{Signature: ed25519.Sign(d.priv, framed(AuthContext, account, []byte(signOrigin), ch.Nonce))}}})
	return c, c.next()
}

// login logs d in, failing the test unless it is welcomed.
func (h *harness) login(d dev, account []byte) (*client, *pb.Welcome) {
	h.t.Helper()
	c, f := h.loginAs(d, account, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2)
	w := f.GetWelcome()
	if w == nil {
		h.t.Fatalf("not welcomed: %v", f)
	}
	return c, w
}

func (c *client) send(f *pb.Frame) {
	c.t.Helper()
	b, err := proto.Marshal(f)
	if err != nil {
		c.t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := c.ws.Write(ctx, websocket.MessageBinary, b); err != nil {
		c.t.Fatal(err)
	}
}

// read is the next frame, or the error that ended the connection.
func (c *client) read(wait time.Duration) (*pb.Frame, error) {
	select {
	case f, ok := <-c.frames:
		if !ok {
			return nil, c.err
		}
		return f, nil
	case <-time.After(wait):
		return nil, errTimeout
	}
}

var errTimeout = errors.New("no frame in time")

func (c *client) next() *pb.Frame {
	c.t.Helper()
	f, err := c.read(2 * time.Second)
	if err != nil {
		c.t.Fatalf("no frame: %v", err)
	}
	return f
}

// until skips frames until one that ok takes.
func (c *client) until(what string, ok func(*pb.Frame) bool) *pb.Frame {
	c.t.Helper()
	for {
		f, err := c.read(2 * time.Second)
		if err != nil {
			c.t.Fatalf("waiting for %s: %v", what, err)
		}
		if ok(f) {
			return f
		}
	}
}

func (c *client) done(id string) {
	c.t.Helper()
	f := c.until("Done "+id, func(f *pb.Frame) bool {
		return f.GetDone().GetRequestId() == id || f.GetError().GetRequestId() == id && id != ""
	})
	if f.GetDone() == nil {
		c.t.Fatalf("%s: %v", id, f.GetError())
	}
}

func (c *client) errorFor(id string) *pb1.Error {
	c.t.Helper()
	f := c.until("an answer to "+id, func(f *pb.Frame) bool {
		return f.GetError() != nil && f.GetError().GetRequestId() == id || f.GetDone() != nil && f.GetDone().GetRequestId() == id
	})
	if f.GetError() == nil {
		c.t.Fatalf("%s: done, not refused", id)
	}
	return f.GetError()
}

func (c *client) anError() *pb1.Error {
	c.t.Helper()
	return c.until("an error", func(f *pb.Frame) bool { return f.GetError() != nil }).GetError()
}

// quiet checks that no frame ok takes comes within a short while.
func (c *client) quiet(what string, ok func(*pb.Frame) bool) {
	c.t.Helper()
	for {
		f, err := c.read(150 * time.Millisecond)
		if err != nil {
			return
		}
		if ok(f) {
			c.t.Fatalf("unexpected %s: %v", what, f)
		}
	}
}

// closedWith waits for the connection to close, and returns its status.
func (c *client) closedWith() websocket.StatusCode {
	c.t.Helper()
	for {
		_, err := c.read(2 * time.Second)
		if errors.Is(err, errTimeout) {
			c.t.Fatal("not closed")
		}
		if err != nil {
			return websocket.CloseStatus(err)
		}
	}
}

var testAttestation = &pb.Attestation{Kind: &pb.Attestation_Test{Test: []byte("phone")}}

// signUp makes an account with phone as its client, and returns its ID.
func (h *harness) signUp(phone dev) []byte {
	h.t.Helper()
	c, _ := h.login(phone, nil)
	c.send(&pb.Frame{Body: &pb.Frame_SignUp{SignUp: &pb.SignUp{RequestId: "s", Attestation: testAttestation}}})
	f := c.until("SignedUp", func(f *pb.Frame) bool { return f.GetSignedUp() != nil || f.GetError() != nil })
	id := sha256.Sum256(phone.pub)
	if !bytes.Equal(f.GetSignedUp().GetAccountId(), id[:]) {
		h.t.Fatalf("signing up: %v", f)
	}
	c.ws.Close(websocket.StatusNormalClosure, "")
	return id[:]
}

// add makes d a member of the account.
func (h *harness) add(account []byte, d dev, role pb.DeviceRole) {
	h.t.Helper()
	if err := h.cfg.Store.AddMember(account, d.pub, role); err != nil {
		h.t.Fatal(err)
	}
}

func code(e *pb1.Error) pb1.ErrorCode { return e.GetCode() }

func TestLogin(t *testing.T) {
	h := newHarness(t, nil)
	phone, host := newDev(1), newDev(2)
	id := h.signUp(phone)

	if _, w := h.login(phone, id); w.Role != pb.DeviceRole_DEVICE_ROLE_CLIENT {
		t.Errorf("welcome %v", w)
	}

	// A key not a member, and an account that does not exist.
	for _, acct := range [][]byte{id, bytes.Repeat([]byte{9}, 32)} {
		_, f := h.loginAs(host, acct, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2)
		if code(f.GetError()) != pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED {
			t.Errorf("not a member: %v", f)
		}
	}
	// A member of another account.
	other := h.signUp(newDev(3))
	if _, f := h.loginAs(newDev(3), id, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2); code(f.GetError()) != pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED {
		t.Errorf("another account's member: %v", f)
	}
	// A host the account has.
	h.add(id, host, pb.DeviceRole_DEVICE_ROLE_HOST)
	if _, w := h.login(host, id); w.Role != pb.DeviceRole_DEVICE_ROLE_HOST {
		t.Errorf("host welcome %v", w)
	}
	if _, f := h.loginAs(host, other, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2); code(f.GetError()) != pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED {
		t.Errorf("a host in another account: %v", f)
	}
	// A signature for another relay, or another account.
	if _, f := h.loginAs(phone, id, "wss://other.test", pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2); code(f.GetError()) != pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED {
		t.Errorf("another origin: %v", f)
	}
	if _, f := h.loginAs(phone, nil, "wss://other.test", pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2); code(f.GetError()) != pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED {
		t.Errorf("another origin, no account: %v", f)
	}
	if _, f := h.loginAs(phone, id, origin, pb.ProtocolVersion_PROTOCOL_VERSION_UNSPECIFIED); code(f.GetError()) != pb1.ErrorCode_ERROR_CODE_VERSION_UNSUPPORTED {
		t.Errorf("no protocol version: %v", f)
	}
	// No v1alpha1 at all.
	if _, resp, err := h.dialRaw("/v1alpha1"); err == nil || resp == nil || resp.StatusCode != http.StatusNotFound {
		t.Errorf("v1alpha1: %v %v", resp, err)
	}
}

func TestSignUp(t *testing.T) {
	h := newHarness(t, nil)
	phone := newDev(1)
	want := sha256.Sum256(phone.pub)
	c, w := h.login(phone, nil)
	if w.Role != pb.DeviceRole_DEVICE_ROLE_UNSPECIFIED {
		t.Errorf("welcome without an account: %v", w)
	}
	signUp := func(id string, a *pb.Attestation) {
		c.send(&pb.Frame{Body: &pb.Frame_SignUp{SignUp: &pb.SignUp{RequestId: id, Attestation: a}}})
	}
	// Without an attestation.
	signUp("a", nil)
	if e := c.errorFor("a"); e.Code != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Errorf("no attestation: %v", e)
	}
	// Before signing up, nothing of an account.
	c.send(&pb.Frame{Body: &pb.Frame_SubscribeSessions{SubscribeSessions: &pb.SubscribeSessions{}}})
	if e := c.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Errorf("subscribing without an account: %v", e)
	}
	signUp("d", testAttestation)
	if f := c.until("SignedUp", func(f *pb.Frame) bool { return f.GetSignedUp() != nil }); !bytes.Equal(f.GetSignedUp().AccountId, want[:]) {
		t.Errorf("account ID %x", f.GetSignedUp().AccountId)
	}
	// Again, as after an answer lost: the same account.
	signUp("e", testAttestation)
	if f := c.until("SignedUp", func(f *pb.Frame) bool { return f.GetSignedUp() != nil }); f.GetSignedUp().RequestId != "e" || !bytes.Equal(f.GetSignedUp().AccountId, want[:]) {
		t.Errorf("again: %v", f)
	}
	// The phone is the account's one member, a client.
	if ms, err := h.cfg.Store.Members(want[:]); err != nil || len(ms) != 1 || !bytes.Equal(ms[0].Key, phone.pub) || ms[0].Role != pb.DeviceRole_DEVICE_ROLE_CLIENT {
		t.Errorf("members %v %v", ms, err)
	}

	// A relay without a verifier takes no sign-ups.
	h2 := newHarness(t, func(c *Config) { c.Verifier = nil })
	c2, _ := h2.login(phone, nil)
	c2.send(&pb.Frame{Body: &pb.Frame_SignUp{SignUp: &pb.SignUp{RequestId: "f", Attestation: testAttestation}}})
	if e := c2.errorFor("f"); e.Code != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Errorf("no verifier: %v", e)
	}
}

// account2 is an account with a phone, its read-only key and a host.
func account2(h *harness) (id []byte, phone, read, host dev, p, r, hc *client) {
	phone, read, host = newDev(1), newDev(2), newDev(3)
	id = h.signUp(phone)
	h.add(id, read, pb.DeviceRole_DEVICE_ROLE_READ_ONLY)
	h.add(id, host, pb.DeviceRole_DEVICE_ROLE_HOST)
	p, _ = h.login(phone, id)
	r, _ = h.login(read, id)
	hc, _ = h.login(host, id)
	return
}

func TestSessions(t *testing.T) {
	h := newHarness(t, nil)
	id, phone, _, host, p, r, hc := account2(h)
	// Another account, which must see nothing of this one.
	stranger := newDev(9)
	sc, _ := h.login(stranger, h.signUp(stranger))
	sc.send(&pb.Frame{Body: &pb.Frame_SubscribeSessions{SubscribeSessions: &pb.SubscribeSessions{}}})
	if l := sc.until("SessionList", func(f *pb.Frame) bool { return f.GetSessionList() != nil }).GetSessionList(); len(l.Sessions) != 0 {
		t.Errorf("an empty account's list: %v", l)
	}

	ref := &pb1.SessionRef{HostKey: host.pub, SessionId: "s1", InstanceId: "i1"}
	announce := func(id string) {
		hc.send(&pb.Frame{Body: &pb.Frame_SessionAnnounce{SessionAnnounce: &pb.SessionAnnounce{Session: ref, Payload: []byte("opaque " + id)}}})
	}
	// A session of another host.
	hc.send(&pb.Frame{Body: &pb.Frame_SessionAnnounce{SessionAnnounce: &pb.SessionAnnounce{Session: &pb1.SessionRef{HostKey: phone.pub, SessionId: "s1", InstanceId: "i1"}}}})
	if e := hc.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Errorf("announcing another host's session: %v", e)
	}
	announce("b")
	// An announcement has no answer: wait for the relay to have it.
	for i := 0; i < 200; i++ {
		h.srv.mu.Lock()
		n := 0
		if a := h.srv.accounts[string(id)]; a != nil {
			n = len(a.sessions)
		}
		h.srv.mu.Unlock()
		if n == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	p.send(&pb.Frame{Body: &pb.Frame_SubscribeSessions{SubscribeSessions: &pb.SubscribeSessions{}}})
	l := p.until("SessionList", func(f *pb.Frame) bool { return f.GetSessionList() != nil }).GetSessionList()
	if len(l.Sessions) != 1 || !proto.Equal(l.Sessions[0].Session, ref) || string(l.Sessions[0].Payload) != "opaque b" {
		t.Fatalf("list %v", l)
	}
	// The read-only key reads the list, and does nothing else.
	r.send(&pb.Frame{Body: &pb.Frame_SubscribeSessions{SubscribeSessions: &pb.SubscribeSessions{}}})
	if l := r.until("SessionList", func(f *pb.Frame) bool { return f.GetSessionList() != nil }).GetSessionList(); len(l.Sessions) != 1 {
		t.Errorf("read-only list %v", l)
	}
	r.send(&pb.Frame{Body: &pb.Frame_Attach{Attach: &pb.Attach{Session: ref}}})
	if e := r.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Errorf("read-only attach: %v", e)
	}
	r.send(&pb.Frame{Body: &pb.Frame_Routed{Routed: &pb.Routed{Session: ref, Payload: []byte("x")}}})
	if e := r.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Errorf("read-only routed: %v", e)
	}

	// A request: the relay names the client.
	p.send(&pb.Frame{Body: &pb.Frame_Attach{Attach: &pb.Attach{Session: ref}}})
	p.send(&pb.Frame{Body: &pb.Frame_Routed{Routed: &pb.Routed{Session: ref, ClientKey: host.pub, Payload: []byte("request")}}})
	got := hc.until("Routed", func(f *pb.Frame) bool { return f.GetRouted() != nil }).GetRouted()
	if !bytes.Equal(got.ClientKey, phone.pub) || string(got.Payload) != "request" {
		t.Errorf("host got %v", got)
	}
	// The stranger cannot reach the session.
	sc.send(&pb.Frame{Body: &pb.Frame_Routed{Routed: &pb.Routed{Session: ref, Payload: []byte("x")}}})
	if e := sc.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND {
		t.Errorf("stranger routed: %v", e)
	}
	sc.send(&pb.Frame{Body: &pb.Frame_Attach{Attach: &pb.Attach{Session: ref}}})
	if e := sc.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND {
		t.Errorf("stranger attach: %v", e)
	}

	// Broadcasts to the attached; answers to one client of the account.
	hc.send(&pb.Frame{Body: &pb.Frame_Routed{Routed: &pb.Routed{Session: ref, Payload: []byte("broadcast")}}})
	if got := p.until("Routed", func(f *pb.Frame) bool { return f.GetRouted() != nil }).GetRouted(); string(got.Payload) != "broadcast" || len(got.ClientKey) != 0 {
		t.Errorf("phone got %v", got)
	}
	hc.send(&pb.Frame{Body: &pb.Frame_Routed{Routed: &pb.Routed{Session: ref, ClientKey: stranger.pub, Payload: []byte("to the stranger")}}})
	hc.send(&pb.Frame{Body: &pb.Frame_Routed{Routed: &pb.Routed{Session: ref, ClientKey: phone.pub, Payload: []byte("answer")}}})
	if got := p.until("Routed", func(f *pb.Frame) bool { return f.GetRouted() != nil }).GetRouted(); string(got.Payload) != "answer" {
		t.Errorf("phone got %v", got)
	}
	sc.quiet("a frame of another account", func(f *pb.Frame) bool { return f.GetRouted() != nil || f.GetSessionUpdated() != nil })

	// A newer announcement replaces the stored one.
	announce("c")
	if u := p.until("SessionUpdated", func(f *pb.Frame) bool { return f.GetSessionUpdated() != nil }).GetSessionUpdated(); string(u.Entry.Payload) != "opaque c" {
		t.Errorf("updated %v", u.Entry)
	}

	// The host goes: its session ends.
	hc.ws.Close(websocket.StatusNormalClosure, "")
	if f := p.until("SessionEnded", func(f *pb.Frame) bool { return f.GetSessionEnded() != nil }); !proto.Equal(f.GetSessionEnded().Session, ref) {
		t.Errorf("ended %v", f)
	}
}

func TestJoin(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.MaxLookupsPerAccount = 4 })
	phone := newDev(1)
	p, _ := h.login(phone, h.signUp(phone))
	d, _ := h.login(newDev(5), nil)
	e, _ := h.login(newDev(6), nil)

	// JoinWait has no answer until a client pairs with it, so the test
	// looks for it on the relay before the lookup.
	wait := func(c *client, lookup string) {
		c.send(&pb.Frame{Body: &pb.Frame_JoinWait{JoinWait: &pb.JoinWait{Lookup: lookup}}})
		for i := 0; ; i++ {
			h.srv.mu.Lock()
			w := h.srv.joins.waits[lookup]
			h.srv.mu.Unlock()
			if w != nil || i == 200 {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	lookup := func(id, l string) {
		p.send(&pb.Frame{Body: &pb.Frame_JoinLookup{JoinLookup: &pb.JoinLookup{RequestId: id, Lookup: l}}})
	}
	wait(d, "K7QM")
	wait(e, "K7QM")
	if err := e.anError(); err.Code != pb1.ErrorCode_ERROR_CODE_INVALID {
		t.Errorf("the same lookup twice: %v", err)
	}
	wait(e, "K7QU")
	if err := e.anError(); err.Code != pb1.ErrorCode_ERROR_CODE_INVALID {
		t.Errorf("not Crockford: %v", err)
	}

	lookup("l1", "K7QM")
	pc := p.until("JoinPaired", func(f *pb.Frame) bool { return f.GetJoinPaired() != nil }).GetJoinPaired()
	dc := d.until("JoinPaired", func(f *pb.Frame) bool { return f.GetJoinPaired() != nil }).GetJoinPaired()
	if pc.RequestId != "l1" || pc.JoinId == "" || pc.JoinId != dc.JoinId {
		t.Fatalf("paired %v and %v", pc, dc)
	}
	// Steps pass both ways, unread.
	d.send(&pb.Frame{Body: &pb.Frame_JoinMessage{JoinMessage: &pb.JoinMessage{JoinId: dc.JoinId, Step: []byte("offer")}}})
	if m := p.until("JoinMessage", func(f *pb.Frame) bool { return f.GetJoinMessage() != nil }).GetJoinMessage(); string(m.Step) != "offer" {
		t.Errorf("client got %v", m)
	}
	p.send(&pb.Frame{Body: &pb.Frame_JoinMessage{JoinMessage: &pb.JoinMessage{JoinId: pc.JoinId, Step: []byte("answer")}}})
	if m := d.until("JoinMessage", func(f *pb.Frame) bool { return f.GetJoinMessage() != nil }).GetJoinMessage(); string(m.Step) != "answer" {
		t.Errorf("device got %v", m)
	}
	// Not a party to it.
	e.send(&pb.Frame{Body: &pb.Frame_JoinMessage{JoinMessage: &pb.JoinMessage{JoinId: pc.JoinId, Step: []byte("x")}}})
	if err := e.anError(); err.Code != pb1.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND {
		t.Errorf("a stranger's step: %v", err)
	}
	p.send(&pb.Frame{Body: &pb.Frame_JoinEnded{JoinEnded: &pb.JoinEnded{JoinId: pc.JoinId}}})
	if f := d.until("JoinEnded", func(f *pb.Frame) bool { return f.GetJoinEnded() != nil }); f.GetJoinEnded().JoinId != dc.JoinId {
		t.Errorf("ended %v", f)
	}

	// Each lookup pairs once.
	lookup("l2", "K7QM")
	if err := p.errorFor("l2"); err.Code != pb1.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND {
		t.Errorf("a lookup used: %v", err)
	}
	// A side that goes ends the join for the other.
	wait(d, "AB12")
	lookup("l3", "AB12")
	p.until("JoinPaired", func(f *pb.Frame) bool { return f.GetJoinPaired() != nil })
	d.ws.Close(websocket.StatusNormalClosure, "")
	p.until("JoinEnded", func(f *pb.Frame) bool { return f.GetJoinEnded() != nil })
	// Lookups are capped per account: this is the fourth.
	lookup("l4", "ZZZZ")
	p.errorFor("l4")
	lookup("l5", "ZZZZ")
	if err := p.errorFor("l5"); err.Code != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
		t.Errorf("past the cap: %v", err)
	}
}

func TestJoinExpires(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.JoinTimeout = 200 * time.Millisecond })
	d, _ := h.login(newDev(5), nil)
	d.send(&pb.Frame{Body: &pb.Frame_JoinWait{JoinWait: &pb.JoinWait{Lookup: "K7QM"}}})
	if err := d.anError(); err.Code != pb1.ErrorCode_ERROR_CODE_TIMEOUT {
		t.Errorf("expiry: %v", err)
	}
	// The lookup is free again.
	d.send(&pb.Frame{Body: &pb.Frame_JoinWait{JoinWait: &pb.JoinWait{Lookup: "K7QM"}}})
	if err := d.anError(); err.Code != pb1.ErrorCode_ERROR_CODE_TIMEOUT {
		t.Errorf("waiting again: %v", err)
	}
}

func TestDevicesAndPush(t *testing.T) {
	h := newHarness(t, nil)
	_, phone, read, host, p, r, hc := account2(h)
	p.send(&pb.Frame{Body: &pb.Frame_WatchDevices{WatchDevices: &pb.WatchDevices{}}})
	ds := p.until("Devices", func(f *pb.Frame) bool { return f.GetDevices() != nil }).GetDevices()
	if len(ds.Devices) != 3 {
		t.Fatalf("devices %v", ds)
	}
	for _, d := range ds.Devices {
		if !d.Online || d.Push {
			t.Errorf("device %x: %v", d.PublicKey[:4], d)
		}
	}
	p.send(&pb.Frame{Body: &pb.Frame_RegisterPush{RegisterPush: &pb.RegisterPush{RequestId: "push", Handle: "handle"}}})
	p.done("push")
	hc.send(&pb.Frame{Body: &pb.Frame_RegisterPush{RegisterPush: &pb.RegisterPush{RequestId: "hpush", Handle: "handle"}}})
	if e := hc.errorFor("hpush"); e.Code != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Errorf("a host registering for push: %v", e)
	}
	hc.ws.Close(websocket.StatusNormalClosure, "")
	r.ws.Close(websocket.StatusNormalClosure, "")
	p.until("the host offline", func(f *pb.Frame) bool {
		for _, d := range f.GetDevices().GetDevices() {
			if bytes.Equal(d.PublicKey, host.pub) && !d.Online && d.LastSeen != nil {
				return true
			}
		}
		return false
	})
	p.until("push and the read-only key offline", func(f *pb.Frame) bool {
		ok := f.GetDevices() != nil
		for _, d := range f.GetDevices().GetDevices() {
			switch {
			case bytes.Equal(d.PublicKey, phone.pub):
				ok = ok && d.Push
			case bytes.Equal(d.PublicKey, read.pub):
				ok = ok && !d.Online
			}
		}
		return ok
	})
}

func TestDeleteAccount(t *testing.T) {
	h := newHarness(t, nil)
	id, phone, _, host, p, r, hc := account2(h)
	r.send(&pb.Frame{Body: &pb.Frame_DeleteAccount{DeleteAccount: &pb.DeleteAccount{RequestId: "r"}}})
	if e := r.errorFor("r"); e.Code != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Errorf("read-only key deleting: %v", e)
	}
	p.send(&pb.Frame{Body: &pb.Frame_DeleteAccount{DeleteAccount: &pb.DeleteAccount{RequestId: "d"}}})
	p.done("d")
	for _, c := range []*client{p, hc} {
		if st := c.closedWith(); st != websocket.StatusPolicyViolation {
			t.Errorf("closed with %v", st)
		}
	}
	for _, d := range []dev{phone, host} {
		if _, f := h.loginAs(d, id, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2); code(f.GetError()) != pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED {
			t.Errorf("logging in after deletion: %v", f)
		}
	}
	// Nothing of it is left in the store.
	for _, table := range []string{"accounts", "members", "devices", "attestations", "subscriptions"} {
		var n int
		if err := h.cfg.Store.db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil || n != 0 {
			t.Errorf("%s: %d rows, %v", table, n, err)
		}
	}
	// And the same phone can sign up again, to the same account ID.
	h.signUp(phone)
}

func testLogger() *slog.Logger {
	if os.Getenv("HOSTED_TEST_LOG") != "" {
		return slog.Default()
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// The same vector as relay-client/test/hosted.test.ts and the app's
// test/framed_test.dart.
func TestFramed(t *testing.T) {
	long := bytes.Repeat([]byte{7}, 200)
	want := append([]byte{0x61, 0x62, 0, 0, 0xc8, 0x01}, long...)
	if got := framed("ab", nil, long); !bytes.Equal(got, want) {
		t.Errorf("framed = %x, want %x", got, want)
	}
}
