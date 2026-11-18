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
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	"pirc.dev/relay/internal/e2e"
	pb1 "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

const origin = "wss://relay.test"

// The time devices were added and pre-keys made, and the relay's clock.
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

func sign(kind string, account []byte, d dev, body proto.Message) *pb.SignedObject {
	b, err := proto.Marshal(body)
	if err != nil {
		panic(err)
	}
	return &pb.SignedObject{Body: b, Signer: d.pub, Signature: ed25519.Sign(d.priv, e2e.Framed("pirc-e2e-v1 "+kind, account, b))}
}

func device(role pb.DeviceRole, d dev, by []byte, owner []byte) *pb.Device {
	return &pb.Device{Role: role, PublicKey: d.pub, AddedBy: by, AddedAt: timestamppb.New(t0), Owner: owner}
}

// chain builds an account's versions as its clients sign them.
type chain struct {
	id       []byte
	versions []*pb.SignedObject
	bodies   []*pb.ListVersionBody
}

func newChain(first dev) *chain {
	body := &pb.ListVersionBody{Number: 1, Devices: []*pb.Device{device(pb.DeviceRole_DEVICE_ROLE_CLIENT, first, nil, nil)}, Signer: first.pub}
	obj := sign("list", nil, first, body)
	h := sha256.Sum256(obj.Body)
	return &chain{id: h[:], versions: []*pb.SignedObject{obj}, bodies: []*pb.ListVersionBody{body}}
}

func (c *chain) latest() *pb.ListVersionBody { return c.bodies[len(c.bodies)-1] }

func (c *chain) ref(n int) *pb.VersionRef {
	h := sha256.Sum256(c.versions[n-1].Body)
	return &pb.VersionRef{Number: uint64(n), Hash: h[:]}
}

// next is the version after the latest, signed by signer, with devices
// added and keys removed; it is not added to the chain until take.
func (c *chain) next(signer dev, add []*pb.Device, remove ...dev) *pb.SignedObject {
	prev := c.latest()
	var ds []*pb.Device
	for _, d := range prev.Devices {
		gone := false
		for _, r := range remove {
			gone = gone || bytes.Equal(d.PublicKey, r.pub)
		}
		if !gone {
			ds = append(ds, d)
		}
	}
	ds = append(ds, add...)
	sort.Slice(ds, func(i, j int) bool { return bytes.Compare(ds[i].PublicKey, ds[j].PublicKey) < 0 })
	body := &pb.ListVersionBody{Number: prev.Number + 1, Previous: c.ref(len(c.versions)).Hash, Devices: ds, Withdrawn: prev.Withdrawn, Signer: signer.pub}
	return sign("list", c.id, signer, body)
}

