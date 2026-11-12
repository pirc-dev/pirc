package server

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/known/durationpb"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	"pirc.dev/relay/internal/proxy"
	"pirc.dev/relay/internal/registry"
)

type relay struct {
	t   *testing.T
	reg *registry.Registry
	srv *Server
	url string
}

func startRelay(t *testing.T, maxFrame int) *relay {
	return startRelayWith(t, func(c *Config) { c.MaxFrameBytes = maxFrame })
}

func startRelayWith(t *testing.T, configure func(*Config)) *relay {
	t.Helper()
	reg := registry.New(t.TempDir())
	cfg := Config{
		Registry:     reg,
		RegistryPoll: 20 * time.Millisecond,
		Logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	configure(&cfg)
	srv, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go srv.Run(ctx)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { cancel(); ts.Close() })
	return &relay{t: t, reg: reg, srv: srv, url: "ws" + strings.TrimPrefix(ts.URL, "http") + "/v1alpha1"}
}

// connCount is how many logged-in connections the relay holds.
func (r *relay) connCount() int {
	r.srv.mu.Lock()
	defer r.srv.mu.Unlock()
	return len(r.srv.conns)
}

func (r *relay) token(role registry.Role, label string, ttl time.Duration) string {
	r.t.Helper()
	tok, err := r.reg.IssueToken(role, label, ttl, time.Now())
	if err != nil {
		r.t.Fatal(err)
	}
	return tok
}

type peer struct {
	t    *testing.T
	ws   *websocket.Conn
	pub  ed25519.PublicKey
	priv ed25519.PrivateKey
	// Frames read by a background reader; closed with readErr set when the
	// connection ends. (A Read whose context expires closes a coder/websocket
	// connection, so tests never time out a Read directly.)
	frames  chan *pb.Frame
	readErr error
}

func newKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func (r *relay) dial(pub ed25519.PublicKey, priv ed25519.PrivateKey) *peer {
	r.t.Helper()
	return r.dialWith(pub, priv, nil)
}

// dialWith dials with these request headers.
func (r *relay) dialWith(pub ed25519.PublicKey, priv ed25519.PrivateKey, h http.Header) *peer {
	r.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, r.url, &websocket.DialOptions{HTTPHeader: h})
	if err != nil {
		r.t.Fatal(err)
	}
	ws.SetReadLimit(64 << 20)
	p := &peer{t: r.t, ws: ws, pub: pub, priv: priv, frames: make(chan *pb.Frame, 64)}
	r.t.Cleanup(func() { ws.CloseNow() })
	go func() {
		defer close(p.frames)
		for {
			_, b, err := ws.Read(context.Background())
			if err != nil {
				p.readErr = err
				return
			}
			f := &pb.Frame{}
			if err := proto.Unmarshal(b, f); err != nil {
				p.readErr = err
				return
			}
			p.frames <- f
		}
	}()
	return p
}

