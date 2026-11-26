package hosted

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	pb1 "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

// trySignUp signs a new phone up with an invite code: the account's ID,
// or the error.
func (h *harness) trySignUp(phone dev, code string) ([]byte, *pb1.Error) {
	h.t.Helper()
	return h.trySignUpAs(newTestAccount(phone), code, testAttestation)
}

func (h *harness) trySignUpAs(ta *testAccount, code string, att *pb.Attestation) ([]byte, *pb1.Error) {
	h.t.Helper()
	phone := ta.phone
	c, _ := h.login(phone, nil)
	defer c.ws.Close(websocket.StatusNormalClosure, "")
	c.send(&pb.Frame{Body: &pb.Frame_SignUp{SignUp: &pb.SignUp{RequestId: "s", Attestation: att, InviteCode: code, List: ta.signed}}})
	f := c.until("SignedUp", func(f *pb.Frame) bool { return f.GetSignedUp() != nil || f.GetError() != nil })
	if e := f.GetError(); e != nil {
		return nil, e
	}
	h.accts[string(ta.id)] = ta
	return f.GetSignedUp().GetAccountId(), nil
}

func TestSignUpModes(t *testing.T) {
	now := t0
	h := newHarness(t, func(c *Config) { c.SignUps = ""; c.Now = func() time.Time { return now } })
	s := h.cfg.Store
	// No mode set anywhere: invite.
	if _, e := h.trySignUp(newDev(1), ""); code(e) != pb1.ErrorCode_ERROR_CODE_TOKEN_INVALID || !strings.Contains(e.Message, "need an invite") {
		t.Fatalf("no code: %v", e)
	}
	if _, e := h.trySignUp(newDev(1), "AAAA-BBBB-CCCC-DDDD"); code(e) != pb1.ErrorCode_ERROR_CODE_TOKEN_INVALID {
		t.Fatalf("an unknown code: %v", e)
	}
	// A code of two uses, typed in lower case with spaces, O for 0.
	inv := NewInviteCode()
	if err := s.AddInvite(inv, false, 2, now.Add(time.Hour), now, "beta"); err != nil {
		t.Fatal(err)
	}
	typed := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(inv, "-", " "), "0", "o"))
	for i := 2; i <= 3; i++ {
		if _, e := h.trySignUp(newDev(byte(i)), typed); e != nil {
			t.Fatalf("sign-up %d with %q: %v", i, typed, e)
		}
	}
	if _, e := h.trySignUp(newDev(4), inv); code(e) != pb1.ErrorCode_ERROR_CODE_TOKEN_INVALID {
		t.Fatalf("used up: %v", e)
	}
	// Expired.
	late := NewInviteCode()
	s.AddInvite(late, false, 5, now.Add(time.Hour), now, "")
	now = now.Add(2 * time.Hour)
	if _, e := h.trySignUp(newDev(5), late); code(e) != pb1.ErrorCode_ERROR_CODE_TOKEN_INVALID {
		t.Fatalf("expired: %v", e)
	}
	// Open: no code needed; a bad one is still refused.
	if err := s.SetSignUps(SignUpsOpen); err != nil {
		t.Fatal(err)
	}
	if _, e := h.trySignUp(newDev(6), ""); e != nil {
		t.Fatalf("open: %v", e)
	}
	// Closed: not even with a code.
	s.SetSignUps(SignUpsClosed)
	fresh := NewInviteCode()
	s.AddInvite(fresh, false, 5, now.Add(time.Hour), now, "")
	if _, e := h.trySignUp(newDev(7), fresh); code(e) != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Fatalf("closed: %v", e)
	}
	if err := s.SetSignUps("sometimes"); err == nil {
		t.Error("took an unknown mode")
	}
	// Back to invite: a code of one use.
	s.SetSignUps(SignUpsInvite)
	one := NewInviteCode()
	s.AddInvite(one, false, 1, now.Add(time.Hour), now, "")
	if _, e := h.trySignUp(newDev(8), one); e != nil {
		t.Fatal(e)
	}
	if is, _ := s.Invites(); len(is) != 4 {
		t.Fatalf("invites %d", len(is))
	}
	if n, err := s.RevokeInvites("abc"); err == nil || n != 0 {
		t.Error("revoked by a short ID")
	}
}