func (c *chain) take(obj *pb.SignedObject) {
	body := &pb.ListVersionBody{}
	if err := proto.Unmarshal(obj.Body, body); err != nil {
		panic(err)
	}
	c.versions = append(c.versions, obj)
	c.bodies = append(c.bodies, body)
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
	c.send(&pb.Frame{Body: &pb.Frame_Auth{Auth: &pb.Auth{Signature: ed25519.Sign(d.priv, e2e.Framed(AuthContext, account, []byte(signOrigin), ch.Nonce))}}})
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

func (h *harness) signUp(phone dev) *chain {
	h.t.Helper()
	ch := newChain(phone)
	c, _ := h.login(phone, nil)
	c.send(&pb.Frame{Body: &pb.Frame_SignUp{SignUp: &pb.SignUp{RequestId: "s", Version: ch.versions[0], Attestation: &pb.Attestation{Kind: &pb.Attestation_Test{Test: []byte("phone")}}}}})
	f := c.until("SignedUp", func(f *pb.Frame) bool { return f.GetSignedUp() != nil || f.GetError() != nil })
	if !bytes.Equal(f.GetSignedUp().GetAccountId(), ch.id) {
		h.t.Fatalf("signing up: %v", f)
	}
	c.ws.Close(websocket.StatusNormalClosure, "")
	return ch
}

// publish publishes the next version from c and adds it to the chain.
func (c *client) publish(ch *chain, obj *pb.SignedObject, id string) {
	c.t.Helper()
	c.send(&pb.Frame{Body: &pb.Frame_PublishVersion{PublishVersion: &pb.PublishVersion{RequestId: id, Version: obj}}})
	c.done(id)
	ch.take(obj)
}

func code(e *pb1.Error) pb1.ErrorCode { return e.GetCode() }

func TestLogin(t *testing.T) {
	h := newHarness(t, nil)
	phone, host := newDev(1), newDev(2)
	ch := h.signUp(phone)

	c, w := h.login(phone, ch.id)
	if w.Role != pb.DeviceRole_DEVICE_ROLE_CLIENT || w.ListVersion.GetNumber() != 1 || !bytes.Equal(w.ListVersion.GetHash(), ch.id) {
		t.Errorf("welcome %v", w)
	}
	// Then every pre-key, and the label state.
	if f := c.next(); f.GetPreKeys() == nil || !f.GetPreKeys().All {
		t.Errorf("after Welcome: %v", f)
	}
	if f := c.next(); f.GetLabelState() == nil {
		t.Errorf("after the pre-keys: %v", f)
	}

	// A key not on the list, and an account that does not exist.
	for _, acct := range [][]byte{ch.id, bytes.Repeat([]byte{9}, 32)} {
		_, f := h.loginAs(host, acct, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2)
		if code(f.GetError()) != pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED {
			t.Errorf("unlisted key: %v", f)
		}
	}
	// A signature for another relay, or another account.
	if _, f := h.loginAs(phone, ch.id, "wss://other.test", pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2); code(f.GetError()) != pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED {
		t.Errorf("another origin: %v", f)
	}
	if _, f := h.loginAs(phone, nil, "wss://other.test", pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2); code(f.GetError()) != pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED {
		t.Errorf("another origin, no account: %v", f)
	}
	if _, f := h.loginAs(phone, ch.id, origin, pb.ProtocolVersion_PROTOCOL_VERSION_UNSPECIFIED); code(f.GetError()) != pb1.ErrorCode_ERROR_CODE_VERSION_UNSUPPORTED {
		t.Errorf("no protocol version: %v", f)
	}
	// No v1alpha1 at all.
	if _, resp, err := h.dialRaw("/v1alpha1"); err == nil || resp == nil || resp.StatusCode != http.StatusNotFound {
		t.Errorf("v1alpha1: %v %v", resp, err)
	}
}

func TestSignUp(t *testing.T) {
	h := newHarness(t, nil)
	phone, other := newDev(1), newDev(2)
	ch := newChain(phone)
	att := &pb.Attestation{Kind: &pb.Attestation_Test{Test: []byte("phone")}}
	c, w := h.login(phone, nil)
	if w.Role != pb.DeviceRole_DEVICE_ROLE_UNSPECIFIED || w.ListVersion != nil {
		t.Errorf("welcome without an account: %v", w)
	}
	signUp := func(id string, v *pb.SignedObject, a *pb.Attestation) {
		c.send(&pb.Frame{Body: &pb.Frame_SignUp{SignUp: &pb.SignUp{RequestId: id, Version: v, Attestation: a}}})
	}
	// Without an attestation, with another key's version 1, and a version 1
	// that does not check.
	signUp("a", ch.versions[0], nil)
	if e := c.errorFor("a"); e.Code != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Errorf("no attestation: %v", e)
	}
	signUp("b", newChain(other).versions[0], att)
	if e := c.errorFor("b"); e.Code != pb1.ErrorCode_ERROR_CODE_INVALID {
		t.Errorf("another key's version 1: %v", e)
	}
	bad := proto.Clone(ch.versions[0]).(*pb.SignedObject)
	bad.Signature[0] ^= 1
	signUp("c", bad, att)
	if e := c.errorFor("c"); e.Code != pb1.ErrorCode_ERROR_CODE_INVALID {
		t.Errorf("bad signature: %v", e)
	}
	// Before signing up, nothing of an account.
	c.send(&pb.Frame{Body: &pb.Frame_SubscribeSessions{SubscribeSessions: &pb.SubscribeSessions{}}})
	if e := c.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Errorf("subscribing without an account: %v", e)
	}
	signUp("d", ch.versions[0], att)
	if f := c.until("SignedUp", func(f *pb.Frame) bool { return f.GetSignedUp() != nil }); !bytes.Equal(f.GetSignedUp().AccountId, ch.id) {
		t.Errorf("account ID %x", f.GetSignedUp().AccountId)
	}
	// Again, as after an answer lost: the same account.
	signUp("e", ch.versions[0], att)
	if f := c.until("SignedUp", func(f *pb.Frame) bool { return f.GetSignedUp() != nil }); f.GetSignedUp().RequestId != "e" || !bytes.Equal(f.GetSignedUp().AccountId, ch.id) {
		t.Errorf("again: %v", f)
	}

	// A relay without a verifier takes no sign-ups.
	h2 := newHarness(t, func(c *Config) { c.Verifier = nil })
	c2, _ := h2.login(phone, nil)
	c2.send(&pb.Frame{Body: &pb.Frame_SignUp{SignUp: &pb.SignUp{RequestId: "f", Version: ch.versions[0], Attestation: att}}})
	if e := c2.errorFor("f"); e.Code != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Errorf("no verifier: %v", e)
	}
}

