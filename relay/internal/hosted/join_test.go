package hosted

import (
	"bytes"
	"fmt"
	"testing"
	"time"

	"github.com/coder/websocket"

	pb1 "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

// joinWait sends JoinWait and waits for the relay to hold it, or for an
// error.
func (h *harness) joinWait(c *client, lookup string, att *pb.Attestation) {
	h.t.Helper()
	c.send(&pb.Frame{Body: &pb.Frame_JoinWait{JoinWait: &pb.JoinWait{Lookup: lookup, Attestation: att}}})
	for i := 0; i < 400; i++ {
		h.srv.mu.Lock()
		w := h.srv.joins.waits[lookup]
		h.srv.mu.Unlock()
		if w != nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (h *harness) waiting(lookup string) bool {
	h.srv.mu.Lock()
	defer h.srv.mu.Unlock()
	return h.srv.joins.waits[lookup] != nil
}

func lookupFrame(id, l string) *pb.Frame {
	return &pb.Frame{Body: &pb.Frame_JoinLookup{JoinLookup: &pb.JoinLookup{RequestId: id, Lookup: l}}}
}

func isPaired(f *pb.Frame) bool { return f.GetJoinPaired() != nil }

func (h *harness) attestations(account, device []byte) int {
	h.t.Helper()
	var n int
	if err := h.srv.store.db.QueryRow(`SELECT count(*) FROM attestations WHERE account = ? AND device = ?`, account, device).Scan(&n); err != nil {
		h.t.Fatal(err)
	}
	return n
}

func TestJoinLookupLength(t *testing.T) {
	h := newHarness(t, nil)
	d, _ := h.login(newDev(5), nil)
	for _, l := range []string{"K7QM", "K7QMK7Q", "K7QMK7QMK", "k7qmk7qm", "K7QMK7QU"} {
		d.send(&pb.Frame{Body: &pb.Frame_JoinWait{JoinWait: &pb.JoinWait{Lookup: l}}})
		if e := d.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_INVALID {
			t.Errorf("lookup %q: %v", l, e)
		}
	}
}

func TestJoinLookupOnlyThePhone(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.MaxLookupsPerAccount = 1 })
	_, _, _, _, p, _, b, _ := listAccount(h)
	d, _ := h.login(newDev(5), nil)
	h.joinWait(d, "K7QMK7QM", nil)
	// Another client of the account is refused, and the wait stays and the
	// account's lookups are not spent.
	b.send(lookupFrame("b", "K7QMK7QM"))
	if e := b.errorFor("b"); e.Code != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Fatalf("another client's lookup: %v", e)
	}
	if !h.waiting("K7QMK7QM") {
		t.Fatal("a refused lookup ended the wait")
	}
	p.send(lookupFrame("p", "K7QMK7QM"))
	p.until("JoinPaired", isPaired)
	d.until("JoinPaired", isPaired)
}

func TestJoinSteps(t *testing.T) {
	h := newHarness(t, nil)
	_, _, _, _, p, _, _, _ := listAccount(h)
	d, _ := h.login(newDev(5), nil)
	h.joinWait(d, "K7QMK7QM", nil)
	p.send(lookupFrame("p", "K7QMK7QM"))
	id := p.until("JoinPaired", isPaired).GetJoinPaired().JoinId
	d.until("JoinPaired", isPaired)
	step := func(n int) {
		d.send(&pb.Frame{Body: &pb.Frame_JoinMessage{JoinMessage: &pb.JoinMessage{JoinId: id, Step: bytes.Repeat([]byte{1}, n)}}})
	}
	step(65536)
	if e := d.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_TOO_LARGE {
		t.Fatalf("a step of 65,536 bytes: %v", e)
	}
	// The refused step is not counted: eight of 65,535 bytes pass.
	for i := 0; i < 8; i++ {
		step(65535)
		if m := p.until("JoinMessage", func(f *pb.Frame) bool { return f.GetJoinMessage() != nil }).GetJoinMessage(); len(m.Step) != 65535 {
			t.Fatalf("step %d: %d bytes", i+1, len(m.Step))
		}
	}
	step(1)
	if e := d.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_INVALID {
		t.Fatalf("the ninth step: %v", e)
	}
	p.until("JoinEnded", func(f *pb.Frame) bool { return f.GetJoinEnded() != nil })
}

