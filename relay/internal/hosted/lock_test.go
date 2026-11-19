package hosted

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/coder/websocket"

	pb1 "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

func TestLock(t *testing.T) {
	now := t0
	h := newHarness(t, func(c *Config) { c.Now = func() time.Time { return now } })
	ch, phone, read, host, p, r, hc := account2(h)
	ended := &fakeRechecker{answer: func(s Subscription) (Subscription, error) {
		return s, errors.New("the subscription has expired")
	}}

	// A day on, the store says the only subscription has ended: locked,
	// and every connection closed.
	now = now.Add(25 * time.Hour)
	h.srv.recheckDue(context.Background(), ended)
	for _, c := range []*client{p, r, hc} {
		if got := c.closedWith(); got != websocket.StatusPolicyViolation {
			t.Fatalf("closed with %v, want 1008", got)
		}
	}
	if locked, since, _ := h.cfg.Store.Locked(ch.id); !locked || since != now.UnixMilli() {
		t.Fatalf("locked %v since %d", locked, since)
	}

	// Hosts and read-only keys are refused; a client is let in, locked.
	for _, d := range []dev{host, read} {
		_, f := h.loginAs(d, ch.id, origin, pb.ProtocolVersion_PROTOCOL_VERSION_V1ALPHA2)
		if code(f.GetError()) != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
			t.Fatalf("a %x logged in to a locked account: %v", d.pub[:2], f)
		}
	}
	p, w := h.login(phone, ch.id)
	if !w.GetLocked() {
		t.Fatal("Welcome does not say locked")
	}
	// Its subscriptions, lapsed, so that the client says which ended.
	if subs := w.GetSubscriptions(); len(subs) != 1 || !subs[0].GetLapsed() || subs[0].GetRenews() || subs[0].GetStore() != pb.SubscriptionStore_SUBSCRIPTION_STORE_TEST {
		t.Fatalf("a locked account's subscriptions: %v", subs)
	}
	p.quiet("pre-keys or labels", func(f *pb.Frame) bool { return f.GetPreKeys() != nil || f.GetLabelState() != nil })
	p.send(&pb.Frame{Body: &pb.Frame_GetVersions{GetVersions: &pb.GetVersions{RequestId: "g", From: 1}}})
	if code(p.errorFor("g")) != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Fatal("a locked account answered GetVersions")
	}

	// A renewal the store takes unlocks it: Done, a close, and a login as
	// before.
	p.send(&pb.Frame{Body: &pb.Frame_RenewSubscription{RenewSubscription: &pb.RenewSubscription{RequestId: "n", Proof: &pb.RenewSubscription_GooglePlayToken{GooglePlayToken: "tok"}}}})
	p.done("n")
	if got := p.closedWith(); got != websocket.StatusNormalClosure {
		t.Fatalf("closed with %v after a renewal, want 1000", got)
	}
	if _, w := h.login(host, ch.id); w.GetLocked() || len(w.GetSubscriptions()) != 0 {
		t.Fatalf("still locked after a renewal, or a host told the subscriptions: %v", w)
	}
	if _, w := h.login(phone, ch.id); len(w.GetSubscriptions()) != 1 || w.GetSubscriptions()[0].GetLapsed() || !w.GetSubscriptions()[0].GetRenews() {
		t.Fatalf("a client's subscriptions after a renewal: %v", w.GetSubscriptions())
	}

	// Lapsed again, and left locked for 60 days: deleted.
	now = now.Add(25 * time.Hour)
	h.srv.recheckDue(context.Background(), ended)
	h.srv.deleteExpired()
	if v, _ := h.cfg.Store.Latest(ch.id); v == nil {
		t.Fatal("deleted at once")
	}
	now = now.Add(60*24*time.Hour + time.Minute)
	h.srv.deleteExpired()
	if v, _ := h.cfg.Store.Latest(ch.id); v != nil {
		t.Fatal("a locked account kept past 60 days")
	}
	if locked, _, _ := h.cfg.Store.Locked(ch.id); locked {
		t.Fatal("its subscriptions kept")
	}
}
