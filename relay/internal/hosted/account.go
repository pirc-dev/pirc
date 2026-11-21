// An account's state on the relay (docs/e2e.md, section 7): signing up,
// the devices as the relay sees them, and deleting it.

package hosted

import (
	"context"
	"crypto/sha256"

	"github.com/coder/websocket"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

// signUp makes an account whose one member is this connection's key, as a
// client. The account's ID is the key's SHA-256, so the same key signing
// up again, after an answer that did not arrive, is told the same ID. The
// phone then logs in again with it.
func (s *Server) signUp(ctx context.Context, c *conn, su *pb.SignUp) *frameError {
	if s.cfg.Verifier == nil {
		return denied("this relay takes no sign-ups")
	}
	sum := sha256.Sum256(c.key)
	id := sum[:]
	// Outside the lock: the real checks ask the stores.
	att, err := s.cfg.Verifier.Attest(ctx, su.GetAttestation(), s.attestData(c))
	if err != nil {
		s.log.Info("sign-up refused", "key", shortKey(c.key), "kind", attestationKind(su.GetAttestation()), "err", err)
		return denied("attestation refused: " + err.Error())
	}
	sub, err := s.cfg.Verifier.Subscribed(ctx, id, su.GetAttestation())
	if err != nil {
		s.log.Info("sign-up refused", "key", shortKey(c.key), "subscription", sub.Kind, "sandbox", sub.Sandbox, "err", err)
		return denied("no live subscription: " + err.Error())
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	have, err := s.store.HasAccount(id)
	if err != nil {
		return internal()
	}
	if !have {
		if err := s.store.CreateAccount(id, c.key, s.cfg.Now().UnixMilli()); err != nil {
			s.log.Error("cannot store an account", "err", err)
			return internal()
		}
		if err := s.store.AddAttestation(id, c.key, att.Kind, att.Ident); err != nil {
			s.log.Error("cannot store an attestation", "err", err)
		}
		if err := s.store.AddSubscription(id, sub, s.cfg.Now().UnixMilli()); err != nil {
			s.log.Error("cannot store a subscription", "err", err)
		}
		s.log.Info("account made", "account", shortKey(id), "attestation", att.Kind, "subscription", sub.Kind, "expires", sub.Expires, "trial", sub.Trial, "sandbox", sub.Sandbox)
	}
	c.queue(&pb.Frame{Body: &pb.Frame_SignedUp{SignedUp: &pb.SignedUp{RequestId: su.GetRequestId(), AccountId: id}}})
	return nil
}

func (s *Server) watchDevices(c *conn) {
	c.acct.watchers[c] = struct{}{}
	if f := s.devicesLocked(c.acct); f != nil {
		c.queue(f)
	}
}

// devicesLocked is the Devices frame for a's members. Under s.mu.
func (s *Server) devicesLocked(a *account) *pb.Frame {
	members, err := s.store.Members(a.id)
	if err != nil {
		s.log.Error("cannot read members", "err", err)
		return nil
	}
	rows, err := s.store.Devices(a.id)
	if err != nil {
		s.log.Error("cannot read devices", "err", err)
		return nil
	}
	online := map[string]bool{}
	for o := range a.conns {
		online[string(o.key)] = true
	}
	var out []*pb.DeviceStatus
	for _, m := range members {
		k := m.Key
		r := rows[string(k)]
		st := &pb.DeviceStatus{PublicKey: k, Online: online[string(k)], Push: r.pushHandle != ""}
		if r.lastSeenMs > 0 {
			st.LastSeen = msTime(r.lastSeenMs)
		}
		out = append(out, st)
	}
	return &pb.Frame{Body: &pb.Frame_Devices{Devices: &pb.Devices{Devices: out}}}
}

// pushDevicesLocked sends Devices to a's watchers. Under s.mu.
func (s *Server) pushDevicesLocked(a *account) {
	if len(a.watchers) == 0 {
		return
	}
	if f := s.devicesLocked(a); f != nil {
		for w := range a.watchers {
			w.queue(f)
		}
	}
}

// setPush registers or, with "", unregisters this client's push handle.
// Waking through the push gateway comes with the app's notifications
// (docs/design.md, step 14, stage 5).
func (s *Server) setPush(c *conn, handle string) *frameError {
	if len(handle) > MaxPushHandleBytes {
		return invalid("push handle too long")
	}
	if err := s.store.SetPush(c.acct.id, c.key, handle); err != nil {
		return internal()
	}
	s.pushDevicesLocked(c.acct)
	return nil
}

// deleteAccount deletes everything of the account, answers Done, and
// closes every connection to it.
func (s *Server) deleteAccount(c *conn, requestID string) *frameError {
	a := c.acct
	if err := s.store.DeleteAccount(a.id); err != nil {
		s.log.Error("cannot delete an account", "err", err)
		return internal()
	}
	a.deleted = true
	delete(s.accounts, string(a.id))
	s.done(c, requestID)
	for o := range a.conns {
		if o == c {
			// Once Done has gone out.
			o.closeAfterFlush(websocket.StatusPolicyViolation, "account deleted")
		} else {
			o.close(websocket.StatusPolicyViolation, "account deleted")
		}
	}
	s.log.Info("account deleted", "account", shortKey(a.id))
	return nil
}
