package hosted

// The sealed copies: announcements and notices kept with their session,
// each given only to its recipient, and the account's names.

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	pb1 "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

// sealedAccount is an account with two phones, a browser and a computer,
// each connected, and each phone's read-only key.
type sealedAccount struct {
	ta                          *testAccount
	phone, phone2, browser, hst dev
	p, p2, b, hc, r, r2         *client
}

func newSealedAccount(h *harness) *sealedAccount {
	sa := &sealedAccount{phone: newDev(1), phone2: newDev(2), browser: newDev(4), hst: newDev(3)}
	id := h.signUp(sa.phone)
	sa.ta = h.accts[string(id)]
	h.publish(id, sa.ta.next(phoneEntry(sa.phone), phoneEntry(sa.phone2), entry(sa.browser, RoleClient), entry(sa.hst, RoleComputer)))
	sa.p, _ = h.login(sa.phone, id)
	sa.p2, _ = h.login(sa.phone2, id)
	sa.b, _ = h.login(sa.browser, id)
	sa.hc, _ = h.login(sa.hst, id)
	sa.r, _ = h.login(readOnlyOf(sa.phone), id)
	sa.r2, _ = h.login(readOnlyOf(sa.phone2), id)
	return sa
}

func box(d dev) []byte          { return derived(d, "box") }
func notification(d dev) []byte { return derived(d, "notification") }

func subscribe(c *client) *pb.SessionList {
	c.t.Helper()
	c.send(&pb.Frame{Body: &pb.Frame_SubscribeSessions{SubscribeSessions: &pb.SubscribeSessions{}}})
	return c.until("SessionList", func(f *pb.Frame) bool { return f.GetSessionList() != nil }).GetSessionList()
}

// fetch is every notice a read-only connection is given, and the frames
// they came in.
func fetch(c *client, id string) ([]*pb.StoredNotice, []*pb.Notices) {
	c.t.Helper()
	c.send(&pb.Frame{Body: &pb.Frame_FetchNotices{FetchNotices: &pb.FetchNotices{RequestId: id}}})
	var all []*pb.StoredNotice
	var frames []*pb.Notices
	for {
		f := c.until("Notices "+id, func(f *pb.Frame) bool {
			return f.GetNotices().GetRequestId() == id || f.GetError().GetRequestId() == id
		})
		if f.GetError() != nil {
			c.t.Fatalf("fetching %s: %v", id, f.GetError())
		}
		frames = append(frames, f.GetNotices())
		all = append(all, f.GetNotices().GetNotices()...)
		if !f.GetNotices().GetMore() {
			return all, frames
		}
	}
}

// sealedOf is the copies of the session the relay holds, by kind.
func (h *harness) sealedOf(id []byte, ref *pb1.SessionRef) (ann, notices copies) {
	h.srv.mu.Lock()
	defer h.srv.mu.Unlock()
	if a := h.srv.accounts[string(id)]; a != nil {
		if se := a.sessions[idOf(ref)]; se != nil {
			return se.announcements, se.notices
		}
	}
	return nil, nil
}

func sized(key []byte, n int) *pb.SealedCopy {
	return &pb.SealedCopy{RecipientKey: key, Sealed: bytes.Repeat([]byte{7}, n)}
}

