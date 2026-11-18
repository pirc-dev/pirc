package hosted

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeRechecker struct {
	answer func(Subscription) (Subscription, error)
	asked  int
}

func (f *fakeRechecker) Recheck(_ context.Context, sub Subscription) (Subscription, error) {
	f.asked++
	return f.answer(sub)
}

func TestRecheckSubscriptions(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	srv, err := New(Config{Store: store, Origin: "wss://relay.example", Now: func() time.Time { return now }, Logger: testLogger()})
	if err != nil {
		t.Fatal(err)
	}
	account := []byte("account-1")
	sub := Subscription{Kind: "google-play", Ident: []byte("tok"), Expires: now.Add(30 * time.Minute), Sandbox: true}
	if err := store.AddSubscription(account, sub, now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	f := &fakeRechecker{answer: func(s Subscription) (Subscription, error) {
		s.Expires = s.Expires.Add(30 * time.Minute)
		return s, nil
	}}
	srv.recheckDue(context.Background(), f)
	if f.asked != 0 {
		t.Fatalf("asked about a subscription checked just now and not past its end")
	}

	// Past its end and an hour on: asked, and renewed.
	now = now.Add(time.Hour)
	srv.recheckDue(context.Background(), f)
	due, _ := store.SubscriptionsDue(now.Add(25 * time.Hour).UnixMilli())
	if f.asked != 1 || len(due) != 1 || !due[0].Sub.Expires.Equal(sub.Expires.Add(30*time.Minute)) || due[0].Lapsed {
		t.Fatalf("after a renewal: asked %d, kept %+v", f.asked, due)
	}

	// The store not answering changes nothing.
	now = now.Add(2 * time.Hour)
	f.answer = func(Subscription) (Subscription, error) { return Subscription{}, errors.New("unreachable") }
	srv.recheckDue(context.Background(), f)
	due, _ = store.SubscriptionsDue(now.UnixMilli())
	if len(due) != 1 || due[0].Lapsed {
		t.Fatalf("after no answer: %+v", due)
	}

	// The store saying it has ended: kept as lapsed, with why.
	f.answer = func(s Subscription) (Subscription, error) {
		return s, errors.New("the subscription is not live (SUBSCRIPTION_STATE_EXPIRED)")
	}
	srv.recheckDue(context.Background(), f)
	due, _ = store.SubscriptionsDue(now.Add(2 * time.Hour).UnixMilli())
	if len(due) != 1 || !due[0].Lapsed || due[0].Reason == "" {
		t.Fatalf("after a lapse: %+v", due)
	}
}
