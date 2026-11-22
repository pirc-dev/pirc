package hosted

// A lapse (docs/design.md, step 14, stage 4): an
// account whose every subscription has lapsed, past the stores' own grace
// and billing retry, is locked. Its hosts and read-only keys are refused
// at login; a client logs in and may only renew, with a subscription the
// store proves, publish a newer list, or delete the account (the
// account's phone only). A renewal unlocks it at once. An
// account locked for LockedFor (60 days) is deleted, with its attestation
// and store IDs.

import (
	"context"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

const errLocked = "the account is locked: its subscription has ended"

// admitLockedAccountLocked logs a client in to a locked account: Welcome,
// saying so, and nothing else. Under s.mu.
func (s *Server) admitLockedAccountLocked(c *conn, a *account, w *pb.Welcome) {
	c.acct, c.role, c.locked = a, pb.DeviceRole_DEVICE_ROLE_CLIENT, true
	s.conns[c] = struct{}{}
	a.conns[c] = struct{}{}
	c.queue(&pb.Frame{Body: &pb.Frame_Welcome{Welcome: w}})
	s.log.Info("logged in to a locked account", "account", shortKey(a.id), "key", shortKey(c.key))
}

// subscriptionsFor are the account's subscriptions for Welcome: to a
// client only (docs/design.md, step 14, stage 5, decision D1).
func (s *Server) subscriptionsFor(a *account, role pb.DeviceRole) ([]*pb.AccountSubscription, error) {
	if role != pb.DeviceRole_DEVICE_ROLE_CLIENT {
		return nil, nil
	}
	kept, err := s.store.Subscriptions(a.id)
	if err != nil {
		s.log.Error("cannot read an account's subscriptions", "account", shortKey(a.id), "err", err)
		return nil, err
	}
	out := make([]*pb.AccountSubscription, 0, len(kept))
	for _, k := range kept {
		o := &pb.AccountSubscription{Store: subscriptionStore(k.Sub.Kind), Renews: k.Sub.Renews && !k.Lapsed, Trial: k.Sub.Trial, Lapsed: k.Lapsed}
		if !k.Sub.Expires.IsZero() {
			o.Ends = timestamppb.New(k.Sub.Expires)
		}
		out = append(out, o)
	}
	return out, nil
}

// subscriptionStore names the store of a subscription's kind.
func subscriptionStore(kind string) pb.SubscriptionStore {
	switch kind {
	case "app-store":
		return pb.SubscriptionStore_SUBSCRIPTION_STORE_APP_STORE
	case "google-play":
		return pb.SubscriptionStore_SUBSCRIPTION_STORE_GOOGLE_PLAY
	case "test":
		return pb.SubscriptionStore_SUBSCRIPTION_STORE_TEST
	}
	return pb.SubscriptionStore_SUBSCRIPTION_STORE_UNSPECIFIED
}

// renew asks the store of the subscription r proves and keeps it; on a
// locked account, it unlocks it and closes the account's connections, so
// that each logs in again unlocked.
func (s *Server) renew(ctx context.Context, c *conn, r *pb.RenewSubscription) *frameError {
	if s.cfg.Verifier == nil {
		return denied("this relay checks no subscriptions")
	}
	// The store is named by the proof; Subscribed reads the kind only.
	att := &pb.Attestation{}
	switch p := r.GetProof().(type) {
	case *pb.RenewSubscription_AppStoreTransaction:
		att.Kind, att.Subscription = &pb.Attestation_AppAttest{AppAttest: &pb.AppAttest{}}, p.AppStoreTransaction
	case *pb.RenewSubscription_GooglePlayToken:
		att.Kind, att.Subscription = &pb.Attestation_PlayIntegrity{PlayIntegrity: &pb.PlayIntegrity{}}, p.GooglePlayToken
	default:
		return invalid("a subscription's proof is needed")
	}
	s.mu.Lock()
	a := c.acct
	s.mu.Unlock()
	sub, err := s.cfg.Verifier.Subscribed(ctx, a.id, att)
	if err != nil {
		s.log.Info("renewal refused", "account", shortKey(a.id), "subscription", sub.Kind, "err", err)
		return denied("no live subscription: " + err.Error())
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if a.deleted {
		return denied("account deleted")
	}
	if err := s.store.AddSubscription(a.id, sub, s.cfg.Now().UnixMilli()); err != nil {
		s.log.Error("cannot store a subscription", "err", err)
		return internal()
	}
	s.done(c, r.GetRequestId())
	if !c.locked {
		s.log.Info("subscription added", "account", shortKey(a.id), "subscription", sub.Kind, "expires", sub.Expires, "sandbox", sub.Sandbox)
		return nil
	}
	s.log.Info("account unlocked", "account", shortKey(a.id), "subscription", sub.Kind, "expires", sub.Expires, "sandbox", sub.Sandbox)
	for o := range a.conns {
		if o.locked {
			o.closeAfterFlush(websocket.StatusNormalClosure, "renewed")
		}
	}
	return nil
}

// lockIfLapsed locks the account once its last subscription has lapsed:
// its connections close, and log in again to a locked account.
func (s *Server) lockIfLapsed(account []byte) {
	locked, _, err := s.store.Locked(account)
	if err != nil || !locked {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	a := s.accounts[string(account)]
	if a == nil {
		s.log.Info("account locked", "account", shortKey(account))
		return
	}
	n := 0
	for o := range a.conns {
		if !o.locked {
			o.close(websocket.StatusPolicyViolation, "subscription ended")
			n++
		}
	}
	s.log.Info("account locked", "account", shortKey(account), "closed", n)
}

// deleteExpired deletes the accounts locked for longer than LockedFor.
func (s *Server) deleteExpired() {
	ids, err := s.store.LockedBefore(s.cfg.Now().Add(-s.cfg.LockedFor).UnixMilli())
	if err != nil {
		s.log.Error("cannot read the locked accounts", "err", err)
		return
	}
	for _, id := range ids {
		s.mu.Lock()
		if err := s.store.DeleteAccount(id); err != nil {
			s.mu.Unlock()
			s.log.Error("cannot delete a locked account", "err", err)
			continue
		}
		if a := s.accounts[string(id)]; a != nil {
			s.forgetDeletedLocked(a)
			for o := range a.conns {
				o.close(websocket.StatusPolicyViolation, "account deleted")
			}
		}
		s.mu.Unlock()
		s.log.Info("locked account deleted", "account", shortKey(id), "after", s.cfg.LockedFor)
	}
}

// requestIDOf is the request_id of the frame's body, if it has one.
func requestIDOf(f *pb.Frame) string {
	m := f.ProtoReflect()
	od := m.Descriptor().Oneofs().ByName("body")
	fd := m.WhichOneof(od)
	if fd == nil || fd.Kind() != protoreflect.MessageKind {
		return ""
	}
	body := m.Get(fd).Message()
	if id := body.Descriptor().Fields().ByName("request_id"); id != nil && id.Kind() == protoreflect.StringKind {
		return body.Get(id).String()
	}
	return ""
}