func TestVersions(t *testing.T) {
	h := newHarness(t, nil)
	phone, host, tablet := newDev(1), newDev(2), newDev(3)
	ch := h.signUp(phone)
	p, _ := h.login(phone, ch.id)

	// A host signs no version.
	h2 := ch.next(phone, []*pb.Device{device(pb.DeviceRole_DEVICE_ROLE_HOST, host, phone.pub, nil)})
	p.publish(ch, h2, "v2")
	hc, w := h.login(host, ch.id)
	if w.Role != pb.DeviceRole_DEVICE_ROLE_HOST || w.ListVersion.Number != 2 {
		t.Errorf("host welcome %v", w)
	}
	hc.send(&pb.Frame{Body: &pb.Frame_PublishVersion{PublishVersion: &pb.PublishVersion{RequestId: "h", Version: ch.next(host, nil)}}})
	if e := hc.errorFor("h"); e.Code != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Errorf("a host publishing: %v", e)
	}

	// Every device is sent each version taken, before its signer's Done.
	v3 := ch.next(phone, []*pb.Device{device(pb.DeviceRole_DEVICE_ROLE_CLIENT, tablet, phone.pub, nil)})
	p.publish(ch, v3, "v3")
	if f := hc.until("Versions", func(f *pb.Frame) bool { return f.GetVersions_() != nil }); !proto.Equal(f.GetVersions_().Versions[0], v3) {
		t.Errorf("host sent %v", f)
	}
	tc, _ := h.login(tablet, ch.id)

	// The same version again: taken already.
	p.send(&pb.Frame{Body: &pb.Frame_PublishVersion{PublishVersion: &pb.PublishVersion{RequestId: "again", Version: v3}}})
	p.done("again")
	// A version that does not chain, or skips a number.
	bad := ch.next(phone, nil)
	bad.Signature[5] ^= 1
	p.send(&pb.Frame{Body: &pb.Frame_PublishVersion{PublishVersion: &pb.PublishVersion{RequestId: "bad", Version: bad}}})
	if e := p.errorFor("bad"); e.Code != pb1.ErrorCode_ERROR_CODE_INVALID {
		t.Errorf("bad signature: %v", e)
	}

	// Two clients at once: the first wins, the second is sent the winner
	// and CONFLICT, and withdraws its own.
	mine := ch.next(phone, nil, host)
	theirs := ch.next(tablet, []*pb.Device{device(pb.DeviceRole_DEVICE_ROLE_HOST, newDev(4), tablet.pub, nil)})
	p.publish(ch, mine, "p4")
	tc.send(&pb.Frame{Body: &pb.Frame_PublishVersion{PublishVersion: &pb.PublishVersion{RequestId: "t4", Version: theirs}}})
	f := tc.until("the winner", func(f *pb.Frame) bool {
		v := f.GetVersions_()
		return v != nil && len(v.Versions) == 1 && proto.Equal(v.Versions[0], mine) && v.RequestId == ""
	})
	_ = f
	if e := tc.errorFor("t4"); e.Code != pb1.ErrorCode_ERROR_CODE_CONFLICT {
		t.Errorf("the loser: %v", e)
	}
	// The host was removed by the winner: its connection is closed.
	if st := hc.closedWith(); st != websocket.StatusPolicyViolation {
		t.Errorf("removed host closed with %v", st)
	}
	if _, f := h.loginAs(host, ch.id, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2); code(f.GetError()) != pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED {
		t.Errorf("removed host logs in: %v", f)
	}

	theirsHash := sha256.Sum256(theirs.Body)
	withdrawal := func(signer dev, winner *pb.VersionRef) *pb.SignedObject {
		return sign("withdrawal", ch.id, signer, &pb.WithdrawalBody{Withdrawn: &pb.VersionRef{Number: 4, Hash: theirsHash[:]}, Winner: winner, Signer: signer.pub})
	}
	// A withdrawal naming a winner the relay does not have.
	tc.send(&pb.Frame{Body: &pb.Frame_PublishWithdrawal{PublishWithdrawal: &pb.PublishWithdrawal{RequestId: "w0", Withdrawal: withdrawal(tablet, &pb.VersionRef{Number: 4, Hash: bytes.Repeat([]byte{1}, 32)})}}})
	if e := tc.errorFor("w0"); e.Code != pb1.ErrorCode_ERROR_CODE_INVALID {
		t.Errorf("wrong winner: %v", e)
	}
	w4 := withdrawal(tablet, ch.ref(4))
	tc.send(&pb.Frame{Body: &pb.Frame_PublishWithdrawal{PublishWithdrawal: &pb.PublishWithdrawal{RequestId: "w", Withdrawal: w4}}})
	tc.done("w")
	if f := p.until("the withdrawal", func(f *pb.Frame) bool { return len(f.GetVersions_().GetWithdrawals()) == 1 }); !proto.Equal(f.GetVersions_().Withdrawals[0], w4) {
		t.Errorf("phone sent %v", f)
	}

	tc.send(&pb.Frame{Body: &pb.Frame_GetVersions{GetVersions: &pb.GetVersions{RequestId: "g", From: 3}}})
	g := tc.until("Versions", func(f *pb.Frame) bool { return f.GetVersions_().GetRequestId() == "g" }).GetVersions_()
	if len(g.Versions) != 2 || !proto.Equal(g.Versions[0], v3) || !proto.Equal(g.Versions[1], mine) || len(g.Withdrawals) != 1 {
		t.Errorf("GetVersions from 3: %d versions, %d withdrawals", len(g.Versions), len(g.Withdrawals))
	}

	// After a restart, from the store.
	h.restart()
	_, w = h.login(tablet, ch.id)
	if w.ListVersion.Number != 4 || !bytes.Equal(w.ListVersion.Hash, ch.ref(4).Hash) {
		t.Errorf("after a restart: %v", w.ListVersion)
	}
}