func TestSealedCopies(t *testing.T) {
	h := newHarness(t, nil)
	sa := newSealedAccount(h)
	id := sa.ta.id
	ref := &pb1.SessionRef{HostKey: sa.hst.pub, SessionId: "s1", InstanceId: "i1"}
	stranger := newDev(9)
	ann := []*pb.SealedCopy{sealedTo(box(sa.phone), "phone"), sealedTo(box(sa.browser), "browser"), sealedTo(box(stranger), "stranger"), sealedTo(notification(sa.phone), "a notice key")}
	notices := []*pb.SealedCopy{sealedTo(notification(sa.phone), "n phone"), sealedTo(notification(sa.phone2), "n phone2"), sealedTo(box(sa.browser), "a box key")}
	for _, c := range []*client{sa.p, sa.p2, sa.b} {
		subscribe(c)
	}
	sa.hc.send(announceFrame(ref, ann, notices))
	h.waitSessions(id, 1)

	// Each client is given the copy sealed to its box key, or none.
	for _, w := range []struct {
		c    *client
		want []byte
	}{{sa.p, sealedTo(box(sa.phone), "phone").Sealed}, {sa.b, sealedTo(box(sa.browser), "browser").Sealed}, {sa.p2, nil}} {
		u := w.c.until("SessionUpdated", func(f *pb.Frame) bool { return f.GetSessionUpdated() != nil }).GetSessionUpdated()
		if !bytes.Equal(u.Entry.Sealed, w.want) || !proto.Equal(u.Entry.Session, ref) {
			t.Errorf("%x was given %v", w.c.key.pub[:4], u.Entry)
		}
	}
	if l := subscribe(sa.b); len(l.Sessions) != 1 || !bytes.Equal(l.Sessions[0].Sealed, sealedTo(box(sa.browser), "browser").Sealed) {
		t.Errorf("the browser's list %v", l)
	}
	// Copies to keys not on the list, or not of the kind, are dropped.
	if a, n := h.sealedOf(id, ref); len(a) != 2 || len(n) != 2 || a[string(box(stranger))] != nil || n[string(box(sa.browser))] != nil {
		t.Errorf("held %d announcements and %d notices", len(a), len(n))
	}
	// Each read-only key is given its own phone's notice.
	for _, w := range []struct {
		r    *client
		want string
	}{{sa.r, "n phone"}, {sa.r2, "n phone2"}} {
		ns, _ := fetch(w.r, "f")
		if len(ns) != 1 || !bytes.HasSuffix(ns[0].Sealed, []byte(w.want)) || !proto.Equal(ns[0].Session, ref) || !ns[0].StoredAt.AsTime().Equal(t0) {
			t.Errorf("%s: %v", w.want, ns)
		}
	}

	// Refused, keeping what is stored: a recipient twice, 11 copies of a
	// kind, a copy too short or too long, an instance not the
	// connection's.
	eleven := make([]*pb.SealedCopy, 11)
	for i := range eleven {
		eleven[i] = sized(box(newDev(byte(20+i))), MinSealedBytes)
	}
	for _, c := range []struct {
		about        string
		ref          *pb1.SessionRef
		ann, notices []*pb.SealedCopy
		code         pb1.ErrorCode
	}{
		{"a recipient twice", ref, []*pb.SealedCopy{sized(box(sa.phone), 50), sized(box(sa.phone), 60)}, nil, pb1.ErrorCode_ERROR_CODE_INVALID},
		{"a notice recipient twice", ref, nil, []*pb.SealedCopy{sized(notification(sa.phone), 50), sized(notification(sa.phone), 50)}, pb1.ErrorCode_ERROR_CODE_INVALID},
		{"a recipient twice, unlisted", ref, []*pb.SealedCopy{sized(box(stranger), 50), sized(box(stranger), 50)}, nil, pb1.ErrorCode_ERROR_CODE_INVALID},
		{"eleven", ref, eleven, nil, pb1.ErrorCode_ERROR_CODE_INVALID},
		{"39 bytes", ref, []*pb.SealedCopy{sized(box(sa.phone), MinSealedBytes-1)}, nil, pb1.ErrorCode_ERROR_CODE_INVALID},
		{"8,193 bytes", ref, []*pb.SealedCopy{sized(box(sa.phone), MaxSealedBytes+1)}, nil, pb1.ErrorCode_ERROR_CODE_TOO_LARGE},
		{"a notice of 8,193 bytes", ref, nil, []*pb.SealedCopy{sized(notification(sa.phone), MaxSealedBytes+1)}, pb1.ErrorCode_ERROR_CODE_TOO_LARGE},
		{"another instance", &pb1.SessionRef{HostKey: sa.hst.pub, SessionId: "s1", InstanceId: "i2"}, nil, nil, pb1.ErrorCode_ERROR_CODE_INVALID},
	} {
		sa.hc.send(announceFrame(c.ref, c.ann, c.notices))
		if e := sa.hc.anError(); e.Code != c.code {
			t.Errorf("%s: %v", c.about, e)
		}
	}
	sa.p.quiet("an update after refusals", func(f *pb.Frame) bool { return f.GetSessionUpdated() != nil })
	if a, n := h.sealedOf(id, ref); !bytes.Equal(a[string(box(sa.phone))], sealedTo(box(sa.phone), "phone").Sealed) || len(n) != 2 {
		t.Errorf("after refusals, held %v and %v", a, n)
	}

	// At the bounds, taken; each announcement replaces both kinds wholly.
	sa.hc.send(announceFrame(ref, []*pb.SealedCopy{sized(box(sa.phone), MaxSealedBytes), sized(box(sa.browser), MinSealedBytes)}, nil))
	if u := sa.p.until("SessionUpdated", func(f *pb.Frame) bool { return f.GetSessionUpdated() != nil }).GetSessionUpdated(); len(u.Entry.Sealed) != MaxSealedBytes {
		t.Errorf("at the cap: %d bytes", len(u.Entry.Sealed))
	}
	sa.hc.send(announceFrame(ref, []*pb.SealedCopy{sealedTo(box(sa.browser), "browser 2")}, nil))
	if u := sa.p.until("SessionUpdated", func(f *pb.Frame) bool { return f.GetSessionUpdated() != nil }).GetSessionUpdated(); len(u.Entry.Sealed) != 0 {
		t.Errorf("the phone left out still has %x", u.Entry.Sealed)
	}
	if ns, _ := fetch(sa.r, "g"); len(ns) != 0 {
		t.Errorf("notices left out still given: %v", ns)
	}
}

