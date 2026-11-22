package hosted

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"

	pb1 "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

func signUpFrame(id string, list []byte) *pb.Frame {
	return &pb.Frame{Body: &pb.Frame_SignUp{SignUp: &pb.SignUp{RequestId: id, Attestation: testAttestation, List: list}}}
}

func publishFrame(id string, list []byte) *pb.Frame {
	return &pb.Frame{Body: &pb.Frame_PublishList{PublishList: &pb.PublishList{RequestId: id, List: list}}}
}

func isList(f *pb.Frame) bool { return f.GetList() != nil }

func TestSignUpVersion1(t *testing.T) {
	h := newHarness(t, nil)
	phone, other := newDev(1), newDev(2)
	ta := newTestAccount(phone)
	c, _ := h.login(phone, nil)

	refused := func(id string, list []byte, want pb1.ErrorCode, what string) {
		t.Helper()
		c.send(signUpFrame(id, list))
		if e := c.errorFor(id); e.Code != want {
			t.Errorf("%s: %v", what, e)
		}
	}
	refused("none", nil, pb1.ErrorCode_ERROR_CODE_INVALID, "no list")
	two, _ := makeList(phone, &pb.ListBody{Counter: 1, Devices: []*pb.Device{phoneEntry(phone), entry(other, RoleComputer)}})
	refused("two", two, pb1.ErrorCode_ERROR_CODE_VERSION_UNSUPPORTED, "two devices")
	// Signed by the login key, listing another phone.
	notMe, _ := makeList(phone, &pb.ListBody{Counter: 1, Devices: []*pb.Device{phoneEntry(other)}})
	refused("not-me", notMe, pb1.ErrorCode_ERROR_CODE_VERSION_UNSUPPORTED, "a device that is not the login key")
	// Another key's version 1.
	refused("theirs", newTestAccount(other).signed, pb1.ErrorCode_ERROR_CODE_INVALID, "signed by another key")
	odd := phoneEntry(phone)
	odd.Role = 3
	unsupported, _ := makeList(phone, &pb.ListBody{Counter: 1, Devices: []*pb.Device{odd}})
	refused("role", unsupported, pb1.ErrorCode_ERROR_CODE_VERSION_UNSUPPORTED, "an unknown role")
	later, _ := makeList(phone, &pb.ListBody{AccountId: ta.id, Counter: 2, PreviousHash: ta.id, Devices: ta.devices})
	refused("later", later, pb1.ErrorCode_ERROR_CODE_INVALID, "not a version 1")
	if ok, _ := h.cfg.Store.HasAccount(ta.id); ok {
		t.Fatal("an account made by a refused sign-up")
	}

	c.send(signUpFrame("a", ta.signed))
	f := c.until("SignedUp", func(f *pb.Frame) bool { return f.GetSignedUp() != nil || f.GetError() != nil })
	sum := sha256.Sum256(ta.signed[ListSignatureBytes:])
	if !bytes.Equal(f.GetSignedUp().GetAccountId(), sum[:]) {
		t.Fatalf("signed up %v, want the body's hash", f)
	}
	// A retry with the same bytes: the same account.
	c.send(signUpFrame("b", ta.signed))
	if f := c.until("SignedUp", func(f *pb.Frame) bool { return f.GetSignedUp() != nil || f.GetError() != nil }); !bytes.Equal(f.GetSignedUp().GetAccountId(), sum[:]) {
		t.Errorf("retry: %v", f)
	}
	// Another version 1 from the same phone: refused, the first kept.
	again := phoneEntry(phone)
	again.ChannelKey = derived(phone, "another channel")
	otherV1, _ := makeList(phone, &pb.ListBody{Counter: 1, Devices: []*pb.Device{again}})
	refused("c", otherV1, pb1.ErrorCode_ERROR_CODE_CONFLICT, "another version 1")
	if l, _, _ := h.cfg.Store.List(sum[:]); !bytes.Equal(l.Signed, ta.signed) {
		t.Error("the first version 1 replaced")
	}
}