func preKey(account []byte, d dev, x byte, made time.Time, life time.Duration) *pb.SignedObject {
	return sign("pre-key", account, d, &pb.PreKeyBody{Signer: d.pub, PreKey: bytes.Repeat([]byte{x}, 32), MadeAt: timestamppb.New(made), ExpiresAt: timestamppb.New(made.Add(life))})
}

func bundleOf(account []byte, host dev, instance string, keyID byte, made time.Time, list *pb.VersionRef) *pb.SignedObject {
	return sign("bundle", account, host, &pb.BundleBody{HostKey: host.pub, InstanceId: instance, KeyId: bytes.Repeat([]byte{keyID}, 16), MadeAt: timestamppb.New(made), ListVersion: list, RequestKey: bytes.Repeat([]byte{7}, 32)})
}

// account2 is an account with a phone, its read-only key and a host.
func account2(h *harness) (ch *chain, phone, read, host dev, p, r, hc *client) {
	phone, read, host = newDev(1), newDev(2), newDev(3)
	ch = h.signUp(phone)
	p, _ = h.login(phone, ch.id)
	p.publish(ch, ch.next(phone, []*pb.Device{
		device(pb.DeviceRole_DEVICE_ROLE_READ_ONLY, read, phone.pub, phone.pub),
		device(pb.DeviceRole_DEVICE_ROLE_HOST, host, phone.pub, nil),
	}), "v2")
	r, _ = h.login(read, ch.id)
	hc, _ = h.login(host, ch.id)
	return
}