// Every frame but FetchNotices from a read-only key is refused.
func TestReadOnlyNarrowed(t *testing.T) {
	h := newHarness(t, nil)
	sa := newSealedAccount(h)
	ref := &pb1.SessionRef{HostKey: sa.hst.pub, SessionId: "s1", InstanceId: "i1"}
	sa.hc.send(announceFrame(ref, []*pb.SealedCopy{sealedTo(box(sa.phone), "x")}, nil))
	h.waitSessions(sa.ta.id, 1)
	for i, f := range []*pb.Frame{
		{Body: &pb.Frame_SubscribeSessions{SubscribeSessions: &pb.SubscribeSessions{}}},
		{Body: &pb.Frame_WatchDevices{WatchDevices: &pb.WatchDevices{}}},
		{Body: &pb.Frame_PublishList{PublishList: &pb.PublishList{RequestId: "r", List: sa.ta.signed}}},
		{Body: &pb.Frame_PublishNames{PublishNames: &pb.PublishNames{RequestId: "r"}}},
		{Body: &pb.Frame_OpenChannel{OpenChannel: &pb.OpenChannel{RequestId: "r", HostKey: sa.hst.pub, InstanceId: "i1", Message: make([]byte, OpenMessageBytes)}}},
		{Body: &pb.Frame_SessionAnnounce{SessionAnnounce: &pb.SessionAnnounce{Session: ref}}},
		{Body: &pb.Frame_RegisterPush{RegisterPush: &pb.RegisterPush{RequestId: "r", Handle: "h"}}},
		{Body: &pb.Frame_JoinLookup{JoinLookup: &pb.JoinLookup{RequestId: "r", Lookup: "ABCD"}}},
		{Body: &pb.Frame_DeleteAccount{DeleteAccount: &pb.DeleteAccount{RequestId: "r"}}},
	} {
		sa.r.send(f)
		if e := sa.r.until("an error", func(f *pb.Frame) bool {
			return f.GetError() != nil || f.GetSessionList() != nil || f.GetDevices() != nil || f.GetChannelOpened() != nil
		}).GetError(); e.GetCode() != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
			t.Errorf("frame %d from a read-only key: %v", i, e)
		}
	}
	sa.hc.quiet("an open channel", func(f *pb.Frame) bool { return f.GetOpenChannel() != nil })
	if _, ok, _ := h.cfg.Store.List(sa.ta.id); !ok {
		t.Error("the account went")
	}
}