func TestReviewCode(t *testing.T) {
	now := t0
	h := newHarness(t, func(c *Config) {
		c.SignUps = SignUpsInvite
		c.Now = func() time.Time { return now }
		// A phone with no subscription at all.
		c.Verifier = noSubscription{}
	})
	s := h.cfg.Store
	inv := NewInviteCode()
	s.AddInvite(inv, false, 3, now.Add(time.Hour), now, "")
	if _, e := h.trySignUp(newDev(1), inv); code(e) != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Fatalf("an invite needs the subscription still: %v", e)
	}
	rev := NewInviteCode()
	s.AddInvite(rev, true, 3, now.Add(90*24*time.Hour), now, "App Review")
	id, e := h.trySignUp(newDev(2), rev)
	if e != nil {
		t.Fatalf("review: %v", e)
	}
	// A second review account, which buys a subscription.
	bought, e := h.trySignUp(newDev(3), rev)
	if e != nil {
		t.Fatal(e)
	}
	if err := s.AddSubscription(bought, Subscription{Kind: "test", Ident: []byte("paid"), Expires: now.Add(365 * 24 * time.Hour)}, now.Add(ReviewFor+24*time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	c, w := h.login(newDev(2), id)
	if subs := w.GetSubscriptions(); len(subs) != 1 || subs[0].GetStore() != pb.SubscriptionStore_SUBSCRIPTION_STORE_REVIEW || !subs[0].GetEnds().AsTime().Equal(now.Add(ReviewFor)) {
		t.Fatalf("subscriptions %v", subs)
	}
	// Asked about again before its end: no store asked, kept.
	never := &fakeRechecker{answer: func(Subscription) (Subscription, error) {
		t.Error("a store asked about a review subscription")
		return Subscription{}, errors.New("no")
	}}
	now = now.Add(ReviewFor - time.Hour)
	h.srv.recheckDue(context.Background(), never)
	if ok, _ := s.HasAccount(id); !ok {
		t.Fatal("deleted before its end")
	}
	// At its end: deleted, its connections closed.
	now = now.Add(2 * time.Hour)
	h.srv.recheckDue(context.Background(), never)
	if ok, _ := s.HasAccount(id); ok {
		t.Fatal("kept after its end")
	}
	if got := c.closedWith(); got != websocket.StatusPolicyViolation {
		t.Fatalf("closed with %v", got)
	}
	// The one a bought subscription carries on: kept, its review lapsed.
	if ok, _ := s.HasAccount(bought); !ok {
		t.Fatal("an account a subscription carries on deleted")
	}
	kept, _ := s.Subscriptions(bought)
	for _, k := range kept {
		if lapsed := k.Sub.Kind == reviewKind; k.Lapsed != lapsed || len(kept) != 2 {
			t.Fatalf("subscriptions %+v", kept)
		}
	}
	h.srv.recheckDue(context.Background(), never)
	if ok, _ := s.HasAccount(bought); !ok {
		t.Fatal("deleted the next time round")
	}
}

// noSubscription takes test attestations, and no phone has a subscription.
type noSubscription struct{ TestVerifier }

func (noSubscription) Subscribed(context.Context, []byte, *pb.Attestation) (Subscription, error) {
	return Subscription{}, errors.New("none")
}

func TestCheckInvite(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.SignUps = SignUpsInvite })
	s := h.cfg.Store
	rev := NewInviteCode()
	s.AddInvite(rev, true, 1, t0.Add(time.Hour), t0, "")
	c, _ := h.login(newDev(1), nil)
	ask := func(code string) *pb.Frame {
		c.send(&pb.Frame{Body: &pb.Frame_CheckInvite{CheckInvite: &pb.CheckInvite{RequestId: "q", InviteCode: code}}})
		return c.until("InviteChecked", func(f *pb.Frame) bool { return f.GetInviteChecked() != nil || f.GetError() != nil })
	}
	for _, q := range []struct {
		code          string
		valid, review bool
	}{{"", false, false}, {"nope", false, false}, {strings.ToLower(rev), true, true}} {
		got := ask(q.code).GetInviteChecked()
		if got.GetMode() != pb.SignUpMode_SIGN_UP_MODE_INVITE || got.GetValid() != q.valid || got.GetReview() != q.review || got.GetRequestId() != "q" {
			t.Errorf("%q: %v", q.code, got)
		}
	}
	s.SetSignUps(SignUpsClosed)
	if got := ask("").GetInviteChecked(); got.GetMode() != pb.SignUpMode_SIGN_UP_MODE_CLOSED {
		t.Errorf("closed: %v", got)
	}
	for i := 4; i < maxInviteChecks; i++ {
		ask("")
	}
	if e := ask("").GetError(); code(e) != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
		t.Errorf("past the cap: %v", e)
	}
}

