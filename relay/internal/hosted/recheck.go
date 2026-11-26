package hosted

// The subscriptions kept, asked about again (docs/design.md, step 14,
// stage 4): each one a day, and hourly once past its end, so that the
// relay sees a lapse, a refund or a late payment. A lapse of the last one
// locks the account (lock.go).

import (
	"context"
	"time"
)

// Rechecker asks the store again of a subscription kept; Stores is one.
// An error with an empty Subscription is the store not answering, to try
// again later; with one, the store's answer that it is not live.
type Rechecker interface {
	Recheck(ctx context.Context, sub Subscription) (Subscription, error)
}

// RecheckSubscriptions asks again of every subscription due, every
// interval, until ctx ends.
func (s *Server) RecheckSubscriptions(ctx context.Context, r Rechecker, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		s.recheckDue(ctx, r)
		s.deleteExpired()
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Server) recheckDue(ctx context.Context, r Rechecker) {
	due, err := s.store.SubscriptionsDue(s.cfg.Now().UnixMilli())
	if err != nil {
		s.log.Error("cannot read the subscriptions", "err", err)
		return
	}
	for _, k := range due {
		if ctx.Err() != nil {
			return
		}
		// A review code's: no store to ask; ended, its account goes, unless
		// a subscription bought since carries it on.
		if k.Sub.Kind == reviewKind {
			if k.Lapsed || s.cfg.Now().Before(k.Sub.Expires) {
				continue
			}
			if s.carriedOn(k.Account) {
				if err := s.store.LapseSubscription(k.Account, k.Sub, s.cfg.Now().UnixMilli(), "review ended"); err != nil {
					s.log.Error("cannot keep a subscription", "err", err)
				}
				continue
			}
			s.deleteAccountByID(k.Account, "review account ended")
			continue
		}
		sub, err := r.Recheck(ctx, k.Sub)
		now := s.cfg.Now().UnixMilli()
		switch {
		case err != nil && sub.Kind == "":
			s.log.Warn("subscription not checked", "account", shortKey(k.Account), "kind", k.Sub.Kind, "err", err)
			continue
		case err != nil:
			if !k.Lapsed {
				s.log.Info("subscription lapsed", "account", shortKey(k.Account), "kind", sub.Kind, "expires", sub.Expires, "sandbox", sub.Sandbox, "reason", err)
			}
			if err = s.store.LapseSubscription(k.Account, sub, now, err.Error()); err == nil && !k.Lapsed {
				s.lockIfLapsed(k.Account)
			}
		default:
			if k.Lapsed {
				s.log.Info("subscription live again", "account", shortKey(k.Account), "kind", sub.Kind, "expires", sub.Expires)
			} else if !sub.Expires.Equal(k.Sub.Expires) {
				s.log.Info("subscription renewed", "account", shortKey(k.Account), "kind", sub.Kind, "expires", sub.Expires, "grace", sub.Grace)
			}
			err = s.store.AddSubscription(k.Account, sub, now)
		}
		if err != nil {
			s.log.Error("cannot keep a subscription", "err", err)
		}
	}
}

// carriedOn says whether a subscription other than a review one carries
// the account on.
func (s *Server) carriedOn(account []byte) bool {
	kept, err := s.store.Subscriptions(account)
	if err != nil {
		s.log.Error("cannot read an account's subscriptions", "err", err)
		return true
	}
	for _, k := range kept {
		if k.Sub.Kind != reviewKind && !k.Lapsed {
			return true
		}
	}
	return false
}