// A notice stays fetchable for NoticeRetention after its session ends,
// and goes at once with its computer or its recipient.
func TestNoticesAfterTheSession(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.NoticeRetention = time.Second })
	sa := newSealedAccount(h)
	id := sa.ta.id
	ref := func(s string) *pb1.SessionRef {
		return &pb1.SessionRef{HostKey: sa.hst.pub, SessionId: s, InstanceId: "i1"}
	}
	all := []*pb.SealedCopy{sealedTo(notification(sa.phone), "n1"), sealedTo(notification(sa.phone2), "n2")}
	announce := func(s string) {
		sa.hc.send(announceFrame(ref(s), []*pb.SealedCopy{sealedTo(box(sa.phone), s)}, all))
	}
	subscribe(sa.p)
	announce("ended")
	announce("live")
	h.waitSessions(id, 2)
	sa.hc.send(&pb.Frame{Body: &pb.Frame_SessionEnd{SessionEnd: &pb.SessionEnd{Session: ref("ended")}}})
	sa.p.until("SessionEnded", func(f *pb.Frame) bool { return f.GetSessionEnded() != nil })
	if l := subscribe(sa.p); len(l.Sessions) != 1 || l.Sessions[0].Session.SessionId != "live" {
		t.Errorf("the ended session's announcement is still listed: %v", l)
	}
	if ns, _ := fetch(sa.r, "a"); len(ns) != 2 {
		t.Fatalf("after SessionEnd, %d notices", len(ns))
	}
	// Then the computer's connection closes: its live session's notice
	// is kept too, and so is the account, with no connection.
	sa.hc.ws.Close(websocket.StatusNormalClosure, "")
	sa.p.until("SessionEnded", func(f *pb.Frame) bool { return f.GetSessionEnded() != nil })
	for _, c := range []*client{sa.p, sa.p2, sa.b, sa.r, sa.r2} {
		c.ws.Close(websocket.StatusNormalClosure, "")
	}
	time.Sleep(50 * time.Millisecond)
	r, _ := h.login(readOnlyOf(sa.phone), id)
	if ns, _ := fetch(r, "b"); len(ns) != 2 || !bytes.HasSuffix(ns[0].Sealed, []byte("n1")) {
		t.Fatalf("with no connection meanwhile, %v", ns)
	}
	// Removing phone2 deletes the notices sealed to it at once.
	r2, _ := h.login(readOnlyOf(sa.phone2), id)
	if ns, _ := fetch(r2, "c"); len(ns) != 2 {
		t.Fatalf("phone2's notices: %v", ns)
	}
	h.publish(id, sa.ta.next(phoneEntry(sa.phone), entry(sa.browser, RoleClient), entry(sa.hst, RoleComputer)))
	h.srv.mu.Lock()
	for e := range h.srv.accounts[string(id)].ended {
		if e.notices[string(notification(sa.phone2))] != nil {
			t.Error("a kept notice to a removed phone")
		}
	}
	h.srv.mu.Unlock()
	// After NoticeRetention, gone.
	time.Sleep(1100 * time.Millisecond)
	if ns, _ := fetch(r, "d"); len(ns) != 0 {
		t.Errorf("after the retention, %v", ns)
	}
	// Nothing kept holds the account in memory once its connections go.
	h.srv.mu.Lock()
	if n := len(h.srv.accounts[string(id)].ended); n != 0 {
		t.Errorf("%d kept notices after the retention", n)
	}
	h.srv.mu.Unlock()

	// A removed computer's notices go at once, ended or live.
	hc, _ := h.login(sa.hst, id)
	hc.send(announceFrame(ref("e2"), nil, all[:1]))
	h.waitSessions(id, 1)
	hc.send(announceFrame(ref("e3"), nil, all[:1]))
	h.waitSessions(id, 2)
	hc.send(&pb.Frame{Body: &pb.Frame_SessionEnd{SessionEnd: &pb.SessionEnd{Session: ref("e2")}}})
	h.waitSessions(id, 1)
	if ns, _ := fetch(r, "e"); len(ns) != 2 {
		t.Fatalf("before the removal, %v", ns)
	}
	h.publish(id, sa.ta.next(phoneEntry(sa.phone), entry(sa.browser, RoleClient)))
	if ns, _ := fetch(r, "f"); len(ns) != 0 {
		t.Errorf("a removed computer's notices: %v", ns)
	}
}