// A sign-up tried again, its answer lost, whatever has changed since.
func TestSignUpAgain(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.SignUps = SignUpsInvite })
	s := h.cfg.Store
	inv := NewInviteCode()
	s.AddInvite(inv, false, 1, t0.Add(time.Hour), t0, "")
	ta := newTestAccount(newDev(1))
	id, e := h.trySignUpAs(ta, inv, testAttestation)
	if e != nil {
		t.Fatal(e)
	}
	// Its one use taken: the same key and version 1 still get the account.
	if again, e := h.trySignUpAs(ta, inv, testAttestation); e != nil || !bytes.Equal(again, id) {
		t.Fatalf("again: %x %v", again, e)
	}
	s.SetSignUps(SignUpsClosed)
	if again, e := h.trySignUpAs(ta, "", testAttestation); e != nil || !bytes.Equal(again, id) {
		t.Fatalf("again, closed: %x %v", again, e)
	}
}

// Codes are tried only after the attestation, and at most
// MaxInviteTriesPerAddr an hour from one address.
func TestInviteTries(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.SignUps = SignUpsInvite; c.MaxInviteTriesPerAddr = 3 })
	if _, e := h.trySignUpAs(newTestAccount(newDev(1)), "AAAA-BBBB-CCCC-DDDD", &pb.Attestation{}); code(e) != pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Fatalf("no attestation: %v", e)
	}
	for i := 0; i < 3; i++ {
		if _, e := h.trySignUp(newDev(byte(2+i)), "AAAA-BBBB-CCCC-DDDD"); code(e) != pb1.ErrorCode_ERROR_CODE_TOKEN_INVALID {
			t.Fatalf("try %d: %v", i, e)
		}
	}
	if _, e := h.trySignUp(newDev(9), "AAAA-BBBB-CCCC-DDDD"); code(e) != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
		t.Fatalf("past the cap: %v", e)
	}
	c, _ := h.login(newDev(10), nil)
	c.send(&pb.Frame{Body: &pb.Frame_CheckInvite{CheckInvite: &pb.CheckInvite{RequestId: "q", InviteCode: "x"}}})
	if e := c.until("Error", func(f *pb.Frame) bool { return f.GetError() != nil || f.GetInviteChecked() != nil }).GetError(); code(e) != pb1.ErrorCode_ERROR_CODE_RATE_LIMITED {
		t.Fatalf("CheckInvite past the cap: %v", e)
	}
	if _, err := h.cfg.Store.RevokeInvites("______"); err == nil {
		t.Error("revoked by a pattern")
	}
}

// gatedVerifier holds the first attestation until released.
type gatedVerifier struct {
	TestVerifier
	calls   *atomic.Int32
	entered chan struct{}
	release chan struct{}
}

func (g gatedVerifier) Attest(ctx context.Context, a *pb.Attestation, d []byte) (Attested, error) {
	if g.calls.Add(1) == 1 {
		close(g.entered)
		<-g.release
	}
	return g.TestVerifier.Attest(ctx, a, d)
}

// A retry that overlaps its first attempt: the first makes the account and
// uses the code's one use while the retry attests; the retry gets the
// account.
func TestSignUpRetryOverlaps(t *testing.T) {
	g := gatedVerifier{calls: &atomic.Int32{}, entered: make(chan struct{}), release: make(chan struct{})}
	h := newHarness(t, func(c *Config) { c.SignUps = SignUpsInvite; c.Verifier = g })
	inv := NewInviteCode()
	h.cfg.Store.AddInvite(inv, false, 1, t0.Add(time.Hour), t0, "")
	ta := newTestAccount(newDev(1))
	retry, _ := h.login(ta.phone, nil)
	retry.send(&pb.Frame{Body: &pb.Frame_SignUp{SignUp: &pb.SignUp{RequestId: "b", Attestation: testAttestation, InviteCode: inv, List: ta.signed}}})
	<-g.entered
	id, e := h.trySignUpAs(ta, inv, testAttestation)
	if e != nil {
		t.Fatal(e)
	}
	close(g.release)
	f := retry.until("SignedUp", func(f *pb.Frame) bool { return f.GetSignedUp() != nil || f.GetError() != nil })
	if !bytes.Equal(f.GetSignedUp().GetAccountId(), id) {
		t.Fatalf("the retry: %v", f)
	}
}
