// An account's state on the relay (docs/e2e.md, sections 3 and 6): signing
// up, the list's versions and withdrawals, pre-keys, label records and
// label-key wraps, the devices as the relay sees them, and deleting it.

package hosted

import (
	"bytes"
	"context"
	"errors"

	"github.com/coder/websocket"

	"pirc.dev/relay/internal/e2e"
	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

func refused(err error) *frameError {
	var r *e2e.Refused
	if errors.As(err, &r) {
		return invalid(r.Reason)
	}
	return invalid(err.Error())
}

// signUp makes an account from version 1, signed by this connection's
// key. The phone then logs in again with the account's ID.
func (s *Server) signUp(ctx context.Context, c *conn, su *pb.SignUp) *frameError {
	v, err := e2e.CheckFirst(su.GetVersion())
	if err != nil {
		return refused(err)
	}
	if !bytes.Equal(v.Body.GetDevices()[0].GetPublicKey(), c.key) {
		return invalid("version 1's device is not this connection's key")
	}
	if s.cfg.Verifier == nil {
		return denied("this relay takes no sign-ups")
	}
	// Outside the lock: the real checks ask the stores.
	att, err := s.cfg.Verifier.Attest(ctx, su.GetAttestation(), c.key)
	if err != nil {
		return denied("attestation refused: " + err.Error())
	}
	if err := s.cfg.Verifier.Subscribed(ctx, v.Hash, su.GetAttestation()); err != nil {
		return denied("no live subscription: " + err.Error())
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	have, err := s.store.Latest(v.Hash)
	if err != nil {
		return internal()
	}
	// The same version 1 again, after an answer that did not arrive. Its
	// hash is the account ID, so it is the same version.
	if have == nil {
		if err := s.store.CreateAccount(v.Hash, su.GetVersion(), s.cfg.Now().UnixMilli()); err != nil {
			s.log.Error("cannot store an account", "err", err)
			return internal()
		}
		if err := s.store.AddAttestation(v.Hash, c.key, att.Kind, att.Ident); err != nil {
			s.log.Error("cannot store an attestation", "err", err)
		}
		s.log.Info("account made", "account", shortKey(v.Hash))
	}
	c.queue(&pb.Frame{Body: &pb.Frame_SignedUp{SignedUp: &pb.SignedUp{RequestId: su.GetRequestId(), AccountId: v.Hash}}})
	return nil
}

// toAccountLocked sends an encoded frame to every connection of a.
func toAccountLocked(a *account, b []byte) {
	for o := range a.conns {
		o.queueBytes(b)
	}
}

func (s *Server) publishVersion(c *conn, obj *pb.SignedObject) *frameError {
	a := c.acct
	body, err := e2e.OpenList(a.id, obj)
	if err != nil {
		return refused(err)
	}
	n := body.GetNumber()
	if n <= a.latest.Body.GetNumber() {
		have, err := s.store.VersionHash(a.id, n)
		if err != nil {
			return internal()
		}
		if bytes.Equal(have, e2e.Hash(obj)) {
			// Sent again, after an answer that did not arrive.
			return nil
		}
		vs, err := s.store.Versions(a.id, n)
		if err != nil {
			return internal()
		}
		b, fe := s.encode(&pb.Frame{Body: &pb.Frame_Versions_{Versions_: &pb.Versions{Versions: vs}}})
		if fe != nil {
			return fe
		}
		c.queueBytes(b)
		return conflict("another version with this number was taken first")
	}
	v, err := e2e.CheckNext(a.id, a.latest, obj)
	if err != nil {
		return refused(err)
	}
	b, fe := s.encode(&pb.Frame{Body: &pb.Frame_Versions_{Versions_: &pb.Versions{Versions: []*pb.SignedObject{obj}}}})
	if fe != nil {
		return fe
	}
	var removed [][]byte
	for _, d := range a.latest.Body.GetDevices() {
		if e2e.Device(v.Body, d.GetPublicKey()) == nil {
			removed = append(removed, d.GetPublicKey())
		}
	}
	if err := s.store.AddVersion(a.id, n, v.Hash, obj, removed); err != nil {
		s.log.Error("cannot store a version", "err", err)
		return internal()
	}
	a.latest = v
	toAccountLocked(a, b)
	// A device acts on its removal only from a version it checked; the
	// close says only that the relay refuses its key now.
	for o := range a.conns {
		if e2e.Device(v.Body, o.key) == nil {
			o.close(websocket.StatusPolicyViolation, "key revoked")
		}
	}
	s.log.Info("version taken", "account", shortKey(a.id), "number", n, "devices", len(v.Body.GetDevices()), "removed", len(removed))
	s.pushDevicesLocked(a)
	return nil
}

// publishWithdrawal takes a withdrawal of a version the relay never took:
// one that lost to the relay's version with its number. The relay cannot
// check it against the version withdrawn, which it does not have; the
// devices that took that version do.
func (s *Server) publishWithdrawal(c *conn, obj *pb.SignedObject) *frameError {
	a := c.acct
	body, err := e2e.OpenWithdrawal(a.id, obj)
	if err != nil {
		return refused(err)
	}
	w, win := body.GetWithdrawn(), body.GetWinner()
	n := w.GetNumber()
	if w == nil || win == nil || n < 2 || win.GetNumber() != n || len(w.GetHash()) != 32 || bytes.Equal(w.GetHash(), win.GetHash()) {
		return invalid("the winner is not another version with its number")
	}
	have, err := s.store.VersionHash(a.id, n)
	if err != nil {
		return internal()
	}
	if !bytes.Equal(have, win.GetHash()) {
		return invalid("the winner is not the relay's version with that number")
	}
	before, err := s.store.Versions(a.id, n-1)
	if err != nil || len(before) == 0 {
		return internal()
	}
	prev, err := openStored(a.id, before[0])
	if err != nil {
		return internal()
	}
	// The version withdrawn chained from the one before, so its signer was
	// a client there.
	if !e2e.IsClient(prev.Body, body.GetSigner()) {
		return invalid("not signed by a client in the version before")
	}
	added, err := s.store.AddWithdrawal(a.id, w.GetHash(), obj)
	if err != nil {
		return internal()
	}
	if added {
		b, fe := s.encode(&pb.Frame{Body: &pb.Frame_Versions_{Versions_: &pb.Versions{Withdrawals: []*pb.SignedObject{obj}}}})
		if fe != nil {
			return fe
		}
		toAccountLocked(a, b)
	}
	return nil
}

func (s *Server) getVersions(c *conn, g *pb.GetVersions) *frameError {
	vs, err := s.store.Versions(c.acct.id, max(g.GetFrom(), 1))
	if err != nil {
		return internal()
	}
	ws, err := s.store.Withdrawals(c.acct.id)
	if err != nil {
		return internal()
	}
	b, fe := s.encode(&pb.Frame{Body: &pb.Frame_Versions_{Versions_: &pb.Versions{RequestId: g.GetRequestId(), Versions: vs, Withdrawals: ws}}})
	if fe != nil {
		return fe
	}
	c.queueBytes(b)
	return nil
}

func (s *Server) nowMs() int64 { return s.cfg.Now().UnixMilli() }

func (s *Server) publishPreKey(c *conn, obj *pb.SignedObject) *frameError {
	a := c.acct
	body, err := e2e.CheckPreKey(a.id, a.latest.Body, obj, s.nowMs())
	if err != nil {
		return refused(err)
	}
	if !bytes.Equal(body.GetSigner(), c.key) {
		return denied("not this device's own pre-key")
	}
	if err := s.store.SetPreKey(a.id, c.key, obj); err != nil {
		return internal()
	}
	b, fe := s.encode(&pb.Frame{Body: &pb.Frame_PreKeys{PreKeys: &pb.PreKeys{PreKeys: []*pb.SignedObject{obj}}}})
	if fe != nil {
		return fe
	}
	toAccountLocked(a, b)
	return nil
}

// currentPreKeysLocked is every pre-key of a device on the latest version
// that has not expired. Under s.mu.
func (s *Server) currentPreKeysLocked(a *account) []*pb.SignedObject {
	all, err := s.store.PreKeys(a.id)
	if err != nil {
		s.log.Error("cannot read pre-keys", "err", err)
		return nil
	}
	var out []*pb.SignedObject
	for _, o := range all {
		if _, err := e2e.CheckPreKey(a.id, a.latest.Body, o, s.nowMs()); err == nil {
			out = append(out, o)
		}
	}
	return out
}

// storedRef checks that r names a version the relay has.
func (s *Server) storedRef(a *account, r *pb.VersionRef) *frameError {
	if r == nil || r.GetNumber() == 0 || r.GetNumber() > a.latest.Body.GetNumber() {
		return invalid("names a version the relay does not have")
	}
	h, err := s.store.VersionHash(a.id, r.GetNumber())
	if err != nil {
		return internal()
	}
	if !bytes.Equal(h, r.GetHash()) {
		return invalid("names a version the relay does not have")
	}
	return nil
}

func (s *Server) publishLabels(c *conn, obj *pb.SignedObject) *frameError {
	a := c.acct
	body, err := e2e.OpenLabels(a.id, obj)
	if err != nil {
		return refused(err)
	}
	if !e2e.IsClient(a.latest.Body, body.GetSigner()) {
		return invalid("not signed by a client on the list")
	}
	key := body.GetLabelKey().GetVersion()
	if e := s.storedRef(a, key); e != nil {
		return e
	}
	if e := s.storedRef(a, body.GetListVersion()); e != nil {
		return e
	}
	if body.GetCounter() == 0 {
		return invalid("a label record's counter starts at 1")
	}
	if n := len(body.GetSealed()); n < 12+16 || n > maxLabelsBytes {
		return invalid("sealed labels of the wrong size")
	}
	err = s.store.AddLabels(a.id, key.GetNumber(), key.GetHash(), body.GetCounter(), e2e.Hash(obj), obj)
	if errors.Is(err, errStale) {
		s.sendLabelStateLocked(c)
		return conflict("the relay has a newer label key, or a higher counter under this one")
	}
	if err != nil {
		return internal()
	}
	for o := range a.conns {
		if o.role != pb.DeviceRole_DEVICE_ROLE_HOST {
			s.sendLabelStateLocked(o)
		}
	}
	return nil
}

func (s *Server) publishWraps(c *conn, objs []*pb.SignedObject) *frameError {
	a := c.acct
	if len(objs) == 0 || len(objs) > 2*len(a.latest.Body.GetDevices()) {
		return invalid("wrong number of wraps")
	}
	var wraps []storedWrap
	to := map[string]bool{}
	for _, obj := range objs {
		body, err := e2e.OpenLabelKey(a.id, obj)
		if err != nil {
			return refused(err)
		}
		if !e2e.IsClient(a.latest.Body, body.GetSigner()) {
			return invalid("not signed by a client on the list")
		}
		key := body.GetLabelKey().GetVersion()
		if e := s.storedRef(a, key); e != nil {
			return e
		}
		r := e2e.Device(a.latest.Body, body.GetRecipient())
		if r == nil || r.GetRole() == pb.DeviceRole_DEVICE_ROLE_HOST {
			return invalid("the recipient is not a client or read-only key on the list")
		}
		pk, err := s.store.PreKey(a.id, body.GetRecipient())
		if err != nil {
			return internal()
		}
		pkBody, err := e2e.OpenPreKey(a.id, pk)
		if pk == nil || err != nil || !bytes.Equal(pkBody.GetPreKey(), body.GetPreKey()) {
			return invalid("not wrapped for the recipient's current pre-key")
		}
		if n := len(body.GetWrap()); n == 0 || n > maxWrapBytes {
			return invalid("a wrap of the wrong size")
		}
		wraps = append(wraps, storedWrap{keyNumber: key.GetNumber(), keyHash: key.GetHash(), recipient: body.GetRecipient(), obj: obj})
		to[string(body.GetRecipient())] = true
	}
	err := s.store.AddWraps(a.id, wraps)
	if errors.Is(err, errStale) {
		return conflict("the relay has a newer label key")
	}
	if err != nil {
		return internal()
	}
	for o := range a.conns {
		if to[string(o.key)] {
			s.sendLabelStateLocked(o)
		}
	}
	return nil
}

// sendLabelStateLocked sends c the current label records and its wraps.
// Under s.mu.
func (s *Server) sendLabelStateLocked(c *conn) {
	labels, err := s.store.Labels(c.acct.id)
	if err != nil {
		s.log.Error("cannot read labels", "err", err)
		return
	}
	wraps, err := s.store.Wraps(c.acct.id, c.key)
	if err != nil {
		s.log.Error("cannot read wraps", "err", err)
		return
	}
	c.queue(&pb.Frame{Body: &pb.Frame_LabelState{LabelState: &pb.LabelState{Labels: labels, Wraps: wraps}}})
}

func (s *Server) watchDevices(c *conn) {
	c.acct.watchers[c] = struct{}{}
	if f := s.devicesLocked(c.acct); f != nil {
		c.queue(f)
	}
}

// devicesLocked is the Devices frame for a's latest version. Under s.mu.
func (s *Server) devicesLocked(a *account) *pb.Frame {
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
	for _, d := range a.latest.Body.GetDevices() {
		k := d.GetPublicKey()
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