func TestPreKeys(t *testing.T) {
	h := newHarness(t, nil)
	ch, phone, read, host, p, r, hc := account2(h)
	_ = r
	pk := preKey(ch.id, phone, 0xa1, t0, 7*24*time.Hour)
	p.send(&pb.Frame{Body: &pb.Frame_PublishPreKey{PublishPreKey: &pb.PublishPreKey{RequestId: "pk", PreKey: pk}}})
	p.done("pk")
	if f := hc.until("PreKeys", func(f *pb.Frame) bool { return f.GetPreKeys() != nil && !f.GetPreKeys().All }); !proto.Equal(f.GetPreKeys().PreKeys[0], pk) {
		t.Errorf("host sent %v", f)
	}
	rk := preKey(ch.id, read, 0xa2, t0, 7*24*time.Hour)
	r.send(&pb.Frame{Body: &pb.Frame_PublishPreKey{PublishPreKey: &pb.PublishPreKey{RequestId: "rk", PreKey: rk}}})
	r.done("rk")
	// A host has no pre-key; nor is one another device's to publish, or
	// one that lives past 14 days or has expired.
	for id, c := range map[string]struct {
		c   *client
		obj *pb.SignedObject
	}{
		"host":    {hc, preKey(ch.id, host, 1, t0, time.Hour)},
		"other":   {p, rk},
		"long":    {p, preKey(ch.id, phone, 1, t0, 15*24*time.Hour)},
		"expired": {p, preKey(ch.id, phone, 1, t0.Add(-8*24*time.Hour), 7*24*time.Hour)},
	} {
		c.c.send(&pb.Frame{Body: &pb.Frame_PublishPreKey{PublishPreKey: &pb.PublishPreKey{RequestId: id, PreKey: c.obj}}})
		if e := c.c.errorFor(id); e.Code == pb1.ErrorCode_ERROR_CODE_UNSPECIFIED {
			t.Errorf("%s: %v", id, e)
		}
	}
	// A device logging in is sent every current one.
	h2, _ := h.login(host, ch.id)
	all := h2.until("PreKeys", func(f *pb.Frame) bool { return f.GetPreKeys() != nil }).GetPreKeys()
	if !all.All || len(all.PreKeys) != 2 {
		t.Errorf("at login: %v", all)
	}
	// Expired ones are not sent.
	h.srv.cfg.Now = func() time.Time { return t0.Add(8 * 24 * time.Hour) }
	h3, _ := h.login(host, ch.id)
	if all := h3.until("PreKeys", func(f *pb.Frame) bool { return f.GetPreKeys() != nil }).GetPreKeys(); len(all.PreKeys) != 0 {
		t.Errorf("expired sent: %v", all)
	}
}