func (p *peer) send(f *pb.Frame) {
	p.t.Helper()
	b, err := proto.Marshal(f)
	if err != nil {
		p.t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := p.ws.Write(ctx, websocket.MessageBinary, b); err != nil {
		p.t.Fatal(err)
	}
}

// recv returns the next frame, or nil and the error when the connection ends.
func (p *peer) recvErr(timeout time.Duration) (*pb.Frame, error) {
	select {
	case f, ok := <-p.frames:
		if !ok {
			return nil, p.readErr
		}
		return f, nil
	case <-time.After(timeout):
		return nil, errTimeout
	}
}

var errTimeout = errors.New("timed out")

func (p *peer) recv() *pb.Frame {
	p.t.Helper()
	f, err := p.recvErr(5 * time.Second)
	if err != nil {
		p.t.Fatalf("recv: %v", err)
	}
	return f
}

// expectClosed reads until the connection ends, failing on a frame that is
// not an Error.
func (p *peer) expectClosed() {
	p.t.Helper()
	for {
		f, err := p.recvErr(5 * time.Second)
		if err != nil {
			if errors.Is(err, errTimeout) {
				p.t.Fatal("connection still open")
			}
			return
		}
		if f.GetError() == nil {
			p.t.Fatalf("expected the connection to close, got %v", f)
		}
	}
}

// expectNothing fails if a frame arrives within a short wait.
func (p *peer) expectNothing() {
	p.t.Helper()
	if f, err := p.recvErr(150 * time.Millisecond); err == nil {
		p.t.Fatalf("unexpected frame %v", f)
	}
}

func hello(role pb.Role, pub []byte, token, label string) *pb.Frame {
	return &pb.Frame{Body: &pb.Frame_Hello{Hello: &pb.Hello{
		ProtocolVersion:   pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA1,
		Role:              role,
		PublicKey:         pub,
		RegistrationToken: token,
		Label:             label,
		Software:          "test",
	}}}
}

// login completes a login and returns the Welcome, or the Error that ended it.
func (p *peer) login(role pb.Role, token, label string) (*pb.Welcome, *pb.Error) {
	p.t.Helper()
	p.send(hello(role, p.pub, token, label))
	f := p.recv()
	if e := f.GetError(); e != nil {
		return nil, e
	}
	ch := f.GetChallenge()
	if ch == nil {
		p.t.Fatalf("expected Challenge, got %v", f)
	}
	sig := ed25519.Sign(p.priv, append([]byte(AuthContext), ch.GetNonce()...))
	p.send(&pb.Frame{Body: &pb.Frame_Auth{Auth: &pb.Auth{Signature: sig}}})
	f = p.recv()
	if e := f.GetError(); e != nil {
		return nil, e
	}
	if f.GetWelcome() == nil {
		p.t.Fatalf("expected Welcome, got %v", f)
	}
	return f.GetWelcome(), nil
}

func (p *peer) mustLogin(role pb.Role, token, label string) {
	p.t.Helper()
	if _, e := p.login(role, token, label); e != nil {
		p.t.Fatalf("login: %v", e)
	}
}

func expectCode(t *testing.T, e *pb.Error, code pb.ErrorCode) {
	t.Helper()
	if e == nil || e.GetCode() != code {
		t.Fatalf("expected %v, got %v", code, e)
	}
}

// registered returns a peer whose key was registered with a token and who
// is logged in.
func (r *relay) registered(role registry.Role, label string) *peer {
	r.t.Helper()
	pub, priv := newKey(r.t)
	p := r.dial(pub, priv)
	pbRole := pb.Role_ROLE_CLIENT
	if role == registry.RoleHost {
		pbRole = pb.Role_ROLE_HOST
	}
	p.mustLogin(pbRole, r.token(role, label, time.Minute), "")
	return p
}

func TestRegisterThenReconnectWithoutToken(t *testing.T) {
	r := startRelay(t, 0)
	pub, priv := newKey(t)
	tok := r.token(registry.RoleHost, "desk", time.Minute)

	p := r.dial(pub, priv)
	w, e := p.login(pb.Role_ROLE_HOST, tok, "ignored")
	if e != nil {
		t.Fatal(e)
	}
	if w.GetMaxFrameBytes() == 0 || w.GetProtocolVersion() != pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA1 {
		t.Fatalf("welcome %v", w)
	}
	d, _ := r.reg.Load()
	k, ok := d.Lookup(pub)
	if !ok || k.Label != "desk" || k.Role != registry.RoleHost {
		t.Fatalf("registry %+v", d)
	}
	if len(d.Tokens) != 0 {
		t.Fatal("token not used up")
	}

	p2 := r.dial(pub, priv)
	p2.mustLogin(pb.Role_ROLE_HOST, "", "")

	// With the token it used, as a host's other process does that found the
	// token gone at the same moment: the key is known, so the token is not
	// looked at, and no request for approval is made.
	r.dial(pub, priv).mustLogin(pb.Role_ROLE_HOST, tok, "")
	if d, _ := r.reg.Load(); len(d.Requests) != 0 {
		t.Fatalf("requests %+v", d.Requests)
	}
}

func TestLoginRefusals(t *testing.T) {
	r := startRelay(t, 0)

	t.Run("unknown key without token", func(t *testing.T) {
		pub, priv := newKey(t)
		p := r.dial(pub, priv)
		_, e := p.login(pb.Role_ROLE_CLIENT, "", "")
		expectCode(t, e, pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED)
		p.expectClosed()
	})
	t.Run("used token", func(t *testing.T) {
		tok := r.token(registry.RoleClient, "", time.Minute)
		pub, priv := newKey(t)
		r.dial(pub, priv).mustLogin(pb.Role_ROLE_CLIENT, tok, "")
		pub2, priv2 := newKey(t)
		_, e := r.dial(pub2, priv2).login(pb.Role_ROLE_CLIENT, tok, "")
		expectCode(t, e, pb.ErrorCode_ERROR_CODE_TOKEN_INVALID)
	})
	t.Run("expired token", func(t *testing.T) {
		tok := r.token(registry.RoleClient, "", time.Millisecond)
		time.Sleep(5 * time.Millisecond)
		pub, priv := newKey(t)
		_, e := r.dial(pub, priv).login(pb.Role_ROLE_CLIENT, tok, "")
		expectCode(t, e, pb.ErrorCode_ERROR_CODE_TOKEN_INVALID)
	})
	t.Run("token for another role", func(t *testing.T) {
		tok := r.token(registry.RoleHost, "", time.Minute)
		pub, priv := newKey(t)
		_, e := r.dial(pub, priv).login(pb.Role_ROLE_CLIENT, tok, "")
		expectCode(t, e, pb.ErrorCode_ERROR_CODE_TOKEN_INVALID)
	})
	t.Run("registered key, other role", func(t *testing.T) {
		pub, priv := newKey(t)
		r.dial(pub, priv).mustLogin(pb.Role_ROLE_HOST, r.token(registry.RoleHost, "", time.Minute), "")
		_, e := r.dial(pub, priv).login(pb.Role_ROLE_CLIENT, "", "")
		expectCode(t, e, pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED)
	})
	t.Run("signature by another key", func(t *testing.T) {
		pub, _ := newKey(t)
		_, other := newKey(t)
		tok := r.token(registry.RoleClient, "", time.Minute)
		_, e := r.dial(pub, other).login(pb.Role_ROLE_CLIENT, tok, "")
		expectCode(t, e, pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED)
		// A failed login leaves the token usable.
		if err := r.reg.CheckToken(tok, registry.RoleClient, time.Now()); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("old protocol version", func(t *testing.T) {
		pub, priv := newKey(t)
		p := r.dial(pub, priv)
		h := hello(pb.Role_ROLE_CLIENT, pub, "", "")
		h.GetHello().ProtocolVersion = pb.ProtocolVersion_PROTOCOL_VERSION_UNSPECIFIED
		p.send(h)
		expectCode(t, p.recv().GetError(), pb.ErrorCode_ERROR_CODE_VERSION_UNSUPPORTED)
		p.expectClosed()
	})
	t.Run("frame before hello", func(t *testing.T) {
		pub, priv := newKey(t)
		p := r.dial(pub, priv)
		p.send(&pb.Frame{Body: &pb.Frame_SubscribeSessions{SubscribeSessions: &pb.SubscribeSessions{}}})
		expectCode(t, p.recv().GetError(), pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED)
		p.expectClosed()
	})
	t.Run("field too long", func(t *testing.T) {
		pub, priv := newKey(t)
		p := r.dial(pub, priv)
		_, e := p.login(pb.Role_ROLE_CLIENT, r.token(registry.RoleClient, "", time.Minute), strings.Repeat("l", registry.MaxLabelBytes+1))
		expectCode(t, e, pb.ErrorCode_ERROR_CODE_INVALID)
		p.expectClosed()
	})
	t.Run("oversized frame before login", func(t *testing.T) {
		pub, priv := newKey(t)
		p := r.dial(pub, priv)
		p.send(hello(pb.Role_ROLE_CLIENT, pub, strings.Repeat("t", loginReadLimit), ""))
		p.expectClosed()
	})
	t.Run("text frame", func(t *testing.T) {
		pub, priv := newKey(t)
		p := r.dial(pub, priv)
		p.ws.Write(context.Background(), websocket.MessageText, []byte("hi"))
		expectCode(t, p.recv().GetError(), pb.ErrorCode_ERROR_CODE_INVALID)
		p.expectClosed()
	})
}

func TestFailedLoginsLeaveNothing(t *testing.T) {
	r := startRelay(t, 0)
	pub, priv := newKey(t)
	r.dial(pub, priv).login(pb.Role_ROLE_CLIENT, "", "")
	_, other := newKey(t)
	r.dial(pub, other).login(pb.Role_ROLE_CLIENT, r.token(registry.RoleClient, "", time.Minute), "")
	time.Sleep(50 * time.Millisecond)
	if n := r.connCount(); n != 0 {
		t.Fatalf("%d connections held after failed logins", n)
	}
	if n := r.srv.pending.Load(); n != 0 {
		t.Fatalf("%d logins still counted as pending", n)
	}
}

func ref(host *peer, session, instance string) *pb.SessionRef {
	return &pb.SessionRef{HostKey: host.pub, SessionId: session, InstanceId: instance}
}

func announce(r *pb.SessionRef, payload string) *pb.Frame {
	return &pb.Frame{Body: &pb.Frame_SessionAnnounce{SessionAnnounce: &pb.SessionAnnounce{Session: r, Payload: []byte(payload)}}}
}

func subscribe() *pb.Frame {
	return &pb.Frame{Body: &pb.Frame_SubscribeSessions{SubscribeSessions: &pb.SubscribeSessions{}}}
}

func routed(r *pb.SessionRef, clientKey []byte, payload string) *pb.Frame {
	return &pb.Frame{Body: &pb.Frame_Routed{Routed: &pb.Routed{Session: r, ClientKey: clientKey, Payload: []byte(payload)}}}
}

func TestSessionListAndUpdates(t *testing.T) {
	r := startRelay(t, 0)
	host := r.registered(registry.RoleHost, "desk")
	s1 := ref(host, "s-1", "i-1")
	host.send(announce(s1, "first"))

	early := r.registered(registry.RoleClient, "phone")
	early.send(subscribe())
	list := early.recv().GetSessionList()
	if len(list.GetSessions()) != 1 {
		t.Fatalf("list %v", list)
	}
	e := list.GetSessions()[0]
	if e.GetHostLabel() != "desk" || string(e.GetPayload()) != "first" || !proto.Equal(e.GetSession(), s1) {
		t.Fatalf("entry %v", e)
	}

	host.send(announce(s1, "renamed"))
	if u := early.recv().GetSessionUpdated(); string(u.GetEntry().GetPayload()) != "renamed" {
		t.Fatalf("update %v", u)
	}

	s2 := ref(host, "s-2", "i-1")
	host.send(announce(s2, "second"))
	early.recv() // SessionUpdated for s2
	host.send(&pb.Frame{Body: &pb.Frame_SessionEnd{SessionEnd: &pb.SessionEnd{Session: s2}}})
	if ended := early.recv().GetSessionEnded(); !proto.Equal(ended.GetSession(), s2) {
		t.Fatalf("ended %v", ended)
	}

	// The host disconnecting ends its remaining sessions.
	host.ws.Close(websocket.StatusNormalClosure, "")
	if ended := early.recv().GetSessionEnded(); !proto.Equal(ended.GetSession(), s1) {
		t.Fatalf("ended %v", ended)
	}
	late := r.registered(registry.RoleClient, "laptop")
	late.send(subscribe())
	if n := len(late.recv().GetSessionList().GetSessions()); n != 0 {
		t.Fatalf("%d sessions after the host left", n)
	}
}

// The push flag is for the relay alone: clients get the announcement as
// any other, in the list and as an update.
func TestPushFlagNotPassedOn(t *testing.T) {
	r := startRelay(t, 0)
	host := r.registered(registry.RoleHost, "desk")
	client := r.registered(registry.RoleClient, "phone")
	client.send(subscribe())
	client.recv() // the empty list
	s1 := ref(host, "s-1", "i-1")
	pushed := func(payload string) *pb.Frame {
		f := announce(s1, payload)
		f.GetSessionAnnounce().Push = true
		return f
	}
	host.send(pushed("finished"))
	only := func(m proto.Message) {
		t.Helper()
		var fields []string
		m.ProtoReflect().Range(func(fd protoreflect.FieldDescriptor, _ protoreflect.Value) bool {
			fields = append(fields, string(fd.Name()))
			return true
		})
		slices.Sort(fields)
		if strings.Join(fields, ",") != "announced_at,host_label,payload,session" || len(m.ProtoReflect().GetUnknown()) > 0 {
			t.Fatalf("entry carries %v, unknown %x", fields, m.ProtoReflect().GetUnknown())
		}
	}
	u := client.recv().GetSessionUpdated()
	if string(u.GetEntry().GetPayload()) != "finished" {
		t.Fatalf("update %v", u)
	}
	only(u.GetEntry())
	late := r.registered(registry.RoleClient, "laptop")
	late.send(subscribe())
	list := late.recv().GetSessionList().GetSessions()
	if len(list) != 1 {
		t.Fatalf("list %v", list)
	}
	only(list[0])
}

func TestRouting(t *testing.T) {
	r := startRelay(t, 0)
	host := r.registered(registry.RoleHost, "desk")
	s1 := ref(host, "s-1", "i-1")
	host.send(announce(s1, ""))

	watching := r.registered(registry.RoleClient, "phone")
	idle := r.registered(registry.RoleClient, "laptop")
	watching.send(&pb.Frame{Body: &pb.Frame_Attach{Attach: &pb.Attach{Session: s1}}})
	time.Sleep(50 * time.Millisecond) // let the attach land before broadcasting

	// Client to session: the relay stamps the sender's key, whatever the
	// client put there.
	idle.send(routed(s1, []byte("spoofed"), "prompt"))
	got := host.recv().GetRouted()
	if !bytes.Equal(got.GetClientKey(), idle.pub) || string(got.GetPayload()) != "prompt" {
		t.Fatalf("host got %v", got)
	}

	// Broadcast reaches attached clients only.
	host.send(routed(s1, nil, "event"))
	if b := watching.recv().GetRouted(); string(b.GetPayload()) != "event" {
		t.Fatalf("watching got %v", b)
	}
	idle.expectNothing()

	// A reply reaches the one client, attached or not.
	host.send(routed(s1, idle.pub, "history"))
	if b := idle.recv().GetRouted(); string(b.GetPayload()) != "history" || !bytes.Equal(b.GetClientKey(), idle.pub) {
		t.Fatalf("idle got %v", b)
	}
	watching.expectNothing()

	// Detached clients stop receiving.
	watching.send(&pb.Frame{Body: &pb.Frame_Detach{Detach: &pb.Detach{Session: s1}}})
	time.Sleep(50 * time.Millisecond)
	host.send(routed(s1, nil, "event 2"))
	watching.expectNothing()

	// Unknown sessions.
	idle.send(routed(ref(host, "nope", "i-1"), nil, "x"))
	expectCode(t, idle.recv().GetError(), pb.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND)
}

func TestRolesAndOwnership(t *testing.T) {
	r := startRelay(t, 0)
	desk := r.registered(registry.RoleHost, "desk")
	other := r.registered(registry.RoleHost, "other")
	client := r.registered(registry.RoleClient, "phone")
	s1 := ref(desk, "s-1", "i-1")
	desk.send(announce(s1, ""))

	other.send(announce(s1, "hijack"))
	expectCode(t, other.recv().GetError(), pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED)

	other.send(routed(s1, nil, "impersonate"))
	expectCode(t, other.recv().GetError(), pb.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND)

	client.send(announce(&pb.SessionRef{HostKey: client.pub, SessionId: "s", InstanceId: "i"}, ""))
	expectCode(t, client.recv().GetError(), pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED)

	desk.send(subscribe())
	expectCode(t, desk.recv().GetError(), pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED)

	desk.send(announce(&pb.SessionRef{HostKey: desk.pub, SessionId: "s-2"}, ""))
	expectCode(t, desk.recv().GetError(), pb.ErrorCode_ERROR_CODE_INVALID)
}

func TestNewerConnectionTakesSessionOver(t *testing.T) {
	r := startRelay(t, 0)
	pub, priv := newKey(t)
	first := r.dial(pub, priv)
	first.mustLogin(pb.Role_ROLE_HOST, r.token(registry.RoleHost, "desk", time.Minute), "")
	s1 := &pb.SessionRef{HostKey: pub, SessionId: "s-1", InstanceId: "i-1"}
	first.send(announce(s1, ""))

	second := r.dial(pub, priv)
	second.mustLogin(pb.Role_ROLE_HOST, "", "")
	second.send(announce(s1, "again"))

	client := r.registered(registry.RoleClient, "phone")
	client.send(subscribe())
	client.recv()
	first.ws.Close(websocket.StatusNormalClosure, "")
	client.expectNothing() // the session lives on with its new connection

	client.send(routed(s1, nil, "prompt"))
	if b := second.recv().GetRouted(); string(b.GetPayload()) != "prompt" {
		t.Fatalf("second got %v", b)
	}
}

func TestRevocationDisconnects(t *testing.T) {
	r := startRelay(t, 0)
	client := r.registered(registry.RoleClient, "lost phone")
	if _, err := r.reg.Remove(registry.EncodeKey(client.pub)); err != nil {
		t.Fatal(err)
	}
	client.expectClosed()
	_, e := r.dial(client.pub, client.priv).login(pb.Role_ROLE_CLIENT, "", "")
	expectCode(t, e, pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED)
}

func TestFrameTooLarge(t *testing.T) {
	r := startRelay(t, 4096)
	host := r.registered(registry.RoleHost, "desk")
	host.send(announce(ref(host, "s-1", "i-1"), strings.Repeat("x", 8192)))
	host.expectClosed()
}

func TestHostRevocationEndsItsSessions(t *testing.T) {
	r := startRelay(t, 0)
	host := r.registered(registry.RoleHost, "desk")
	s1 := ref(host, "s-1", "i-1")
	host.send(announce(s1, ""))
	// Attached but not subscribed: still told the session ended.
	client := r.registered(registry.RoleClient, "phone")
	client.send(&pb.Frame{Body: &pb.Frame_Attach{Attach: &pb.Attach{Session: s1}}})
	time.Sleep(50 * time.Millisecond)

	if _, err := r.reg.Remove(registry.EncodeKey(host.pub)); err != nil {
		t.Fatal(err)
	}
	host.expectClosed()
	if ended := client.recv().GetSessionEnded(); !proto.Equal(ended.GetSession(), s1) {
		t.Fatalf("ended %v", ended)
	}
}

func TestRoleChangeDisconnects(t *testing.T) {
	r := startRelay(t, 0)
	client := r.registered(registry.RoleClient, "phone")
	d, err := r.reg.Load()
	if err != nil {
		t.Fatal(err)
	}
	d.Keys[0].Role = registry.RoleHost
	b, _ := json.Marshal(d)
	if err := os.WriteFile(r.reg.Path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	client.expectClosed()
}

// A key removed while its login waits on the challenge must not get in.
func TestRevokedDuringLogin(t *testing.T) {
	r := startRelay(t, 0)
	pub, priv := newKey(t)
	r.dial(pub, priv).mustLogin(pb.Role_ROLE_CLIENT, r.token(registry.RoleClient, "phone", time.Minute), "")

	p := r.dial(pub, priv)
	p.send(hello(pb.Role_ROLE_CLIENT, pub, "", ""))
	ch := p.recv().GetChallenge()
	if ch == nil {
		t.Fatal("expected Challenge")
	}
	if _, err := r.reg.Remove(registry.EncodeKey(pub)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond) // several polls
	sig := ed25519.Sign(priv, append([]byte(AuthContext), ch.GetNonce()...))
	p.send(&pb.Frame{Body: &pb.Frame_Auth{Auth: &pb.Auth{Signature: sig}}})
	expectCode(t, p.recv().GetError(), pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED)
	p.expectClosed()
}

func TestUnreadableRegistryRefusesLogins(t *testing.T) {
	r := startRelay(t, 0)
	client := r.registered(registry.RoleClient, "phone")
	good, err := os.ReadFile(r.reg.Path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(r.reg.Path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	_, e := r.dial(client.pub, client.priv).login(pb.Role_ROLE_CLIENT, "", "")
	expectCode(t, e, pb.ErrorCode_ERROR_CODE_INTERNAL)

	// Connections already in stay; logins work again once the file does.
	client.send(subscribe())
	client.recv()
	if err := os.WriteFile(r.reg.Path, good, 0o600); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	r.dial(client.pub, client.priv).mustLogin(pb.Role_ROLE_CLIENT, "", "")
}

// A peer that stops reading is dropped without holding up anyone else.
func TestSlowPeerDoesNotStallRelay(t *testing.T) {
	// Only the byte budget can drop it: the frame count is out of reach.
	r := startRelayWith(t, func(c *Config) { c.SendQueue = 1 << 16; c.SendQueueBytes = 1 << 20 })
	host := r.registered(registry.RoleHost, "desk")
	s1 := ref(host, "s-1", "i-1")
	host.send(announce(s1, ""))
	// The test peer's reader stops once 64 frames wait unread, and then
	// the socket fills.
	slow := r.registered(registry.RoleClient, "slow")
	slow.send(&pb.Frame{Body: &pb.Frame_Attach{Attach: &pb.Attach{Session: s1}}})
	other := r.registered(registry.RoleClient, "other")
	time.Sleep(50 * time.Millisecond)

	payload := strings.Repeat("x", 64<<10)
	go func() {
		for range 600 {
			if host.ws.Write(context.Background(), websocket.MessageBinary, mustMarshal(routed(s1, nil, payload))) != nil {
				return
			}
		}
	}()
	for range 10 {
		time.Sleep(200 * time.Millisecond)
		start := time.Now()
		other.send(subscribe())
		if other.recv().GetSessionList() == nil {
			t.Fatal("expected SessionList")
		}
		if d := time.Since(start); d > time.Second {
			t.Fatalf("relay stalled for %v", d)
		}
	}
	// The slow peer was dropped.
	deadline := time.Now().Add(15 * time.Second)
	for {
		if _, err := slow.recvErr(time.Second); err != nil && !errors.Is(err, errTimeout) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("slow peer still connected")
		}
	}
}

func mustMarshal(f *pb.Frame) []byte {
	b, err := proto.Marshal(f)
	if err != nil {
		panic(err)
	}
	return b
}

func TestSessionListWithinFrameLimit(t *testing.T) {
	const maxFrame = MinFrameLimit
	r := startRelay(t, maxFrame)
	host := r.registered(registry.RoleHost, "desk")
	for i := range 5 {
		host.send(announce(ref(host, fmt.Sprintf("s-%d", i), "i-1"), strings.Repeat("p", 2000)))
	}
	// An announcement that could not be listed is refused, and the
	// connection stays.
	host.send(announce(ref(host, "big", "i-1"), strings.Repeat("p", maxFrame-60)))
	expectCode(t, host.recv().GetError(), pb.ErrorCode_ERROR_CODE_TOO_LARGE)

	client := r.registered(registry.RoleClient, "phone")
	client.send(subscribe())
	total := 0
	for {
		f := client.recv()
		if n := proto.Size(f); n > maxFrame {
			t.Fatalf("frame of %d bytes, limit %d", n, maxFrame)
		}
		l := f.GetSessionList()
		total += len(l.GetSessions())
		if !l.GetMore() {
			break
		}
	}
	if total != 5 {
		t.Fatalf("%d sessions listed", total)
	}

	// A Routed that the sender's key would push over the limit is refused.
	client.send(routed(ref(host, "s-0", "i-1"), nil, strings.Repeat("e", maxFrame-80)))
	expectCode(t, client.recv().GetError(), pb.ErrorCode_ERROR_CODE_TOO_LARGE)
}

func TestSessionsPerConnection(t *testing.T) {
	r := startRelayWith(t, func(c *Config) { c.MaxSessionsPerConn = 2 })
	pub, priv := newKey(t)
	first := r.dial(pub, priv)
	first.mustLogin(pb.Role_ROLE_HOST, r.token(registry.RoleHost, "desk", time.Minute), "")
	s1, s2, s3 := ref(first, "s-1", "i-1"), ref(first, "s-2", "i-1"), ref(first, "s-3", "i-1")
	first.send(announce(s1, ""))
	first.send(announce(s2, ""))
	first.send(announce(s2, "again")) // re-announcing is not a new session
	first.send(announce(s3, ""))
	expectCode(t, first.recv().GetError(), pb.ErrorCode_ERROR_CODE_RATE_LIMITED)

	// A session taken over counts for its new connection only.
	second := r.dial(pub, priv)
	second.mustLogin(pb.Role_ROLE_HOST, "", "")
	second.send(announce(s1, ""))
	time.Sleep(50 * time.Millisecond)
	first.send(announce(s3, ""))
	first.expectNothing()
}

func TestPendingLoginLimit(t *testing.T) {
	r := startRelayWith(t, func(c *Config) { c.MaxPendingLogins = 2 })
	pub, priv := newKey(t)
	a, b := r.dial(pub, priv), r.dial(pub, priv)
	time.Sleep(50 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, r.url, nil)
	if err == nil || resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("third pending login: %v %v", resp, err)
	}
	// Logins that end, and logged-in connections, do not count.
	a.ws.CloseNow()
	b.ws.CloseNow()
	time.Sleep(50 * time.Millisecond)
	r.registered(registry.RoleClient, "phone")
	r.registered(registry.RoleClient, "laptop")
	r.registered(registry.RoleClient, "tablet")
}

func TestMalformedFramesAfterLogin(t *testing.T) {
	r := startRelay(t, 0)
	client := r.registered(registry.RoleClient, "phone")
	client.ws.Write(context.Background(), websocket.MessageBinary, []byte{0xff, 0xff, 0xff})
	expectCode(t, client.recv().GetError(), pb.ErrorCode_ERROR_CODE_INVALID)
	client.expectClosed()

	other := r.registered(registry.RoleClient, "laptop")
	other.send(&pb.Frame{Body: &pb.Frame_Attach{Attach: &pb.Attach{Session: &pb.SessionRef{HostKey: other.pub, SessionId: strings.Repeat("s", MaxIDBytes+1), InstanceId: "i"}}}})
	expectCode(t, other.recv().GetError(), pb.ErrorCode_ERROR_CODE_INVALID)

	host := r.registered(registry.RoleHost, "desk")
	s1 := ref(host, "s-1", "i-1")
	host.send(announce(s1, ""))
	host.send(routed(s1, []byte("short"), "x"))
	expectCode(t, host.recv().GetError(), pb.ErrorCode_ERROR_CODE_INVALID)
}

func TestShutdownClosesPeers(t *testing.T) {
	r := startRelay(t, 0)
	client := r.registered(registry.RoleClient, "phone")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go r.srv.Shutdown(ctx)
	_, err := client.recvErr(5 * time.Second)
	if websocket.CloseStatus(err) != websocket.StatusGoingAway {
		t.Fatalf("closed with %v", err)
	}
}

func TestConfigBounds(t *testing.T) {
	for _, n := range []int{-1, MinFrameLimit - 1, MaxFrameLimit + 1} {
		if _, err := New(Config{Registry: registry.New(t.TempDir()), MaxFrameBytes: n}); err == nil {
			t.Errorf("max frame bytes %d accepted", n)
		}
	}
}

func TestHostWithoutTokenAwaitsApproval(t *testing.T) {
	r := startRelay(t, 0)
	pub, priv := newKey(t)

	p := r.dial(pub, priv)
	_, e := p.login(pb.Role_ROLE_HOST, "", "laptop")
	expectCode(t, e, pb.ErrorCode_ERROR_CODE_APPROVAL_PENDING)
	if !strings.Contains(e.GetMessage(), registry.EncodeKey(pub)) {
		t.Fatalf("message %q does not name the key", e.GetMessage())
	}
	p.expectClosed()
	d, _ := r.reg.Load()
	q, ok := d.Requested(pub)
	if !ok || q.Label != "laptop" || q.Software != "test" || q.Remote == "" {
		t.Fatalf("request %+v", q)
	}
	if _, known := d.Lookup(pub); known {
		t.Fatal("key registered before approval")
	}

	// Asking again waits too, and keeps one request.
	_, e = r.dial(pub, priv).login(pb.Role_ROLE_HOST, "", "laptop")
	expectCode(t, e, pb.ErrorCode_ERROR_CODE_APPROVAL_PENDING)
	if d, _ := r.reg.Load(); len(d.Requests) != 1 {
		t.Fatalf("requests %+v", d.Requests)
	}

	if _, err := r.reg.Approve(registry.EncodeKey(pub), "", time.Now()); err != nil {
		t.Fatal(err)
	}
	r.dial(pub, priv).mustLogin(pb.Role_ROLE_HOST, "", "")
	if n := r.srv.pending.Load(); n != 0 {
		t.Fatalf("%d logins still counted as pending", n)
	}
}

func TestApprovalRequestRefusals(t *testing.T) {
	r := startRelay(t, 0)

	t.Run("a client without a token is refused, not held", func(t *testing.T) {
		pub, priv := newKey(t)
		_, e := r.dial(pub, priv).login(pb.Role_ROLE_CLIENT, "", "phone")
		expectCode(t, e, pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED)
		if d, _ := r.reg.Load(); len(d.Requests) != 0 {
			t.Fatalf("client request recorded: %+v", d.Requests)
		}
	})
	t.Run("a key not proved is not recorded", func(t *testing.T) {
		pub, _ := newKey(t)
		_, other := newKey(t)
		_, e := r.dial(pub, other).login(pb.Role_ROLE_HOST, "", "forged")
		expectCode(t, e, pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED)
		if d, _ := r.reg.Load(); len(d.Requests) != 0 {
			t.Fatalf("unproved request recorded: %+v", d.Requests)
		}
	})
	t.Run("past the limit", func(t *testing.T) {
		for i := 0; i < registry.MaxRequests; i++ {
			pub, priv := newKey(t)
			_, e := r.dial(pub, priv).login(pb.Role_ROLE_HOST, "", "h")
			expectCode(t, e, pb.ErrorCode_ERROR_CODE_APPROVAL_PENDING)
		}
		pub, priv := newKey(t)
		_, e := r.dial(pub, priv).login(pb.Role_ROLE_HOST, "", "h")
		expectCode(t, e, pb.ErrorCode_ERROR_CODE_RATE_LIMITED)
		// A token still enrols a host.
		r.registered(registry.RoleHost, "desk")
	})
}

func TestRequestRecordsForwardedAddress(t *testing.T) {
	h := http.Header{"X-Forwarded-For": {"203.0.113.9"}}
	for _, tc := range []struct {
		name    string
		proxies string
		want    string
	}{
		{"from a trusted proxy", "127.0.0.1", "203.0.113.9 via 127.0.0.1:"},
		{"from anyone else", "", "127.0.0.1:"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			proxies, err := proxy.Parse(tc.proxies)
			if err != nil {
				t.Fatal(err)
			}
			r := startRelayWith(t, func(c *Config) { c.TrustedProxies = proxies })
			pub, priv := newKey(t)
			_, e := r.dialWith(pub, priv, h).login(pb.Role_ROLE_HOST, "", "vps")
			expectCode(t, e, pb.ErrorCode_ERROR_CODE_APPROVAL_PENDING)
			d, _ := r.reg.Load()
			if q, _ := d.Requested(pub); !strings.HasPrefix(q.Remote, tc.want) {
				t.Fatalf("remote %q, want %q...", q.Remote, tc.want)
			}
		})
	}
}

func TestPendingLoginLimitPerAddress(t *testing.T) {
	proxies, _ := proxy.Parse("127.0.0.1")
	r := startRelayWith(t, func(c *Config) {
		c.MaxPendingLoginsPerAddr = 2
		c.TrustedProxies = proxies
	})
	pub, priv := newKey(t)
	from := func(a string) http.Header { return http.Header{"X-Forwarded-For": {a}} }
	r.dialWith(pub, priv, from("203.0.113.9"))
	r.dialWith(pub, priv, from("203.0.113.9"))
	time.Sleep(50 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, r.url, &websocket.DialOptions{HTTPHeader: from("203.0.113.9")})
	if err == nil || resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("third pending login from one address: %v %v", resp, err)
	}
	// Another address still gets in.
	host, hpriv := newKey(t)
	tok := r.token(registry.RoleHost, "vps", time.Minute)
	r.dialWith(host, hpriv, from("198.51.100.4")).mustLogin(pb.Role_ROLE_HOST, tok, "")
}

func TestHelloTimeout(t *testing.T) {
	r := startRelayWith(t, func(c *Config) { c.HelloTimeout = 100 * time.Millisecond })
	pub, priv := newKey(t)
	p := r.dial(pub, priv)
	time.Sleep(300 * time.Millisecond)
	p.expectClosed()
	if n := r.srv.pending.Load(); n != 0 {
		t.Fatalf("%d logins still counted as pending", n)
	}
}

func TestAnnouncementTooLarge(t *testing.T) {
	r := startRelayWith(t, func(c *Config) { c.MaxAnnounceBytes = 1024 })
	host := r.registered(registry.RoleHost, "laptop")
	client := r.registered(registry.RoleClient, "phone")
	client.send(subscribe())
	client.recv()
	host.send(announce(ref(host, "s-1", "i-1"), strings.Repeat("x", 1025)))
	expectCode(t, host.recv().GetError(), pb.ErrorCode_ERROR_CODE_TOO_LARGE)
	host.send(announce(ref(host, "s-1", "i-1"), strings.Repeat("x", 1024)))
	if u := client.recv().GetSessionUpdated(); u == nil {
		t.Fatal("announcement within the limit not passed on")
	}
}

func watchPending() *pb.Frame {
	return &pb.Frame{Body: &pb.Frame_WatchPendingHosts{WatchPendingHosts: &pb.WatchPendingHosts{}}}
}

// pendingLabels is the next frame, which must be PendingHosts, as the
// labels of its hosts.
func (p *peer) pendingLabels() []string {
	p.t.Helper()
	f := p.recv()
	ph := f.GetPendingHosts()
	if ph == nil {
		p.t.Fatalf("expected PendingHosts, got %v", f)
	}
	var labels []string
	for _, h := range ph.GetHosts() {
		labels = append(labels, h.GetLabel())
	}
	return labels
}

func TestClientApprovesAndRejectsHosts(t *testing.T) {
	r := startRelay(t, 0)
	client := r.registered(registry.RoleClient, "phone")
	client.send(watchPending())
	if got := client.pendingLabels(); len(got) != 0 {
		t.Fatalf("pending %v", got)
	}

	pub, priv := newKey(t)
	_, e := r.dial(pub, priv).login(pb.Role_ROLE_HOST, "", "laptop")
	expectCode(t, e, pb.ErrorCode_ERROR_CODE_APPROVAL_PENDING)
	f := client.recv()
	hosts := f.GetPendingHosts().GetHosts()
	if len(hosts) != 1 || !bytes.Equal(hosts[0].GetPublicKey(), pub) || hosts[0].GetLabel() != "laptop" ||
		hosts[0].GetSoftware() != "test" || hosts[0].GetRemote() == "" || hosts[0].GetFirstSeen() == nil {
		t.Fatalf("pending %v", f)
	}

	client.send(&pb.Frame{Body: &pb.Frame_ApproveHost{ApproveHost: &pb.ApproveHost{RequestId: "a1", PublicKey: pub, Label: "laptop"}}})
	if got := client.pendingLabels(); len(got) != 0 {
		t.Fatalf("pending after approval %v", got)
	}
	if id := client.recv().GetHostDecided().GetRequestId(); id != "a1" {
		t.Fatalf("answer %q", id)
	}
	r.dial(pub, priv).mustLogin(pb.Role_ROLE_HOST, "", "")
	if d, _ := r.reg.Load(); func() bool { k, ok := d.Lookup(pub); return !ok || k.Label != "laptop" || k.Role != registry.RoleHost }() {
		t.Fatalf("registered %+v", d.Keys)
	}

	// Rejected, a host is dropped, and asks again the next time.
	pub2, priv2 := newKey(t)
	_, e = r.dial(pub2, priv2).login(pb.Role_ROLE_HOST, "", "stranger")
	expectCode(t, e, pb.ErrorCode_ERROR_CODE_APPROVAL_PENDING)
	if got := client.pendingLabels(); len(got) != 1 || got[0] != "stranger" {
		t.Fatalf("pending %v", got)
	}
	client.send(&pb.Frame{Body: &pb.Frame_RejectHost{RejectHost: &pb.RejectHost{RequestId: "r1", PublicKey: pub2}}})
	if got := client.pendingLabels(); len(got) != 0 {
		t.Fatalf("pending after rejection %v", got)
	}
	if id := client.recv().GetHostDecided().GetRequestId(); id != "r1" {
		t.Fatalf("answer %q", id)
	}
	if d, _ := r.reg.Load(); len(d.Requests) != 0 || func() bool { _, ok := d.Lookup(pub2); return ok }() {
		t.Fatalf("after rejection %+v", d)
	}

	// No such request: an error that names the request.
	client.send(&pb.Frame{Body: &pb.Frame_ApproveHost{ApproveHost: &pb.ApproveHost{RequestId: "a2", PublicKey: pub2}}})
	e = client.recv().GetError()
	expectCode(t, e, pb.ErrorCode_ERROR_CODE_INVALID)
	if e.GetRequestId() != "a2" {
		t.Fatalf("error %v", e)
	}
	client.send(&pb.Frame{Body: &pb.Frame_RejectHost{RejectHost: &pb.RejectHost{PublicKey: pub2}}})
	expectCode(t, client.recv().GetError(), pb.ErrorCode_ERROR_CODE_INVALID)
}

func TestHostsCannotDecideOnHosts(t *testing.T) {
	r := startRelay(t, 0)
	host := r.registered(registry.RoleHost, "laptop")
	pub, _ := newKey(t)
	for _, f := range []*pb.Frame{
		watchPending(),
		{Body: &pb.Frame_ApproveHost{ApproveHost: &pb.ApproveHost{RequestId: "x", PublicKey: pub}}},
		{Body: &pb.Frame_RejectHost{RejectHost: &pb.RejectHost{RequestId: "x", PublicKey: pub}}},
	} {
		host.send(f)
		expectCode(t, host.recv().GetError(), pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED)
	}
}

func TestPendingRequestExpiringIsSent(t *testing.T) {
	now := time.Now()
	var mu sync.Mutex
	r := startRelayWith(t, func(c *Config) {
		c.Now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	})
	client := r.registered(registry.RoleClient, "phone")
	pub, priv := newKey(t)
	_, e := r.dial(pub, priv).login(pb.Role_ROLE_HOST, "", "laptop")
	expectCode(t, e, pb.ErrorCode_ERROR_CODE_APPROVAL_PENDING)
	client.send(watchPending())
	if got := client.pendingLabels(); len(got) != 1 {
		t.Fatalf("pending %v", got)
	}
	mu.Lock()
	now = now.Add(registry.RequestTTL)
	mu.Unlock()
	if got := client.pendingLabels(); len(got) != 0 {
		t.Fatalf("pending after expiry %v", got)
	}
}

// next reads frames until one satisfies ok, skipping the others.
func (p *peer) next(ok func(*pb.Frame) bool) *pb.Frame {
	p.t.Helper()
	for {
		if f := p.recv(); ok(f) {
			return f
		}
	}
}

// keysWhere reads frames until a Keys list satisfies ok.
func (p *peer) keysWhere(ok func(map[string]*pb.RegisteredKey) bool) map[string]*pb.RegisteredKey {
	p.t.Helper()
	for {
		f := p.next(func(f *pb.Frame) bool { return f.GetKeys() != nil })
		byLabel := map[string]*pb.RegisteredKey{}
		for _, k := range f.GetKeys().GetKeys() {
			byLabel[k.GetLabel()] = k
		}
		if ok(byLabel) {
			return byLabel
		}
	}
}

func TestClientWatchesAndRenamesKeys(t *testing.T) {
	r := startRelay(t, 0)
	client := r.registered(registry.RoleClient, "phone")
	client.send(&pb.Frame{Body: &pb.Frame_WatchKeys{WatchKeys: &pb.WatchKeys{}}})
	keys := client.keysWhere(func(map[string]*pb.RegisteredKey) bool { return true })
	if k := keys["phone"]; len(keys) != 1 || k.GetRole() != pb.Role_ROLE_CLIENT || !k.GetOnline() || k.GetAddedAt() == nil || !bytes.Equal(k.GetPublicKey(), client.pub) {
		t.Fatalf("keys %v", keys)
	}

	// A host enrolling and logging in is sent, online.
	host := r.registered(registry.RoleHost, "desk")
	client.keysWhere(func(m map[string]*pb.RegisteredKey) bool {
		k := m["desk"]
		return k != nil && k.GetOnline() && k.GetRole() == pb.Role_ROLE_HOST
	})
	s1 := ref(host, "s-1", "i-1")
	// Subscribed first: the relay reads each connection on its own, so an
	// announcement sent just before could come after.
	client.send(subscribe())
	client.next(func(f *pb.Frame) bool { return f.GetSessionList() != nil })
	host.send(announce(s1, "first"))
	if e := client.next(func(f *pb.Frame) bool { return f.GetSessionUpdated() != nil }).GetSessionUpdated().GetEntry(); e.GetHostLabel() != "desk" {
		t.Fatalf("update %v", e)
	}

	// Renamed: the list, the host's live session under the new name, then
	// the answer.
	client.send(&pb.Frame{Body: &pb.Frame_RenameKey{RenameKey: &pb.RenameKey{RequestId: "n1", PublicKey: host.pub, Label: "attic"}}})
	var renamed, updated bool
	for {
		f := client.recv()
		switch {
		case f.GetKeys() != nil:
			for _, k := range f.GetKeys().GetKeys() {
				renamed = renamed || k.GetLabel() == "attic" && bytes.Equal(k.GetPublicKey(), host.pub)
			}
			continue
		case f.GetSessionUpdated() != nil:
			if u := f.GetSessionUpdated().GetEntry(); u.GetHostLabel() != "attic" || string(u.GetPayload()) != "first" {
				t.Fatalf("update %v", u)
			}
			updated = true
			continue
		}
		if id := f.GetKeyChanged().GetRequestId(); id != "n1" || !renamed || !updated {
			t.Fatalf("answer %v, renamed %v, updated %v", f, renamed, updated)
		}
		break
	}
	// A session announced after it is under the new name too.
	host.send(announce(ref(host, "s-2", "i-1"), "second"))
	if u := client.next(func(f *pb.Frame) bool { return f.GetSessionUpdated() != nil }).GetSessionUpdated().GetEntry(); u.GetHostLabel() != "attic" {
		t.Fatalf("update %v", u)
	}

	// Renamed on the command line: seen on the relay's next reading.
	if _, err := r.reg.Rename(registry.EncodeKey(host.pub), "cellar"); err != nil {
		t.Fatal(err)
	}
	// The session goes out under it before the list.
	if u := client.next(func(f *pb.Frame) bool { return f.GetSessionUpdated() != nil }).GetSessionUpdated().GetEntry(); u.GetHostLabel() != "cellar" {
		t.Fatalf("update %v", u)
	}
	client.keysWhere(func(m map[string]*pb.RegisteredKey) bool { return m["cellar"] != nil })

	// Gone offline: sent again.
	host.ws.Close(websocket.StatusNormalClosure, "")
	client.keysWhere(func(m map[string]*pb.RegisteredKey) bool { return m["cellar"] != nil && !m["cellar"].GetOnline() })

	// Refusals name the request.
	stranger, _ := newKey(t)
	for _, rk := range []*pb.RenameKey{
		{RequestId: "n2", PublicKey: stranger, Label: "x"},
		{RequestId: "n3", PublicKey: host.pub, Label: ""},
		{RequestId: "n4", PublicKey: host.pub, Label: strings.Repeat("x", registry.MaxLabelBytes+1)},
		{RequestId: "n5", PublicKey: host.pub[:8], Label: "x"},
	} {
		client.send(&pb.Frame{Body: &pb.Frame_RenameKey{RenameKey: rk}})
		e := client.next(func(f *pb.Frame) bool { return f.GetError() != nil }).GetError()
		expectCode(t, e, pb.ErrorCode_ERROR_CODE_INVALID)
		if e.GetRequestId() != rk.GetRequestId() {
			t.Fatalf("error %v for %s", e, rk.GetRequestId())
		}
	}
}

func TestClientRemovesKeys(t *testing.T) {
	r := startRelay(t, 0)
	client := r.registered(registry.RoleClient, "phone")
	other := r.registered(registry.RoleClient, "tablet")
	host := r.registered(registry.RoleHost, "desk")
	host.send(announce(ref(host, "s-1", "i-1"), "first"))
	client.send(&pb.Frame{Body: &pb.Frame_WatchKeys{WatchKeys: &pb.WatchKeys{}}})
	client.keysWhere(func(m map[string]*pb.RegisteredKey) bool { return m["desk"] != nil && m["desk"].GetOnline() })
	client.send(subscribe())
	client.next(func(f *pb.Frame) bool { return len(f.GetSessionList().GetSessions()) == 1 })
	registered := func(pub []byte) bool {
		d, err := r.reg.Load()
		if err != nil {
			t.Fatal(err)
		}
		_, ok := d.Lookup(pub)
		return ok
	}

	// Removed: the host is closed as revoked, its session ends, the list
	// goes out without it, then the answer.
	client.send(&pb.Frame{Body: &pb.Frame_RemoveKey{RemoveKey: &pb.RemoveKey{RequestId: "r1", PublicKey: host.pub}}})
	var ended, listed bool
	for {
		f := client.recv()
		switch {
		case f.GetSessionEnded() != nil:
			ended = true
			continue
		case f.GetKeys() != nil:
			listed = true
			for _, k := range f.GetKeys().GetKeys() {
				if bytes.Equal(k.GetPublicKey(), host.pub) {
					t.Fatalf("still listed: %v", k)
				}
			}
			continue
		}
		if f.GetKeyChanged().GetRequestId() != "r1" || !listed {
			t.Fatalf("answer %v, listed %v", f, listed)
		}
		break
	}
	_, err := host.recvErr(5 * time.Second)
	if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("host closed with %v", err)
	}
	if !ended {
		client.next(func(f *pb.Frame) bool { return f.GetSessionEnded() != nil })
	}
	if registered(host.pub) {
		t.Fatal("host still registered")
	}

	// Another client may be removed; this one may not remove itself, and
	// a key not registered is refused.
	client.send(&pb.Frame{Body: &pb.Frame_RemoveKey{RemoveKey: &pb.RemoveKey{RequestId: "r2", PublicKey: other.pub}}})
	if f := client.next(func(f *pb.Frame) bool { return f.GetKeyChanged() != nil }); f.GetKeyChanged().GetRequestId() != "r2" {
		t.Fatalf("answer %v", f)
	}
	other.expectClosed()
	stranger, _ := newKey(t)
	for _, c := range []struct {
		rk   *pb.RemoveKey
		code pb.ErrorCode
	}{
		{&pb.RemoveKey{RequestId: "r3", PublicKey: client.pub}, pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED},
		{&pb.RemoveKey{RequestId: "r4", PublicKey: stranger}, pb.ErrorCode_ERROR_CODE_INVALID},
		{&pb.RemoveKey{RequestId: "r5", PublicKey: client.pub[:8]}, pb.ErrorCode_ERROR_CODE_INVALID},
	} {
		client.send(&pb.Frame{Body: &pb.Frame_RemoveKey{RemoveKey: c.rk}})
		e := client.next(func(f *pb.Frame) bool { return f.GetError() != nil }).GetError()
		expectCode(t, e, c.code)
		if e.GetRequestId() != c.rk.GetRequestId() {
			t.Fatalf("error %v for %s", e, c.rk.GetRequestId())
		}
	}
	if !registered(client.pub) {
		t.Fatal("client removed itself")
	}
}

func TestClientIssuesTokens(t *testing.T) {
	r := startRelay(t, 0)
	client := r.registered(registry.RoleClient, "phone")
	issue := func(it *pb.IssueToken) *pb.Frame {
		client.send(&pb.Frame{Body: &pb.Frame_IssueToken{IssueToken: it}})
		return client.next(func(f *pb.Frame) bool { return f.GetTokenIssued() != nil || f.GetError() != nil })
	}

	// A host's, for 15 minutes unless asked otherwise, registers a host
	// under its label.
	before := time.Now()
	ti := issue(&pb.IssueToken{RequestId: "t1", Role: pb.Role_ROLE_HOST, Label: "attic"}).GetTokenIssued()
	if ti.GetRequestId() != "t1" || ti.GetToken() == "" {
		t.Fatalf("issued %v", ti)
	}
	if left := ti.GetExpiresAt().AsTime().Sub(before); left < 15*time.Minute || left > 15*time.Minute+time.Minute {
		t.Fatalf("valid for %v", left)
	}
	pub, priv := newKey(t)
	host := r.dial(pub, priv)
	host.mustLogin(pb.Role_ROLE_HOST, ti.GetToken(), "laptop")
	d, _ := r.reg.Load()
	if k, ok := d.Lookup(pub); !ok || k.Label != "attic" || k.Role != registry.RoleHost {
		t.Fatalf("registered %v %v", k, ok)
	}

	// A client's, for an hour, does not register a host.
	ti = issue(&pb.IssueToken{RequestId: "t2", Role: pb.Role_ROLE_CLIENT, Lifetime: durationpb.New(time.Hour)}).GetTokenIssued()
	if left := time.Until(ti.GetExpiresAt().AsTime()); left < 59*time.Minute || left > time.Hour {
		t.Fatalf("valid for %v", left)
	}
	if err := r.reg.CheckToken(ti.GetToken(), registry.RoleClient, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := r.reg.CheckToken(ti.GetToken(), registry.RoleHost, time.Now()); err == nil {
		t.Fatal("a client's token passes for a host's")
	}

	// Refusals name the request.
	for _, it := range []*pb.IssueToken{
		{RequestId: "t3"},
		{RequestId: "t4", Role: pb.Role_ROLE_HOST, Label: strings.Repeat("x", registry.MaxLabelBytes+1)},
		{RequestId: "t5", Role: pb.Role_ROLE_HOST, Lifetime: durationpb.New(25 * time.Hour)},
		{RequestId: "t6", Role: pb.Role_ROLE_HOST, Lifetime: durationpb.New(0)},
	} {
		e := issue(it).GetError()
		expectCode(t, e, pb.ErrorCode_ERROR_CODE_INVALID)
		if e.GetRequestId() != it.GetRequestId() {
			t.Fatalf("error %v for %s", e, it.GetRequestId())
		}
	}
}

func TestHostsCannotWatchOrRenameKeys(t *testing.T) {
	r := startRelay(t, 0)
	host := r.registered(registry.RoleHost, "laptop")
	for _, f := range []*pb.Frame{
		{Body: &pb.Frame_WatchKeys{WatchKeys: &pb.WatchKeys{}}},
		{Body: &pb.Frame_RenameKey{RenameKey: &pb.RenameKey{RequestId: "x", PublicKey: host.pub, Label: "y"}}},
		{Body: &pb.Frame_RemoveKey{RemoveKey: &pb.RemoveKey{RequestId: "x", PublicKey: host.pub}}},
		{Body: &pb.Frame_IssueToken{IssueToken: &pb.IssueToken{RequestId: "x", Role: pb.Role_ROLE_HOST}}},
	} {
		host.send(f)
		expectCode(t, host.recv().GetError(), pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED)
	}
}

func TestClientRegistersForPush(t *testing.T) {
	r := startRelay(t, 0)
	phone := r.registered(registry.RoleClient, "phone")
	laptop := r.registered(registry.RoleClient, "laptop")
	laptop.send(&pb.Frame{Body: &pb.Frame_WatchKeys{WatchKeys: &pb.WatchKeys{}}})
	laptop.keysWhere(func(m map[string]*pb.RegisteredKey) bool { return m["phone"] != nil && !m["phone"].GetPush() })
	answer := func(p *peer, f *pb.Frame) *pb.Frame {
		p.send(f)
		return p.next(func(f *pb.Frame) bool { return f.GetPushChanged() != nil || f.GetError() != nil })
	}
	register := func(p *peer, id, handle string) *pb.Frame {
		return answer(p, &pb.Frame{Body: &pb.Frame_RegisterPush{RegisterPush: &pb.RegisterPush{RequestId: id, Handle: handle}}})
	}
	handle := func() string {
		d, _ := r.reg.Load()
		k, _ := d.Lookup(phone.pub)
		return k.PushHandle
	}

	// Registered, the list says so; again, the handle is replaced.
	if f := register(phone, "p1", "h-one"); f.GetPushChanged().GetRequestId() != "p1" {
		t.Fatalf("answer %v", f)
	}
	if handle() != "h-one" {
		t.Fatalf("stored %q", handle())
	}
	laptop.keysWhere(func(m map[string]*pb.RegisteredKey) bool { return m["phone"].GetPush() && !m["laptop"].GetPush() })
	register(phone, "p2", "h-two")
	if handle() != "h-two" {
		t.Fatalf("stored %q", handle())
	}

	// Refused: no handle, one too long, from a host.
	for _, h := range []string{"", strings.Repeat("h", registry.MaxPushHandleBytes+1)} {
		if e := register(phone, "p3", h).GetError(); e.GetCode() != pb.ErrorCode_ERROR_CODE_INVALID || e.GetRequestId() != "p3" {
			t.Fatalf("handle of %d bytes: %v", len(h), e)
		}
	}
	host := r.registered(registry.RoleHost, "desk")
	if e := register(host, "p4", "h").GetError(); e.GetCode() != pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Fatalf("host: %v", e)
	}
	if handle() != "h-two" {
		t.Fatalf("stored %q after refusals", handle())
	}

	// Unregistered, also when it was not.
	for _, id := range []string{"u1", "u2"} {
		if f := answer(phone, &pb.Frame{Body: &pb.Frame_UnregisterPush{UnregisterPush: &pb.UnregisterPush{RequestId: id}}}); f.GetPushChanged().GetRequestId() != id {
			t.Fatalf("answer %v", f)
		}
	}
	if handle() != "" {
		t.Fatalf("stored %q after unregistering", handle())
	}
	laptop.keysWhere(func(m map[string]*pb.RegisteredKey) bool { return !m["phone"].GetPush() })
}

// The registration goes with the key: the same key enrolled again is not
// registered.
func TestRemovingAKeyDeletesItsPush(t *testing.T) {
	r := startRelay(t, 0)
	pub, priv := newKey(t)
	phone := r.dial(pub, priv)
	phone.mustLogin(pb.Role_ROLE_CLIENT, r.token(registry.RoleClient, "phone", time.Minute), "")
	phone.send(&pb.Frame{Body: &pb.Frame_RegisterPush{RegisterPush: &pb.RegisterPush{RequestId: "p1", Handle: "h"}}})
	phone.next(func(f *pb.Frame) bool { return f.GetPushChanged() != nil })
	laptop := r.registered(registry.RoleClient, "laptop")
	laptop.send(&pb.Frame{Body: &pb.Frame_RemoveKey{RemoveKey: &pb.RemoveKey{RequestId: "r1", PublicKey: pub}}})
	laptop.next(func(f *pb.Frame) bool { return f.GetKeyChanged() != nil })

	again := r.dial(pub, priv)
	again.mustLogin(pb.Role_ROLE_CLIENT, r.token(registry.RoleClient, "phone", time.Minute), "")
	d, _ := r.reg.Load()
	if k, ok := d.Lookup(pub); !ok || k.PushHandle != "" {
		t.Fatalf("enrolled again: %+v %v", k, ok)
	}
}

func TestPushKeptAcrossARestart(t *testing.T) {
	r := startRelay(t, 0)
	phone := r.registered(registry.RoleClient, "phone")
	phone.send(&pb.Frame{Body: &pb.Frame_RegisterPush{RegisterPush: &pb.RegisterPush{RequestId: "p1", Handle: "h"}}})
	phone.next(func(f *pb.Frame) bool { return f.GetPushChanged() != nil })

	// Another relay on the same data.
	restarted := startRelayWith(t, func(c *Config) { c.Registry = r.reg })
	watcher := restarted.dial(phone.pub, phone.priv)
	watcher.mustLogin(pb.Role_ROLE_CLIENT, "", "")
	watcher.send(&pb.Frame{Body: &pb.Frame_WatchKeys{WatchKeys: &pb.WatchKeys{}}})
	watcher.keysWhere(func(m map[string]*pb.RegisteredKey) bool { return m["phone"].GetPush() })
}

func registerReadKey(p *peer, id string, pub []byte) *pb.Frame {
	p.send(&pb.Frame{Body: &pb.Frame_RegisterReadKey{RegisterReadKey: &pb.RegisterReadKey{RequestId: id, PublicKey: pub}}})
	return p.next(func(f *pb.Frame) bool { return f.GetKeyChanged() != nil || f.GetError() != nil })
}

// A client's read-only key reads the session list and nothing else; it is
// replaced by another, and goes with the client.
func TestReadOnlyKey(t *testing.T) {
	r := startRelay(t, 0)
	phone := r.registered(registry.RoleClient, "phone")
	laptop := r.registered(registry.RoleClient, "laptop")
	host := r.registered(registry.RoleHost, "desk")
	s1 := ref(host, "s-1", "i-1")
	host.send(announce(s1, "first"))
	laptop.send(&pb.Frame{Body: &pb.Frame_WatchKeys{WatchKeys: &pb.WatchKeys{}}})
	laptop.keysWhere(func(m map[string]*pb.RegisteredKey) bool { return m["phone"] != nil && !m["phone"].GetReadKey() })

	readPub, readPriv := newKey(t)
	if f := registerReadKey(phone, "k1", readPub); f.GetKeyChanged().GetRequestId() != "k1" {
		t.Fatalf("answer %v", f)
	}
	keys := laptop.keysWhere(func(m map[string]*pb.RegisteredKey) bool { return m["phone"].GetReadKey() })
	if len(keys) != 3 {
		t.Fatalf("listed apart: %v", keys)
	}

	// Logged in without a token, said to be read-only.
	read := r.dial(readPub, readPriv)
	w, e := read.login(pb.Role_ROLE_CLIENT, "", "")
	if e != nil || !w.GetReadOnly() {
		t.Fatalf("welcome %v, error %v", w, e)
	}
	// Not listed, nor counting as the phone online: the list is unchanged.
	laptop.expectNothing()

	// The list, and its changes.
	read.send(subscribe())
	if n := len(read.recv().GetSessionList().GetSessions()); n != 1 {
		t.Fatalf("%d sessions", n)
	}
	host.send(announce(s1, "second"))
	if u := read.recv().GetSessionUpdated(); string(u.GetEntry().GetPayload()) != "second" {
		t.Fatalf("update %v", u)
	}

	// Nothing else, the connection staying open.
	for _, f := range []*pb.Frame{
		{Body: &pb.Frame_Attach{Attach: &pb.Attach{Session: s1}}},
		routed(s1, nil, "prompt"),
		{Body: &pb.Frame_WatchKeys{WatchKeys: &pb.WatchKeys{}}},
		{Body: &pb.Frame_WatchPendingHosts{WatchPendingHosts: &pb.WatchPendingHosts{}}},
		{Body: &pb.Frame_RegisterPush{RegisterPush: &pb.RegisterPush{RequestId: "p", Handle: "h"}}},
		{Body: &pb.Frame_RegisterReadKey{RegisterReadKey: &pb.RegisterReadKey{RequestId: "k", PublicKey: readPub}}},
		{Body: &pb.Frame_IssueToken{IssueToken: &pb.IssueToken{RequestId: "t", Role: pb.Role_ROLE_HOST}}},
		{Body: &pb.Frame_RemoveKey{RemoveKey: &pb.RemoveKey{RequestId: "r", PublicKey: laptop.pub}}},
	} {
		read.send(f)
		expectCode(t, read.recv().GetError(), pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED)
	}
	host.send(routed(s1, nil, "event"))
	read.expectNothing()

	// Replaced: the old one is revoked, the new one logs in.
	newPub, newPriv := newKey(t)
	registerReadKey(phone, "k2", newPub)
	if _, err := read.recvErr(5 * time.Second); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("old read-only key closed with %v", err)
	}
	if _, e := r.dial(readPub, readPriv).login(pb.Role_ROLE_CLIENT, "", ""); e == nil {
		t.Fatal("the old read-only key still logs in")
	}
	again := r.dial(newPub, newPriv)
	again.mustLogin(pb.Role_ROLE_CLIENT, "", "")

	// Removed with the client.
	laptop.send(&pb.Frame{Body: &pb.Frame_RemoveKey{RemoveKey: &pb.RemoveKey{RequestId: "r1", PublicKey: phone.pub}}})
	if _, err := again.recvErr(5 * time.Second); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("read-only key closed with %v", err)
	}
	d, _ := r.reg.Load()
	if _, ok := d.LookupRead(newPub); ok {
		t.Fatal("read-only key kept after its client was removed")
	}
}