func TestJoinAttestationOnceListed(t *testing.T) {
	h := newHarness(t, nil)
	ta, phone, host, browser, p, _, _, _ := listAccount(h)
	id := ta.id
	dd := newDev(9)
	d, _ := h.login(dd, nil)
	h.joinWait(d, "K7QMK7QM", testAttestation)
	p.send(lookupFrame("p", "K7QMK7QM"))
	p.until("JoinPaired", isPaired)
	d.until("JoinPaired", isPaired)
	if n := h.attestations(id, dd.pub); n != 0 {
		t.Fatalf("an attestation stored at pairing: %d", n)
	}
	// A version without the device stores nothing.
	h.publish(id, ta.next(phoneEntry(phone), entry(host, RoleComputer), entry(browser, RoleClient)))
	if n := h.attestations(id, dd.pub); n != 0 {
		t.Fatalf("an attestation stored by a version without the device: %d", n)
	}
	// A phone's attestation is not stored for a key listed as a computer.
	h.publish(id, ta.next(phoneEntry(phone), entry(host, RoleComputer), entry(browser, RoleClient), entry(dd, RoleComputer)))
	if n := h.attestations(id, dd.pub); n != 0 {
		t.Fatalf("an attestation stored for a computer: %d", n)
	}
	h.publish(id, ta.next(phoneEntry(phone), entry(host, RoleComputer), entry(browser, RoleClient), entry(dd, RoleClient)))
	if n := h.attestations(id, dd.pub); n != 1 {
		t.Fatalf("attestation rows once listed: %d", n)
	}
}

func TestJoinFailedLeavesNoAttestation(t *testing.T) {
	h := newHarness(t, nil)
	ta, phone, host, browser, p, _, _, _ := listAccount(h)
	dd := newDev(9)
	d, _ := h.login(dd, nil)
	h.joinWait(d, "K7QMK7QM", testAttestation)
	p.send(lookupFrame("p", "K7QMK7QM"))
	jid := p.until("JoinPaired", isPaired).GetJoinPaired().JoinId
	d.until("JoinPaired", isPaired)
	p.send(&pb.Frame{Body: &pb.Frame_JoinEnded{JoinEnded: &pb.JoinEnded{JoinId: jid}}})
	d.until("JoinEnded", func(f *pb.Frame) bool { return f.GetJoinEnded() != nil })
	// Listed after the join is over: nothing is stored.
	h.publish(ta.id, ta.next(phoneEntry(phone), entry(host, RoleComputer), entry(browser, RoleClient), entry(dd, RoleClient)))
	if n := h.attestations(ta.id, dd.pub); n != 0 {
		t.Fatalf("a dead join stored an attestation: %d", n)
	}
}

func TestJoinWaitCaps(t *testing.T) {
	for name, tweak := range map[string]func(*Config){
		"per address":   func(c *Config) { c.MaxWaitsPerAddr = 2 },
		"on the server": func(c *Config) { c.MaxWaitsPerAddr = 10; c.MaxWaits = 2 },
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, tweak)
			for i := 0; i < 2; i++ {
				d, _ := h.login(newDev(byte(10+i)), nil)
				h.joinWait(d, fmt.Sprintf("K7QMK7Q%d", i), nil)
				if !h.waiting(fmt.Sprintf("K7QMK7Q%d", i)) {
					t.Fatalf("wait %d refused", i)
				}
			}
			d, _ := h.login(newDev(20), nil)
			d.send(&pb.Frame{Body: &pb.Frame_JoinWait{JoinWait: &pb.JoinWait{Lookup: "K7QMK7Q9"}}})
			if e := d.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
				t.Fatalf("a wait past the cap: %v", e)
			}
		})
	}
}

func TestNoAccountIdleClose(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.NoAccountIdle = 150 * time.Millisecond })
	idle, _ := h.login(newDev(5), nil)
	waiting, _ := h.login(newDev(6), nil)
	h.joinWait(waiting, "K7QMK7QM", nil)
	if code := idle.closedWith(); code != websocket.StatusPolicyViolation {
		t.Fatalf("idle connection closed with %v", code)
	}
	time.Sleep(400 * time.Millisecond)
	if !h.waiting("K7QMK7QM") {
		t.Fatal("a connection in a wait was closed")
	}
}

// An address many people share gets SharedAddrFactor times the caps; the
// harness's connections all come from 127.0.0.1.
func TestSharedAddrCaps(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.MaxWaitsPerAddr = 1; c.SharedAddrs = []string{"127.0.0.1"} })
	for i := 0; i < SharedAddrFactor; i++ {
		d, _ := h.login(newDev(byte(10+i)), nil)
		h.joinWait(d, fmt.Sprintf("K7QMK7%02d", i), nil)
		if !h.waiting(fmt.Sprintf("K7QMK7%02d", i)) {
			t.Fatalf("wait %d refused", i)
		}
	}
	d, _ := h.login(newDev(40), nil)
	d.send(&pb.Frame{Body: &pb.Frame_JoinWait{JoinWait: &pb.JoinWait{Lookup: "K7QMK799"}}})
	if e := d.anError(); e.Code != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
		t.Fatalf("a wait past the shared cap: %v", e)
	}
	if h.srv.addrCap("10.0.0.9", 4) != 4 || h.srv.addrCap("127.0.0.1", 4) != 4*SharedAddrFactor {
		t.Error("addrCap")
	}
}