func TestSessions(t *testing.T) {
	h := newHarness(t, nil)
	ch, phone, _, host, p, r, hc := account2(h)
	// Another account, which must see nothing of this one.
	stranger := newDev(9)
	sch := h.signUp(stranger)
	sc, _ := h.login(stranger, sch.id)
	sc.send(&pb.Frame{Body: &pb.Frame_SubscribeSessions{SubscribeSessions: &pb.SubscribeSessions{}}})
	if l := sc.until("SessionList", func(f *pb.Frame) bool { return f.GetSessionList() != nil }).GetSessionList(); len(l.Sessions) != 0 {
		t.Errorf("an empty account's list: %v", l)
	}

	ref := &pb1.SessionRef{HostKey: host.pub, SessionId: "s1", InstanceId: "i1"}
	keys := &pb.FrameKeys{KeyId: bytes.Repeat([]byte{1}, 16)}
	announce := func(id string) {
		hc.send(&pb.Frame{Body: &pb.Frame_SessionAnnounce{SessionAnnounce: &pb.SessionAnnounce{Session: ref, Keys: keys, Payload: []byte("sealed " + id)}}})
	}
	// No bundle with that key ID yet.
	announce("a")
	if e := hc.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_INVALID {
		t.Errorf("announcing before the bundle: %v", e)
	}
	// A bundle naming a version the relay does not have, or another host's.
	hc.send(&pb.Frame{Body: &pb.Frame_PublishBundle{PublishBundle: &pb.PublishBundle{RequestId: "b0", Bundle: bundleOf(ch.id, host, "i1", 1, t0, &pb.VersionRef{Number: 2, Hash: make([]byte, 32)})}}})
	if e := hc.errorFor("b0"); e.Code != pb1.ErrorCode_ERROR_CODE_INVALID {
		t.Errorf("unknown version: %v", e)
	}
	b1 := bundleOf(ch.id, host, "i1", 1, t0, ch.ref(2))
	hc.send(&pb.Frame{Body: &pb.Frame_PublishBundle{PublishBundle: &pb.PublishBundle{RequestId: "b1", Bundle: b1}}})
	hc.done("b1")
	announce("b")
	// An announcement has no answer: wait for the relay to have it.
	for i := 0; i < 200; i++ {
		h.srv.mu.Lock()
		n := 0
		if a := h.srv.accounts[string(ch.id)]; a != nil {
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
	if len(l.Sessions) != 1 || !proto.Equal(l.Sessions[0].Session, ref) || len(l.Sessions[0].Bundles) != 1 || !proto.Equal(l.Sessions[0].Bundles[0], b1) || string(l.Sessions[0].Payload) != "sealed b" {
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
	r.send(&pb.Frame{Body: &pb.Frame_Routed{Routed: &pb.Routed{Session: ref, Keys: keys, Payload: []byte("x")}}})
	if e := r.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Errorf("read-only routed: %v", e)
	}

	// A request: the relay names the client.
	p.send(&pb.Frame{Body: &pb.Frame_Attach{Attach: &pb.Attach{Session: ref}}})
	p.send(&pb.Frame{Body: &pb.Frame_Routed{Routed: &pb.Routed{Session: ref, ClientKey: host.pub, Keys: &pb.FrameKeys{KeyId: keys.KeyId, Counter: 9}, Payload: []byte("envelope")}}})
	got := hc.until("Routed", func(f *pb.Frame) bool { return f.GetRouted() != nil }).GetRouted()
	if !bytes.Equal(got.ClientKey, phone.pub) || string(got.Payload) != "envelope" || got.Keys.Counter != 0 {
		t.Errorf("host got %v", got)
	}
	// The stranger cannot reach the session.
	sc.send(&pb.Frame{Body: &pb.Frame_Routed{Routed: &pb.Routed{Session: ref, Keys: keys, Payload: []byte("x")}}})
	if e := sc.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND {
		t.Errorf("stranger routed: %v", e)
	}
	sc.send(&pb.Frame{Body: &pb.Frame_Attach{Attach: &pb.Attach{Session: ref}}})
	if e := sc.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND {
		t.Errorf("stranger attach: %v", e)
	}

	// Broadcasts to the attached; answers to one client of the account.
	fk := &pb.FrameKeys{KeyId: keys.KeyId, Counter: 3, ListVersion: 2}
	hc.send(&pb.Frame{Body: &pb.Frame_Routed{Routed: &pb.Routed{Session: ref, Keys: fk, Payload: []byte("broadcast")}}})
	if got := p.until("Routed", func(f *pb.Frame) bool { return f.GetRouted() != nil }).GetRouted(); string(got.Payload) != "broadcast" || !proto.Equal(got.Keys, fk) {
		t.Errorf("phone got %v", got)
	}
	hc.send(&pb.Frame{Body: &pb.Frame_Routed{Routed: &pb.Routed{Session: ref, ClientKey: stranger.pub, Keys: fk, Payload: []byte("to the stranger")}}})
	hc.send(&pb.Frame{Body: &pb.Frame_Routed{Routed: &pb.Routed{Session: ref, ClientKey: phone.pub, Keys: fk, Payload: []byte("answer")}}})
	if got := p.until("Routed", func(f *pb.Frame) bool { return f.GetRouted() != nil }).GetRouted(); string(got.Payload) != "answer" {
		t.Errorf("phone got %v", got)
	}
	sc.quiet("a frame of another account", func(f *pb.Frame) bool { return f.GetRouted() != nil || f.GetSessionUpdated() != nil })

	// The same keys wrapped again, later: it replaces the bundle; an older
	// one with that key ID does not.
	b1b := bundleOf(ch.id, host, "i1", 1, t0.Add(time.Hour), ch.ref(2))
	hc.send(&pb.Frame{Body: &pb.Frame_PublishBundle{PublishBundle: &pb.PublishBundle{RequestId: "b1b", Bundle: b1b}}})
	hc.done("b1b")
	if u := p.until("SessionUpdated", func(f *pb.Frame) bool { return f.GetSessionUpdated() != nil }).GetSessionUpdated(); len(u.Entry.Bundles) != 1 || !proto.Equal(u.Entry.Bundles[0], b1b) {
		t.Errorf("after wrapping again: %v", u.Entry.Bundles)
	}
	hc.send(&pb.Frame{Body: &pb.Frame_PublishBundle{PublishBundle: &pb.PublishBundle{RequestId: "b1c", Bundle: bundleOf(ch.id, host, "i1", 1, t0.Add(-time.Hour), ch.ref(2))}}})
	if e := hc.errorFor("b1c"); e.Code != pb1.ErrorCode_ERROR_CODE_INVALID {
		t.Errorf("an older bundle with the key ID: %v", e)
	}

	// The next day's bundle: subscribers see both until the announcement
	// moves to it, then the new one alone.
	b2 := bundleOf(ch.id, host, "i1", 2, t0.Add(24*time.Hour), ch.ref(2))
	hc.send(&pb.Frame{Body: &pb.Frame_PublishBundle{PublishBundle: &pb.PublishBundle{RequestId: "b2", Bundle: b2}}})
	hc.done("b2")
	if u := p.until("SessionUpdated", func(f *pb.Frame) bool { return f.GetSessionUpdated() != nil }).GetSessionUpdated(); len(u.Entry.Bundles) != 2 {
		t.Errorf("after the new bundle: %d bundles", len(u.Entry.Bundles))
	}
	keys = &pb.FrameKeys{KeyId: bytes.Repeat([]byte{2}, 16)}
	announce("c")
	if u := p.until("SessionUpdated", func(f *pb.Frame) bool { return f.GetSessionUpdated() != nil }).GetSessionUpdated(); len(u.Entry.Bundles) != 1 || !proto.Equal(u.Entry.Bundles[0], b2) {
		t.Errorf("after announcing under it: %v", u.Entry.Bundles)
	}

	// The host goes: its session ends.
	hc.ws.Close(websocket.StatusNormalClosure, "")
	if f := p.until("SessionEnded", func(f *pb.Frame) bool { return f.GetSessionEnded() != nil }); !proto.Equal(f.GetSessionEnded().Session, ref) {
		t.Errorf("ended %v", f)
	}
}

func labels(account []byte, signer dev, key *pb.VersionRef, counter uint64, list *pb.VersionRef) *pb.SignedObject {
	return sign("labels", account, signer, &pb.LabelsBody{LabelKey: &pb.LabelKeyRef{Version: key}, Counter: counter, ListVersion: list, Sealed: bytes.Repeat([]byte{byte(counter)}, 40), Signer: signer.pub})
}

func TestLabels(t *testing.T) {
	h := newHarness(t, nil)
	ch, phone, read, host, p, r, hc := account2(h)
	pub := func(c *client, id string, obj *pb.SignedObject) {
		c.send(&pb.Frame{Body: &pb.Frame_PublishLabels{PublishLabels: &pb.PublishLabels{RequestId: id, Labels: obj}}})
	}
	l1 := labels(ch.id, phone, ch.ref(1), 1, ch.ref(2))
	pub(p, "l1", l1)
	p.done("l1")
	if s := r.until("LabelState", func(f *pb.Frame) bool { return len(f.GetLabelState().GetLabels()) == 1 }).GetLabelState(); !proto.Equal(s.Labels[0], l1) {
		t.Errorf("read-only key sent %v", s)
	}
	hc.quiet("labels to a host", func(f *pb.Frame) bool { return f.GetLabelState() != nil })

	l2 := labels(ch.id, phone, ch.ref(1), 2, ch.ref(2))
	pub(p, "l2", l2)
	p.done("l2")
	if s := r.until("LabelState", func(f *pb.Frame) bool { return f.GetLabelState() != nil }).GetLabelState(); len(s.Labels) != 1 || !proto.Equal(s.Labels[0], l2) {
		t.Errorf("after counter 2: %v", s)
	}
	// A lower counter, a host's record, and a label key the relay has no
	// version of.
	pub(p, "old", labels(ch.id, phone, ch.ref(1), 1, ch.ref(2)))
	if e := p.errorFor("old"); e.Code != pb1.ErrorCode_ERROR_CODE_CONFLICT {
		t.Errorf("lower counter: %v", e)
	}
	pub(hc, "host", labels(ch.id, host, ch.ref(1), 3, ch.ref(2)))
	if e := hc.errorFor("host"); e.Code != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Errorf("host: %v", e)
	}
	pub(p, "nokey", labels(ch.id, phone, &pb.VersionRef{Number: 2, Hash: make([]byte, 32)}, 3, ch.ref(2)))
	if e := p.errorFor("nokey"); e.Code != pb1.ErrorCode_ERROR_CODE_INVALID {
		t.Errorf("unknown label key: %v", e)
	}

	// A wrap for the read-only key's current pre-key reaches it alone.
	rk := preKey(ch.id, read, 0xb1, t0, 7*24*time.Hour)
	r.send(&pb.Frame{Body: &pb.Frame_PublishPreKey{PublishPreKey: &pb.PublishPreKey{RequestId: "rk", PreKey: rk}}})
	r.done("rk")
	wrap := func(pre byte) *pb.SignedObject {
		return sign("label-key", ch.id, phone, &pb.LabelKeyWrapBody{LabelKey: &pb.LabelKeyRef{Version: ch.ref(1)}, Recipient: read.pub, PreKey: bytes.Repeat([]byte{pre}, 32), Wrap: bytes.Repeat([]byte{3}, 80), Signer: phone.pub})
	}
	p.send(&pb.Frame{Body: &pb.Frame_PublishLabelKeyWraps{PublishLabelKeyWraps: &pb.PublishLabelKeyWraps{RequestId: "w0", Wraps: []*pb.SignedObject{wrap(0xb2)}}}})
	if e := p.errorFor("w0"); e.Code != pb1.ErrorCode_ERROR_CODE_INVALID {
		t.Errorf("another pre-key: %v", e)
	}
	w := wrap(0xb1)
	p.send(&pb.Frame{Body: &pb.Frame_PublishLabelKeyWraps{PublishLabelKeyWraps: &pb.PublishLabelKeyWraps{RequestId: "w", Wraps: []*pb.SignedObject{w}}}})
	p.done("w")
	if s := r.until("LabelState with a wrap", func(f *pb.Frame) bool { return len(f.GetLabelState().GetWraps()) == 1 }).GetLabelState(); !proto.Equal(s.Wraps[0], w) || len(s.Labels) != 1 {
		t.Errorf("read-only key sent %v", s)
	}
	p.quiet("another's wrap", func(f *pb.Frame) bool { return len(f.GetLabelState().GetWraps()) > 0 })

	// A new label key, at a later version, supersedes the old records.
	p.publish(ch, ch.next(phone, nil, host), "v3")
	l3 := labels(ch.id, phone, ch.ref(3), 1, ch.ref(3))
	pub(p, "l3", l3)
	p.done("l3")
	if s := r.until("LabelState", func(f *pb.Frame) bool {
		return f.GetLabelState() != nil && len(f.GetLabelState().Labels) == 1 && proto.Equal(f.GetLabelState().Labels[0], l3)
	}).GetLabelState(); len(s.Wraps) != 0 {
		t.Errorf("the old key's wrap kept: %v", s.Wraps)
	}
	pub(p, "l2again", labels(ch.id, phone, ch.ref(1), 5, ch.ref(3)))
	if e := p.errorFor("l2again"); e.Code != pb1.ErrorCode_ERROR_CODE_CONFLICT {
		t.Errorf("an older label key: %v", e)
	}
}

func TestJoin(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.MaxLookupsPerAccount = 4 })
	phone := newDev(1)
	ch := h.signUp(phone)
	p, _ := h.login(phone, ch.id)
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
	ch, phone, read, host, p, r, hc := account2(h)
	_ = ch
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
	ch, phone, _, host, p, r, hc := account2(h)
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
		if _, f := h.loginAs(d, ch.id, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2); code(f.GetError()) != pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED {
			t.Errorf("logging in after deletion: %v", f)
		}
	}
	// Nothing of it is left in the store.
	for _, table := range []string{"accounts", "versions", "withdrawals", "pre_keys", "labels", "label_key_wraps", "devices", "attestations"} {
		var n int
		if err := h.cfg.Store.db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil || n != 0 {
			t.Errorf("%s: %d rows, %v", table, n, err)
		}
	}
	// And the same phone can sign up again, to the same account ID.
	if again := h.signUp(phone); !bytes.Equal(again.id, ch.id) {
		t.Errorf("signing up again: %x", again.id)
	}
}

func testLogger() *slog.Logger {
	if os.Getenv("HOSTED_TEST_LOG") != "" {
		return slog.Default()
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