// A read-only key is no other registered key, either way round: a login
// with it would be ambiguous.
func TestReadOnlyKeyIsNoOtherKey(t *testing.T) {
	r := startRelay(t, 0)
	phone := r.registered(registry.RoleClient, "phone")
	laptop := r.registered(registry.RoleClient, "laptop")
	host := r.registered(registry.RoleHost, "desk")
	laptopRead, _ := newKey(t)
	registerReadKey(laptop, "k0", laptopRead)

	// RegisterReadKey: not the client's own key, another client's, a
	// host's, or another client's read-only key.
	for _, pub := range [][]byte{phone.pub, laptop.pub, host.pub, laptopRead} {
		e := registerReadKey(phone, "k1", pub).GetError()
		if e.GetCode() != pb.ErrorCode_ERROR_CODE_INVALID || e.GetRequestId() != "k1" {
			t.Fatalf("%x: %v", pub[:4], e)
		}
	}
	if e := registerReadKey(phone, "k2", []byte("short")).GetError(); e.GetCode() != pb.ErrorCode_ERROR_CODE_INVALID {
		t.Fatalf("short key: %v", e)
	}
	expectCode(t, registerReadKey(host, "k3", laptopRead).GetError(), pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED)
	// Registering the same one again is no change.
	if f := registerReadKey(laptop, "k4", laptopRead); f.GetKeyChanged() == nil {
		t.Fatalf("again: %v", f)
	}

	// The other way: a read-only key enrolled with a token, as a client or
	// a host, or asking as a host without one, is refused, and nothing is
	// registered or requested.
	readPub, readPriv := newKey(t)
	registerReadKey(phone, "k5", readPub)
	for _, try := range []struct {
		role  pb.Role
		token string
	}{
		{pb.Role_ROLE_CLIENT, r.token(registry.RoleClient, "sneaky", time.Minute)},
		{pb.Role_ROLE_HOST, r.token(registry.RoleHost, "sneaky", time.Minute)},
		{pb.Role_ROLE_HOST, ""},
	} {
		_, e := r.dial(readPub, readPriv).login(try.role, try.token, "sneaky")
		expectCode(t, e, pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED)
	}
	d, _ := r.reg.Load()
	if _, ok := d.Lookup(readPub); ok {
		t.Fatal("registered as a key of its own")
	}
	if len(d.Pending(time.Now())) != 0 {
		t.Fatal("requested approval")
	}

	// A host that asked before its key became a read-only key is not
	// approved.
	askPub, askPriv := newKey(t)
	_, e := r.dial(askPub, askPriv).login(pb.Role_ROLE_HOST, "", "attic")
	expectCode(t, e, pb.ErrorCode_ERROR_CODE_APPROVAL_PENDING)
	registerReadKey(phone, "k6", askPub)
	phone.send(&pb.Frame{Body: &pb.Frame_ApproveHost{ApproveHost: &pb.ApproveHost{RequestId: "a1", PublicKey: askPub}}})
	e = phone.next(func(f *pb.Frame) bool { return f.GetHostDecided() != nil || f.GetError() != nil }).GetError()
	if e.GetCode() != pb.ErrorCode_ERROR_CODE_INVALID || e.GetRequestId() != "a1" {
		t.Fatalf("approved: %v", e)
	}
}