// Announcements are deleted with their recipient's removal.
func TestCopiesOfARemovedRecipient(t *testing.T) {
	h := newHarness(t, nil)
	sa := newSealedAccount(h)
	id := sa.ta.id
	ref := &pb1.SessionRef{HostKey: sa.hst.pub, SessionId: "s1", InstanceId: "i1"}
	sa.hc.send(announceFrame(ref, []*pb.SealedCopy{sealedTo(box(sa.phone), "p"), sealedTo(box(sa.browser), "b")}, nil))
	h.waitSessions(id, 1)
	h.publish(id, sa.ta.next(phoneEntry(sa.phone), phoneEntry(sa.phone2), entry(sa.hst, RoleComputer)))
	if a, _ := h.sealedOf(id, ref); len(a) != 1 || a[string(box(sa.browser))] != nil {
		t.Errorf("after the browser's removal, %v", a)
	}
}

func TestNoticesSplit(t *testing.T) {
	const n = 70
	h := newHarness(t, func(c *Config) {
		c.MaxFrameBytes = MinMaxFrameBytes
		c.MaxSessionsPerConn, c.MaxAnnounceBurst = n, n
	})
	sa := newSealedAccount(h)
	for i := 0; i < n; i++ {
		ref := &pb1.SessionRef{HostKey: sa.hst.pub, SessionId: fmt.Sprintf("s%d", i), InstanceId: "i1"}
		sa.hc.send(announceFrame(ref, nil, []*pb.SealedCopy{sized(notification(sa.phone), MaxSealedBytes)}))
	}
	h.waitSessions(sa.ta.id, n)
	ns, frames := fetch(sa.r, "f")
	seen := map[string]bool{}
	for _, x := range ns {
		seen[x.Session.SessionId] = true
	}
	if len(ns) != n || len(seen) != n || len(frames) != 2 || !frames[0].More || frames[1].More {
		t.Errorf("%d notices in %d frames", len(ns), len(frames))
	}
}

func TestSealedCaps(t *testing.T) {
	ref := func(d dev, s string) *pb1.SessionRef {
		return &pb1.SessionRef{HostKey: d.pub, SessionId: s, InstanceId: "i1"}
	}
	t.Run("bytes per account", func(t *testing.T) {
		h := newHarness(t, func(c *Config) { c.MaxSealedBytesPerAccount = 3 * MaxSealedBytes })
		sa := newSealedAccount(h)
		big := []*pb.SealedCopy{sized(box(sa.phone), MaxSealedBytes)}
		sa.hc.send(announceFrame(ref(sa.hst, "a"), big, big[:0]))
		sa.hc.send(announceFrame(ref(sa.hst, "b"), big, []*pb.SealedCopy{sized(notification(sa.phone), MaxSealedBytes)}))
		h.waitSessions(sa.ta.id, 2)
		sa.hc.send(announceFrame(ref(sa.hst, "c"), big, nil))
		if e := sa.hc.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
			t.Errorf("past the account's bytes: %v", e)
		}
		// Replacing a session's copies counts only the difference.
		sa.hc.send(announceFrame(ref(sa.hst, "b"), big, nil))
		sa.hc.quiet("an error", func(f *pb.Frame) bool { return f.GetError() != nil })
	})
	t.Run("sessions per account", func(t *testing.T) {
		h := newHarness(t, func(c *Config) { c.MaxSessionsPerAccount = 2 })
		sa := newSealedAccount(h)
		for _, s := range []string{"a", "b", "c"} {
			sa.hc.send(announceFrame(ref(sa.hst, s), nil, nil))
		}
		if e := sa.hc.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
			t.Errorf("past the account's sessions: %v", e)
		}
	})
	t.Run("announcements at once", func(t *testing.T) {
		h := newHarness(t, func(c *Config) { c.MaxAnnounceBurst = 3 })
		sa := newSealedAccount(h)
		for i := 0; i < 4; i++ {
			sa.hc.send(announceFrame(ref(sa.hst, "a"), nil, nil))
		}
		if e := sa.hc.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
			t.Errorf("past the burst: %v", e)
		}
	})
	t.Run("fetches a minute", func(t *testing.T) {
		h := newHarness(t, func(c *Config) { c.MaxNoticeFetchesPerMinute = 2 })
		sa := newSealedAccount(h)
		fetch(sa.r, "a")
		fetch(sa.r, "b")
		sa.r.send(&pb.Frame{Body: &pb.Frame_FetchNotices{FetchNotices: &pb.FetchNotices{RequestId: "c"}}})
		if e := sa.r.errorFor("c"); e.Code != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
			t.Errorf("past the fetches: %v", e)
		}
	})
}