// listAccount is an account with a phone, a host and a browser on its
// version 2, each logged in, and the phone's read-only key.
func listAccount(h *harness) (ta *testAccount, phone, host, browser dev, p, hc, b, r *client) {
	phone, host, browser = newDev(1), newDev(3), newDev(4)
	id := h.signUp(phone)
	ta = h.accts[string(id)]
	h.publish(id, ta.next(phoneEntry(phone), entry(host, RoleComputer), entry(browser, RoleClient)))
	p, _ = h.login(phone, id)
	hc, _ = h.login(host, id)
	b, _ = h.login(browser, id)
	r, _ = h.login(readOnlyOf(phone), id)
	return
}

func TestPublishList(t *testing.T) {
	h := newHarness(t, nil)
	ta, phone, host, browser, p, hc, b, r := listAccount(h)
	id := ta.id

	// From a client that is not the phone: taken, Done to it, List to
	// every other connection.
	v3 := ta.next(phoneEntry(phone), entry(host, RoleComputer), entry(browser, RoleClient), entry(newDev(5), RoleComputer))
	b.send(publishFrame("b3", v3))
	b.done("b3")
	for _, c := range []*client{p, hc, r} {
		if l := c.until("List", isList).GetList(); !bytes.Equal(l.List, v3) {
			t.Errorf("List %x", l.List[:8])
		}
	}
	b.quiet("List to the sender", isList)

	// From a computer, signed by the phone.
	v4 := ta.next(ta.devices...)
	hc.send(publishFrame("h4", v4))
	hc.done("h4")
	b.until("List", isList)

	// The same again: a retry.
	b.send(publishFrame("again", v4))
	b.done("again")
	// The same counter, another body: CONFLICT and the relay's.
	fork, _ := ta.version(4, phoneEntry(phone), entry(host, RoleComputer))
	b.send(publishFrame("fork", fork))
	if l := b.until("List", isList).GetList(); !bytes.Equal(l.List, v4) {
		t.Errorf("after a fork, List %x", l.List[:8])
	}
	if e := b.errorFor("fork"); e.Code != pb1.ErrorCode_ERROR_CODE_CONFLICT {
		t.Errorf("fork: %v", e)
	}
	// Older.
	b.send(publishFrame("old", v3))
	if l := b.until("List", isList).GetList(); !bytes.Equal(l.List, v4) {
		t.Errorf("after an old one, List %x", l.List[:8])
	}
	if e := b.errorFor("old"); e.Code != pb1.ErrorCode_ERROR_CODE_CONFLICT {
		t.Errorf("old: %v", e)
	}
	// Newer, but a device of a role the check does not know: nothing kept.
	odd := entry(newDev(6), RoleComputer)
	odd.Role = 3
	unsupported, _ := ta.version(5, append(ta.devices, odd)...)
	b.send(publishFrame("odd", unsupported))
	if e := b.errorFor("odd"); e.Code != pb1.ErrorCode_ERROR_CODE_VERSION_UNSUPPORTED {
		t.Errorf("unsupported: %v", e)
	}
	// Signed by another key.
	forged, _ := makeList(host, &pb.ListBody{AccountId: id, Counter: 5, PreviousHash: id, Devices: ta.devices})
	b.send(publishFrame("forged", forged))
	if e := b.errorFor("forged"); e.Code != pb1.ErrorCode_ERROR_CODE_INVALID {
		t.Errorf("forged: %v", e)
	}
	// Not from a read-only key.
	v5, _ := ta.version(5, ta.devices...)
	r.send(publishFrame("ro", v5))
	if e := r.errorFor("ro"); e.Code != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Errorf("read-only: %v", e)
	}
	if l, _, _ := h.cfg.Store.List(id); l.Counter != 4 || !bytes.Equal(l.Signed, v4) {
		t.Fatalf("stored counter %d", l.Counter)
	}

	// Kept across a restart; Welcome carries it only when newer than
	// what the device holds.
	h.restart()
	for held, want := range map[uint64][]byte{0: v4, 3: v4, 4: nil, 9: nil} {
		_, f := h.loginHolding(browser, id, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2, held)
		if w := f.GetWelcome(); w.GetListCounter() != 4 || !bytes.Equal(w.GetList(), want) {
			t.Errorf("holding %d: %v", held, f)
		}
	}
	// A device without an account is told of none.
	if _, w := h.login(newDev(9), nil); w.GetListCounter() != 0 || len(w.GetList()) != 0 {
		t.Errorf("no account: %v", w)
	}

	// The stored bytes damaged: logins refused with INTERNAL.
	h.stop()
	db := openRaw(t, h.dir)
	if _, err := db.Exec(`UPDATE lists SET signed = CAST(substr(signed, 1, length(signed) - 1) || x'00' AS BLOB)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	h.start(nil)
	if _, f := h.loginAs(phone, id, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2); code(f.GetError()) != pb1.ErrorCode_ERROR_CODE_INTERNAL {
		t.Errorf("a damaged list: %v", f)
	}
}

// A version is committed before anyone is told of it: a store that
// cannot take it leaves every device as it was.
func TestPublishListCommitFirst(t *testing.T) {
	h := newHarness(t, nil)
	ta, phone, host, _, p, hc, b, _ := listAccount(h)
	if _, err := h.cfg.Store.db.Exec(`CREATE TRIGGER refuse BEFORE UPDATE ON lists BEGIN SELECT RAISE(ABORT, 'refused'); END`); err != nil {
		t.Fatal(err)
	}
	v3 := ta.next(phoneEntry(phone))
	p.send(publishFrame("p3", v3))
	if e := p.errorFor("p3"); e.Code != pb1.ErrorCode_ERROR_CODE_INTERNAL {
		t.Errorf("a store that refuses: %v", e)
	}
	for _, c := range []*client{hc, b} {
		c.quiet("List or a close", func(f *pb.Frame) bool { return isList(f) })
	}
	// The host is still on the relay's list.
	h.cfg.Store.db.Exec(`DROP TRIGGER refuse`)
	if _, w := h.login(host, ta.id); w.GetListCounter() != 2 {
		t.Errorf("after a refused store, %v", w)
	}
}

func TestPublishListCap(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.MaxListPublishesPerAccount = 3 })
	phone := newDev(1)
	id := h.signUp(phone)
	ta := h.accts[string(id)]
	p, _ := h.login(phone, id)
	for i := 0; i < 3; i++ {
		p.send(publishFrame("n", ta.next(ta.devices...)))
		p.done("n")
	}
	p.send(publishFrame("over", ta.next(ta.devices...)))
	if e := p.errorFor("over"); e.Code != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
		t.Errorf("past the cap: %v", e)
	}
}

// framesUntilClose is every frame c reads until its connection closes,
// and the close's status.
func framesUntilClose(t *testing.T, c *client) ([]*pb.Frame, websocket.StatusCode) {
	t.Helper()
	var out []*pb.Frame
	for {
		f, err := c.read(7 * time.Second)
		if err == errTimeout {
			t.Fatal("not closed")
		}
		if err != nil {
			return out, websocket.CloseStatus(err)
		}
		out = append(out, f)
	}
}

func TestRemoval(t *testing.T) {
	h := newHarness(t, nil)
	ta, phone, host, browser, p, hc, b, r := listAccount(h)
	id := ta.id
	// The host has a session the browser follows, and a device row,
	// attestation and names copy of its own; the browser waits in a join.
	ref := &pb1.SessionRef{HostKey: host.pub, SessionId: "s1", InstanceId: "i1"}
	b.send(&pb.Frame{Body: &pb.Frame_SubscribeSessions{SubscribeSessions: &pb.SubscribeSessions{}}})
	b.until("SessionList", func(f *pb.Frame) bool { return f.GetSessionList() != nil })
	hc.send(&pb.Frame{Body: &pb.Frame_SessionAnnounce{SessionAnnounce: &pb.SessionAnnounce{Session: ref, Payload: []byte("x")}}})
	b.until("SessionUpdated", func(f *pb.Frame) bool { return f.GetSessionUpdated() != nil })
	h.cfg.Store.AddAttestation(id, host.pub, "test", []byte("host"))
	h.cfg.Store.db.Exec(`INSERT INTO names (account, recipient, sealed) VALUES (?, ?, x'00'), (?, ?, x'00')`, id, derived(host, "box"), id, derived(browser, "box"))
	p.send(&pb.Frame{Body: &pb.Frame_WatchDevices{WatchDevices: &pb.WatchDevices{}}})
	p.until("Devices", func(f *pb.Frame) bool { return f.GetDevices() != nil })

	// Version 3 removes the host.
	v3 := ta.next(phoneEntry(phone), entry(browser, RoleClient))
	p.send(publishFrame("p3", v3))
	p.done("p3")
	frames, st := framesUntilClose(t, hc)
	if st != websocket.StatusPolicyViolation || len(frames) == 0 || !bytes.Equal(frames[len(frames)-1].GetList().GetList(), v3) {
		t.Fatalf("the removed host read %v, then %v; want List last, then 1008", frames, st)
	}
	// Its session ended at once; Devices lists the phone and the browser.
	b.until("SessionEnded", func(f *pb.Frame) bool { return f.GetSessionEnded() != nil })
	if ds := p.until("Devices", func(f *pb.Frame) bool { return f.GetDevices() != nil }).GetDevices(); len(ds.Devices) != 2 || !bytes.Equal(ds.Devices[1].PublicKey, browser.pub) {
		t.Errorf("devices %v", ds)
	}
	// Its rows are gone, and stay gone after its close.
	time.Sleep(50 * time.Millisecond)
	var n int
	for _, q := range []string{
		`SELECT count(*) FROM devices WHERE account = ? AND device = ?`,
		`SELECT count(*) FROM attestations WHERE account = ? AND device = ?`,
	} {
		if h.cfg.Store.db.QueryRow(q, id, host.pub).Scan(&n); n != 0 {
			t.Errorf("%s: %d", q, n)
		}
	}
	if h.cfg.Store.db.QueryRow(`SELECT count(*) FROM names WHERE account = ?`, id).Scan(&n); n != 1 {
		t.Errorf("names copies: %d, want the browser's", n)
	}

	// Logging in again it is given the newest list, then refused.
	hc2, f := h.loginAs(host, id, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2)
	if !bytes.Equal(f.GetList().GetList(), v3) {
		t.Fatalf("a removed key's login: %v", f)
	}
	if e := hc2.next().GetError(); e.GetCode() != pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED || e.GetMessage() != errRemoved {
		t.Errorf("then %v", e)
	}
	// A key never listed is told nothing of the list.
	if _, f := h.loginAs(newDev(8), id, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2); code(f.GetError()) != pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED || f.GetError().GetMessage() == errRemoved {
		t.Errorf("a stranger: %v", f)
	}

	// The browser re-listed as a computer, with the same keys: removed,
	// and logs in again in its new role.
	v4 := ta.next(phoneEntry(phone), entry(browser, RoleComputer))
	p.send(publishFrame("p4", v4))
	p.done("p4")
	if frames, st := framesUntilClose(t, b); st != websocket.StatusPolicyViolation || !bytes.Equal(frames[len(frames)-1].GetList().GetList(), v4) {
		t.Errorf("a re-listed browser: %v, %v", frames, st)
	}
	if _, w := h.login(browser, id); w.Role != pb.DeviceRole_DEVICE_ROLE_HOST {
		t.Errorf("re-listed: %v", w)
	}

	// The phone with another read-only key and box key: only the old
	// read-only key's connection goes, after List. The phone stays, with
	// its device row, push handle and attestation; only the names copy
	// sealed to its old box key is deleted.
	p.send(&pb.Frame{Body: &pb.Frame_RegisterPush{RegisterPush: &pb.RegisterPush{RequestId: "push", Handle: "handle"}}})
	p.done("push")
	h.cfg.Store.db.Exec(`INSERT INTO names (account, recipient, sealed) VALUES (?, ?, x'00')`, id, derived(phone, "box"))
	moved := phoneEntry(phone)
	moved.ReadOnlyKey, moved.BoxKey = newDev(7).pub, derived(phone, "another box")
	v5 := ta.next(moved, entry(browser, RoleComputer))
	p.send(publishFrame("p5", v5))
	p.done("p5")
	if frames, st := framesUntilClose(t, r); st != websocket.StatusPolicyViolation || !bytes.Equal(frames[len(frames)-1].GetList().GetList(), v5) {
		t.Errorf("the old read-only key: %v, %v", frames, st)
	}
	p.quiet("a close of the phone", func(*pb.Frame) bool { return false })
	if p.err != nil {
		t.Fatalf("the phone's connection closed: %v", p.err)
	}
	rows, _ := h.cfg.Store.Devices(id)
	if rows[string(phone.pub)].pushHandle != "handle" {
		t.Errorf("the phone's row %v", rows)
	}
	for q, want := range map[string]int{
		`SELECT count(*) FROM attestations WHERE account = ? AND device = ?`: 1,
		`SELECT count(*) FROM removed WHERE account = ? AND key = ?`:         0,
	} {
		if h.cfg.Store.db.QueryRow(q, id, phone.pub).Scan(&n); n != want {
			t.Errorf("%s: %d, want %d", q, n, want)
		}
	}
	if h.cfg.Store.db.QueryRow(`SELECT count(*) FROM names WHERE account = ? AND recipient = ?`, id, derived(phone, "box")).Scan(&n); n != 0 {
		t.Errorf("the old box key's names copy kept")
	}
	if _, w := h.login(phone, id); w.Role != pb.DeviceRole_DEVICE_ROLE_CLIENT {
		t.Errorf("the phone again: %v", w)
	}
	r2, w := h.login(newDev(7), id)
	if w.Role != pb.DeviceRole_DEVICE_ROLE_READ_ONLY {
		t.Errorf("the new read-only key: %v", w)
	}
	if _, f := h.loginAs(readOnlyOf(phone), id, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2); !bytes.Equal(f.GetList().GetList(), v5) {
		t.Errorf("the old read-only key logging in: %v", f)
	}

	// Only the box key again: the read-only key's connection stays.
	again := phoneEntry(phone)
	again.ReadOnlyKey, again.BoxKey = newDev(7).pub, derived(phone, "a third box")
	v6 := ta.next(again, entry(browser, RoleComputer))
	p.send(publishFrame("p6", v6))
	p.done("p6")
	if l := r2.until("List", isList).GetList(); !bytes.Equal(l.List, v6) {
		t.Errorf("List %x", l.List[:8])
	}
	r2.quiet("a close of the read-only key", func(*pb.Frame) bool { return false })
	if r2.err != nil {
		t.Errorf("the read-only key's connection closed: %v", r2.err)
	}
}

// Refused and old versions do not count toward the hourly cap: a device
// sending them cannot keep the phone's next version out.
func TestPublishListCapCountsTaken(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.MaxListPublishesPerAccount = 2 })
	ta, phone, host, _, p, hc, _, _ := listAccount(h)
	forged, _ := makeList(host, &pb.ListBody{AccountId: ta.id, Counter: 9, PreviousHash: ta.id, Devices: ta.devices})
	for i := 0; i < 5; i++ {
		hc.send(publishFrame("forged", forged))
		hc.errorFor("forged")
		hc.send(publishFrame("old", ta.signed))
		hc.done("old")
	}
	p.send(publishFrame("p3", ta.next(phoneEntry(phone))))
	p.done("p3")
}

func TestLoginByList(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.MaxConnsPerKey = 2 })
	ta, phone, host, browser, _, _, _, _ := listAccount(h)
	for d, want := range map[*dev]pb.DeviceRole{&phone: pb.DeviceRole_DEVICE_ROLE_CLIENT, &browser: pb.DeviceRole_DEVICE_ROLE_CLIENT, &host: pb.DeviceRole_DEVICE_ROLE_HOST} {
		_, f := h.loginAs(*d, ta.id, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2)
		if w := f.GetWelcome(); w.GetRole() != want {
			t.Errorf("%x: %v, want %v", d.pub[:2], f, want)
		}
	}
	// The phone is at its cap of two connections: refused a third.
	if _, f := h.loginAs(phone, ta.id, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2); code(f.GetError()) != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
		t.Errorf("past the cap per key: %v", f)
	}
	// Another account's devices, and its read-only key.
	other := newDev(20)
	oid := h.signUp(other)
	for _, d := range []dev{other, readOnlyOf(other)} {
		if _, f := h.loginAs(d, ta.id, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2); code(f.GetError()) != pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED {
			t.Errorf("another account's key: %v", f)
		}
	}
	if _, f := h.loginAs(host, oid, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2); code(f.GetError()) != pb1.ErrorCode_ERROR_CODE_UNAUTHENTICATED {
		t.Errorf("a host in another account: %v", f)
	}
}

func TestConnsPerAccount(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.MaxConnsPerAccount = 2 })
	phone := newDev(1)
	id := h.signUp(phone)
	h.login(phone, id)
	h.login(readOnlyOf(phone), id)
	if _, f := h.loginAs(phone, id, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2); code(f.GetError()) != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
		t.Errorf("past the cap per account: %v", f)
	}
}

// openRaw opens the store's file in dir, under no server.
func openRaw(t *testing.T, dir string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "hosted.db")+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	return db
}