// Closed to hosts, the relay admits only hosts with a token from its
// operator: none asks for approval, and clients get no host tokens.
func TestClosedToHosts(t *testing.T) {
	r := startRelayWith(t, func(c *Config) { c.ClosedToHosts = true })
	pub, priv := newKey(t)
	_, e := r.dial(pub, priv).login(pb.Role_ROLE_HOST, "", "laptop")
	expectCode(t, e, pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED)
	if d, _ := r.reg.Load(); len(d.Requests) != 0 {
		t.Fatalf("a request recorded: %+v", d.Requests)
	}

	client := r.registered(registry.RoleClient, "phone")
	client.send(&pb.Frame{Body: &pb.Frame_IssueToken{IssueToken: &pb.IssueToken{RequestId: "t1", Role: pb.Role_ROLE_HOST}}})
	e = client.next(func(f *pb.Frame) bool { return f.GetTokenIssued() != nil || f.GetError() != nil }).GetError()
	expectCode(t, e, pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED)
	client.send(&pb.Frame{Body: &pb.Frame_IssueToken{IssueToken: &pb.IssueToken{RequestId: "t2", Role: pb.Role_ROLE_CLIENT}}})
	if client.next(func(f *pb.Frame) bool { return f.GetTokenIssued() != nil || f.GetError() != nil }).GetTokenIssued() == nil {
		t.Fatal("a client token refused")
	}

	// The operator's token still admits a host.
	tok, _ := r.reg.IssueToken(registry.RoleHost, "demo", time.Minute, time.Now())
	pub, priv = newKey(t)
	if _, e := r.dial(pub, priv).login(pb.Role_ROLE_HOST, tok, "demo"); e != nil {
		t.Fatalf("operator's token: %v", e)
	}
}