// The largest honest announcement, from the format (docs/e2e.md, section
// 5; e2e/sealed.ts): every field at its cap and a 128-byte session ID,
// sealed with a nonce and a MAC, is within the relay's bound, as are
// sealed.json's at-cap cases, whose lengths only are read.
func TestLargestAnnouncement(t *testing.T) {
	at := func(n int) []byte { return bytes.Repeat([]byte{'x'}, n) }
	seal := func(context string, body proto.Message) int {
		b, err := proto.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		prefix := framed(context, at(32), at(32), at(MaxIDBytes), at(8))
		return 24 + len(prefix) + len(b) + 16
	}
	ann := seal("pirc-e2e-v2 announcement", &pb.Announcement{SessionName: at(200), Folder: at(1024), Model: at(200), ComputerName: at(200), Notice: at(4096)})
	notice := seal("pirc-e2e-v2 notice", &pb.Notice{SessionName: at(200), ComputerName: at(200), Notice: at(4096)})
	if ann != 6005 || notice >= ann || ann > MaxSealedBytes {
		t.Errorf("the largest announcement %d bytes, notice %d, the bound %d", ann, notice, MaxSealedBytes)
	}

	data, err := os.ReadFile(filepath.Join("..", "..", "..", "cases", "e2e", "sealed.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Cases []struct {
			About  string `json:"about"`
			Sealed string `json:"sealed"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, c := range f.Cases {
		if !strings.Contains(c.About, "every field exactly at its cap") {
			continue
		}
		b, err := hex.DecodeString(c.Sealed)
		if err != nil {
			t.Fatal(err)
		}
		if len(b) < MinSealedBytes || len(b) > ann {
			t.Errorf("%s: %d bytes", c.About, len(b))
		}
		n++
	}
	if n != 2 {
		t.Errorf("%d at-cap cases", n)
	}
}

func namesFrame(id string, cs ...*pb.SealedCopy) *pb.Frame {
	return &pb.Frame{Body: &pb.Frame_PublishNames{PublishNames: &pb.PublishNames{RequestId: id, Copies: cs}}}
}

func watch(c *client) *pb.Devices {
	c.t.Helper()
	c.send(&pb.Frame{Body: &pb.Frame_WatchDevices{WatchDevices: &pb.WatchDevices{}}})
	return c.until("Devices", func(f *pb.Frame) bool { return f.GetDevices() != nil }).GetDevices()
}

func TestNames(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.MaxNamesPublishesPerAccount = 4 })
	sa := newSealedAccount(h)
	id := sa.ta.id
	stranger := newDev(9)
	for _, c := range []*client{sa.p, sa.p2, sa.b} {
		if d := watch(c); len(d.Names) != 0 {
			t.Errorf("names before any: %x", d.Names)
		}
	}
	big := sized(box(sa.phone2), MaxNamesBytes)
	sa.p.send(namesFrame("n1", sealedTo(box(sa.phone), "p"), big, sealedTo(box(sa.browser), "b"), sealedTo(box(stranger), "s")))
	sa.p.done("n1")
	for _, w := range []struct {
		c    *client
		want []byte
	}{{sa.p, sealedTo(box(sa.phone), "p").Sealed}, {sa.p2, big.Sealed}, {sa.b, sealedTo(box(sa.browser), "b").Sealed}} {
		if d := w.c.until("Devices", func(f *pb.Frame) bool { return f.GetDevices() != nil }).GetDevices(); !bytes.Equal(d.Names, w.want) || len(d.Devices) != 4 {
			t.Errorf("%x was given names %d bytes", w.c.key.pub[:4], len(d.Names))
		}
	}
	if got, _ := h.cfg.Store.Names(id); len(got) != 3 {
		t.Errorf("stored %d names copies", len(got))
	}
	// Only the account's phone publishes them: not another phone, a
	// browser or a computer.
	for _, c := range []*client{sa.p2, sa.b, sa.hc} {
		c.send(namesFrame("x", sealedTo(box(sa.browser), "forged")))
		if e := c.errorFor("x"); e.Code != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
			t.Errorf("names from %x: %v", c.key.pub[:4], e)
		}
	}
	// Refusals keep what is stored.
	for _, c := range []struct {
		copies []*pb.SealedCopy
		code   pb1.ErrorCode
	}{
		{[]*pb.SealedCopy{sized(box(sa.browser), MaxNamesBytes+1)}, pb1.ErrorCode_ERROR_CODE_TOO_LARGE},
		{[]*pb.SealedCopy{sized(box(sa.browser), MinSealedBytes-1)}, pb1.ErrorCode_ERROR_CODE_INVALID},
		{[]*pb.SealedCopy{sized(box(sa.browser), 50), sized(box(sa.browser), 50)}, pb1.ErrorCode_ERROR_CODE_INVALID},
	} {
		sa.p.send(namesFrame("r", c.copies...))
		if e := sa.p.errorFor("r"); e.Code != c.code {
			t.Errorf("refused names: %v", e)
		}
	}
	if d := watch(sa.b); !bytes.Equal(d.Names, sealedTo(box(sa.browser), "b").Sealed) {
		t.Errorf("after refusals, %x", d.Names)
	}
	// Each publish replaces every copy.
	sa.p.send(namesFrame("n2", sealedTo(box(sa.phone), "p2")))
	sa.p.done("n2")
	if d := sa.b.until("Devices", func(f *pb.Frame) bool { return f.GetDevices() != nil }).GetDevices(); len(d.Names) != 0 {
		t.Errorf("the browser left out still has %x", d.Names)
	}
	// Removing a client deletes its copy.
	sa.p.send(namesFrame("n3", sealedTo(box(sa.phone), "p3"), sealedTo(box(sa.browser), "b3")))
	sa.p.done("n3")
	h.publish(id, sa.ta.next(phoneEntry(sa.phone), phoneEntry(sa.phone2), entry(sa.hst, RoleComputer)))
	if got, _ := h.cfg.Store.Names(id); len(got) != 1 || got[string(box(sa.browser))] != nil {
		t.Errorf("after the browser's removal, %d copies", len(got))
	}
	// The hourly cap: four taken, the fifth refused.
	p, _ := h.login(sa.phone, id)
	p.send(namesFrame("n4", sealedTo(box(sa.phone), "p4")))
	p.done("n4")
	p.send(namesFrame("n5"))
	if e := p.errorFor("n5"); e.Code != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
		t.Errorf("past the cap: %v", e)
	}
	// Kept across a restart, delivered at WatchDevices.
	h.restart()
	p, _ = h.login(sa.phone, id)
	if d := watch(p); !bytes.Equal(d.Names, sealedTo(box(sa.phone), "p4").Sealed) {
		t.Errorf("after a restart, %x", d.Names)
	}
}

// A session announced again after it ended has its notice once.
func TestNoticeOfASessionAnnouncedAgain(t *testing.T) {
	h := newHarness(t, nil)
	sa := newSealedAccount(h)
	id := sa.ta.id
	ref := &pb1.SessionRef{HostKey: sa.hst.pub, SessionId: "s1", InstanceId: "i1"}
	notice := []*pb.SealedCopy{sealedTo(notification(sa.phone), "n1")}
	sa.hc.send(announceFrame(ref, nil, notice))
	h.waitSessions(id, 1)
	sa.hc.send(&pb.Frame{Body: &pb.Frame_SessionEnd{SessionEnd: &pb.SessionEnd{Session: ref}}})
	h.waitSessions(id, 0)
	sa.hc.send(announceFrame(ref, nil, notice))
	h.waitSessions(id, 1)
	if ns, _ := fetch(sa.r, "a"); len(ns) != 1 {
		t.Errorf("a session announced again: %d notices", len(ns))
	}
}
