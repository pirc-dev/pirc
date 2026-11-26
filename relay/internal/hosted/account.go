// An account's state on the relay (docs/e2e.md, sections 3 and 7):
// signing up with the list's version 1, taking newer versions, the
// devices as the relay sees them, and deleting it.

package hosted

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/coder/websocket"

	pb1 "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

// signUp makes an account whose list is SignUp.list, version 1, signed
// by this connection's key and listing only it. The account's ID is the
// SHA-256 of that body, so the same phone signing up again with the same
// bytes, after an answer that did not arrive, is told the same ID. The
// phone then logs in again with it.
func (s *Server) signUp(ctx context.Context, c *conn, su *pb.SignUp) *frameError {
	if s.cfg.Verifier == nil {
		return denied("this relay takes no sign-ups")
	}
	r, err := CheckList(ListInput{Bytes: su.GetList(), PhoneKey: c.key, Mode: ListFirst})
	if err != nil {
		return internal()
	}
	if e := listRefusal(r); e != nil {
		s.log.Info("sign-up refused", "key", shortKey(c.key), "list", r.Result, "reason", r.Reason)
		return e
	}
	id := r.Hash
	// A sign-up tried again, its answer lost: the account this key made
	// with this version 1 is answered again, whatever the mode and
	// however used the code is now.
	if have, first, err := s.store.AccountOfPhone(c.key); err != nil {
		return internal()
	} else if have != nil {
		return s.signedUpAgain(c, su, have, first)
	}
	// Who may sign up (invites.go): the mode first; the code once the
	// attestation is checked, so that nothing else may try codes; its
	// use when the account is made.
	code := su.GetInviteCode()
	mode, err := s.signUps()
	if err != nil {
		return internal()
	}
	switch {
	case mode == SignUpsClosed:
		return denied("sign-ups are closed")
	case mode == SignUpsInvite && code == "":
		return &frameError{code: pb1.ErrorCode_ERROR_CODE_TOKEN_INVALID, msg: "sign-ups need an invite code"}
	}
	// Outside the lock: the real checks ask the stores.
	att, err := s.cfg.Verifier.Attest(ctx, su.GetAttestation(), s.attestData(c))
	if err != nil {
		s.log.Info("sign-up refused", "key", shortKey(c.key), "kind", attestationKind(su.GetAttestation()), "err", err)
		return denied("attestation refused: " + err.Error())
	}
	review := false
	if code != "" {
		if !s.countInviteTry(c) {
			return rateLimited("too many invite codes tried from this address; try again in an hour")
		}
		if review, err = s.store.lookInvite(code, s.cfg.Now()); errors.Is(err, errNoInvite) {
			s.log.Info("sign-up refused", "key", shortKey(c.key), "invite", "not valid")
			return &frameError{code: pb1.ErrorCode_ERROR_CODE_TOKEN_INVALID, msg: errNoInvite.Error()}
		} else if err != nil {
			return internal()
		}
	}
	var sub Subscription
	if review {
		// The stores' reviewers: no purchase, an account for ReviewFor.
		sub = Subscription{Kind: reviewKind, Ident: id, Expires: s.cfg.Now().Add(ReviewFor)}
	} else if sub, err = s.cfg.Verifier.Subscribed(ctx, id, su.GetAttestation()); err != nil {
		s.log.Info("sign-up refused", "key", shortKey(c.key), "subscription", sub.Kind, "sandbox", sub.Sandbox, "err", err)
		return denied("no live subscription: " + err.Error())
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// One account per phone key.
	have, first, err := s.store.AccountOfPhone(c.key)
	if err != nil {
		return internal()
	}
	switch {
	case have != nil && !bytes.Equal(first, su.GetList()):
		return &frameError{code: pb1.ErrorCode_ERROR_CODE_CONFLICT, msg: "this key made an account with another version 1"}
	case have == nil:
		now := s.cfg.Now().UnixMilli()
		l := StoredList{PhoneKey: c.key, Counter: r.Counter, Hash: r.Hash, Signed: su.GetList()}
		if err := s.store.CreateAccountInvited(id, l, &att, now, code, &sub); errors.Is(err, errNoInvite) {
			return &frameError{code: pb1.ErrorCode_ERROR_CODE_TOKEN_INVALID, msg: errNoInvite.Error()}
		} else if err != nil {
			s.log.Error("cannot store an account", "err", err)
			return internal()
		}
		s.log.Info("account made", "account", shortKey(id), "attestation", att.Kind, "subscription", sub.Kind, "expires", sub.Expires, "trial", sub.Trial, "sandbox", sub.Sandbox, "invited", code != "")
	}
	c.queue(&pb.Frame{Body: &pb.Frame_SignedUp{SignedUp: &pb.SignedUp{RequestId: su.GetRequestId(), AccountId: id}}})
	return nil
}

// signedUpAgain answers a sign-up from a key that made an account
// already: SignedUp again for the same version 1, CONFLICT for another.
func (s *Server) signedUpAgain(c *conn, su *pb.SignUp, have, first []byte) *frameError {
	if !bytes.Equal(first, su.GetList()) {
		return &frameError{code: pb1.ErrorCode_ERROR_CODE_CONFLICT, msg: "this key made an account with another version 1"}
	}
	c.queue(&pb.Frame{Body: &pb.Frame_SignedUp{SignedUp: &pb.SignedUp{RequestId: su.GetRequestId(), AccountId: have}}})
	return nil
}

// listRefusal is the answer to a version the check did not accept; nil
// for an accepted one. An old one is the caller's to answer.
func listRefusal(r ListResult) *frameError {
	switch r.Result {
	case ListAccepted:
		return nil
	case ListUnsupported:
		return &frameError{code: pb1.ErrorCode_ERROR_CODE_VERSION_UNSUPPORTED, msg: "list not supported: " + r.Reason}
	case ListRefused:
		return invalid("list refused: " + r.Reason)
	}
	return &frameError{code: pb1.ErrorCode_ERROR_CODE_CONFLICT, msg: "not newer than the relay's list"}
}

// accountList is an account's newest list, as the relay holds it in
// memory.
type accountList struct {
	phoneKey []byte
	counter  uint64
	hash     []byte
	signed   []byte
	body     *pb.ListBody
}

// readList reads the account's newest list from the store and checks it
// again, as a device checks a file it reads: anything but accepted is an
// error.
func (s *Server) readList(id []byte) (*accountList, error) {
	l, ok, err := s.store.List(id)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("account %x has no list", id[:6])
	}
	in := ListInput{Bytes: l.Signed, PhoneKey: l.PhoneKey, Mode: ListLater, AccountID: id}
	if l.Counter == 1 {
		in.Mode = ListFirst
	}
	r, err := CheckList(in)
	if err != nil {
		return nil, err
	}
	if r.Result != ListAccepted || r.Counter != l.Counter || !bytes.Equal(r.Hash, l.Hash) {
		return nil, fmt.Errorf("account %x: stored list %s %s", id[:6], r.Result, r.Reason)
	}
	return &accountList{phoneKey: l.PhoneKey, counter: r.Counter, hash: r.Hash, signed: l.Signed, body: r.List}, nil
}

// deviceFor is the device of the list a key logs in as, and its role: a
// computer or client by its signing key, a phone by its read-only key.
// Nil when the list has no such key.
func (l *accountList) deviceFor(key []byte) (*pb.Device, pb.DeviceRole) {
	for _, d := range l.body.GetDevices() {
		if bytes.Equal(d.GetSigningKey(), key) {
			if d.GetRole() == RoleComputer {
				return d, pb.DeviceRole_DEVICE_ROLE_HOST
			}
			return d, pb.DeviceRole_DEVICE_ROLE_CLIENT
		}
		if bytes.Equal(d.GetReadOnlyKey(), key) {
			return d, pb.DeviceRole_DEVICE_ROLE_READ_ONLY
		}
	}
	return nil, pb.DeviceRole_DEVICE_ROLE_UNSPECIFIED
}

// sameDevice says whether two entries are one device: the same role and
// the same five keys.
func sameDevice(a, b *pb.Device) bool {
	return a.GetRole() == b.GetRole() && bytes.Equal(a.GetSigningKey(), b.GetSigningKey()) &&
		bytes.Equal(a.GetChannelKey(), b.GetChannelKey()) && bytes.Equal(a.GetBoxKey(), b.GetBoxKey()) &&
		bytes.Equal(a.GetReadOnlyKey(), b.GetReadOnlyKey()) && bytes.Equal(a.GetNotificationKey(), b.GetNotificationKey())
}

// listed says whether the list has the device, as sameDevice compares.
func (l *accountList) listed(d *pb.Device) bool {
	for _, n := range l.body.GetDevices() {
		if sameDevice(n, d) {
			return true
		}
	}
	return false
}

func listFrameOf(l *accountList) *pb.Frame {
	return &pb.Frame{Body: &pb.Frame_List{List: &pb.List{List: l.signed}}}
}

// publishList takes a newer version of the account's list, signed by its
// phone, from any client or host of it. Only versions the check accepts
// count toward the account's hourly cap, so that no device can spend it
// on frames that are not the phone's. Under s.mu.
func (s *Server) publishList(c *conn, p *pb.PublishList) *frameError {
	a := c.acct
	if a.deleted {
		return denied("account deleted")
	}
	now := s.cfg.Now()
	if now.Sub(s.lastPublishesTrim) >= time.Hour {
		s.lastPublishesTrim = now
		for k, n := range s.listPublishes {
			if now.Sub(n.since) >= time.Hour {
				delete(s.listPublishes, k)
			}
		}
	}
	cur := a.list
	r, err := CheckList(ListInput{Bytes: p.GetList(), PhoneKey: cur.phoneKey, Mode: ListLater, AccountID: a.id, Highest: cur.counter})
	if err != nil {
		return internal()
	}
	if r.Result == ListOld {
		if r.Counter == cur.counter && bytes.Equal(r.Hash, cur.hash) {
			s.done(c, p.GetRequestId())
			return nil
		}
		if r.Counter == cur.counter {
			s.log.Error("the account's phone signed two versions with one counter", "account", shortKey(a.id), "counter", r.Counter, "key", shortKey(c.key))
		}
		c.queue(listFrameOf(cur))
		return &frameError{code: pb1.ErrorCode_ERROR_CODE_CONFLICT, msg: "the relay has a newer list, or another with this counter"}
	}
	if e := listRefusal(r); e != nil {
		s.log.Info("list refused", "account", shortKey(a.id), "key", shortKey(c.key), "list", r.Result, "reason", r.Reason)
		return e
	}
	// Built on the version held, or on one the relay never held: a relay
	// restored from an older copy lost versions, which a device brings
	// back by giving the newest it has. One built on an older version the
	// relay held would undo what the versions after it changed; the
	// publisher gets the version held, first, to build on.
	if prev := r.List.GetPreviousHash(); !bytes.Equal(prev, cur.hash) {
		held, err := s.store.Held(a.id, prev)
		if err != nil {
			return internal()
		}
		if held {
			s.log.Info("list built on an older one", "account", shortKey(a.id), "key", shortKey(c.key), "counter", r.Counter, "held", cur.counter)
			c.queue(listFrameOf(cur))
			return &frameError{code: pb1.ErrorCode_ERROR_CODE_CONFLICT, msg: "built on an older list than the relay's"}
		}
		s.log.Info("list built on one the relay never held", "account", shortKey(a.id), "key", shortKey(c.key), "counter", r.Counter, "held", cur.counter)
	}
	if !count(s.listPublishes, string(a.id), s.cfg.MaxListPublishesPerAccount, now) {
		return rateLimited("too many list versions; try again in an hour")
	}
	next := &accountList{phoneKey: cur.phoneKey, counter: r.Counter, hash: r.Hash, signed: p.GetList(), body: r.List}
	if e := s.takeListLocked(a, next); e != nil {
		return e
	}
	s.done(c, p.GetRequestId())
	s.tellListLocked(a, c)
	return nil
}

// takeListLocked replaces a's list with next: first in the store, then
// in memory, ending the sessions, channels and joins of the connections
// of every device it removes, which are marked removed, and deleting the
// copies sealed to removed recipients. Under s.mu.
//
// The account's phone is on every version (CheckList pins its signing
// key), so a change to its other keys removes only what changed: its
// old read-only key, with that key's connections, and the names sealed
// to its old box key. Its signing-key connections, device row and
// attestation stay.
func (s *Server) takeListLocked(a *account, next *accountList) *frameError {
	phone, _ := next.deviceFor(next.phoneKey)
	var gone []RemovedDevice
	for _, d := range a.list.body.GetDevices() {
		switch {
		case next.listed(d):
		case bytes.Equal(d.GetSigningKey(), next.phoneKey):
			var r RemovedDevice
			if !bytes.Equal(d.GetReadOnlyKey(), phone.GetReadOnlyKey()) {
				r.ReadOnlyKey = d.GetReadOnlyKey()
			}
			if !bytes.Equal(d.GetBoxKey(), phone.GetBoxKey()) {
				r.BoxKey = d.GetBoxKey()
			}
			gone = append(gone, r)
		default:
			gone = append(gone, RemovedDevice{SigningKey: d.GetSigningKey(), BoxKey: d.GetBoxKey(), ReadOnlyKey: d.GetReadOnlyKey()})
		}
	}
	stored := StoredList{PhoneKey: next.phoneKey, Counter: next.counter, Hash: next.hash, Signed: next.signed, PreviousHash: next.body.GetPreviousHash()}
	if err := s.store.TakeList(a.id, stored, gone, s.cfg.Now().UnixMilli()); err != nil {
		s.log.Error("cannot store a list", "account", shortKey(a.id), "err", err)
		return internal()
	}
	a.list = next
	s.storeAttestationsLocked(a)
	for o := range a.conns {
		if o.device == nil || o.removed || next.listed(o.device) {
			continue
		}
		if bytes.Equal(o.device.GetSigningKey(), next.phoneKey) && (o.role != pb.DeviceRole_DEVICE_ROLE_READ_ONLY || bytes.Equal(o.key, phone.GetReadOnlyKey())) {
			o.device = phone
			continue
		}
		o.removed = true
		delete(a.subscribers, o)
		delete(a.watchers, o)
		for id, se := range a.sessions {
			if se.owner == o {
				s.endLocked(a, id, se, false)
			}
		}
		s.closeChannelsLocked(o, pb1.ErrorCode_ERROR_CODE_PERMISSION_DENIED)
		s.joins.dropLocked(s, o)
	}
	dropUnlistedLocked(a)
	s.log.Info("list taken", "account", shortKey(a.id), "counter", next.counter, "removed", len(gone))
	return nil
}

// tellListLocked sends the newest list to every connection of a but
// from, Devices to its watchers, and closes the removed connections once
// List has been written to them. Under s.mu.
func (s *Server) tellListLocked(a *account, from *conn) {
	f, e := s.encode(listFrameOf(a.list))
	for o := range a.conns {
		if o != from && e == nil {
			o.queueBytes(f)
		}
	}
	s.pushDevicesLocked(a)
	for o := range a.conns {
		if o.removed {
			o.dropQueue.Store(true)
			o.closeAfterFlush(websocket.StatusPolicyViolation, "removed")
		}
	}
}

func (s *Server) watchDevices(c *conn) {
	c.acct.watchers[c] = struct{}{}
	s.sendDevicesLocked(c.acct, map[*conn]struct{}{c: {}})
}

// devicesLocked is the status of each device of a's newest list, and the
// names copies by box key. Under s.mu.
func (s *Server) devicesLocked(a *account) ([]*pb.DeviceStatus, map[string][]byte) {
	rows, err := s.store.Devices(a.id)
	if err != nil {
		s.log.Error("cannot read devices", "err", err)
		return nil, nil
	}
	names, err := s.store.Names(a.id)
	if err != nil {
		s.log.Error("cannot read names", "err", err)
		return nil, nil
	}
	online := map[string]bool{}
	for o := range a.conns {
		if !o.removed && o.role != pb.DeviceRole_DEVICE_ROLE_READ_ONLY {
			online[string(o.key)] = true
		}
	}
	var out []*pb.DeviceStatus
	for _, d := range a.list.body.GetDevices() {
		k := d.GetSigningKey()
		r := rows[string(k)]
		st := &pb.DeviceStatus{PublicKey: k, Online: online[string(k)], Push: r.pushHandle != ""}
		if r.lastSeenMs > 0 {
			st.LastSeen = msTime(r.lastSeenMs)
		}
		out = append(out, st)
	}
	return out, names
}

// sendDevicesLocked sends Devices to each of these watchers, with the
// names sealed to its own box key. Under s.mu.
func (s *Server) sendDevicesLocked(a *account, to map[*conn]struct{}) {
	if len(to) == 0 {
		return
	}
	ds, names := s.devicesLocked(a)
	if names == nil {
		return
	}
	for w := range to {
		w.queue(&pb.Frame{Body: &pb.Frame_Devices{Devices: &pb.Devices{Devices: ds, Names: names[string(w.device.GetBoxKey())]}}})
	}
}

// pushDevicesLocked sends Devices to a's watchers. Under s.mu.
func (s *Server) pushDevicesLocked(a *account) { s.sendDevicesLocked(a, a.watchers) }

// setPush registers or, with "", unregisters this client's push handle.
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
// closes every connection to it. Only the account's phone, by its
// signing key, deletes it. Under s.mu.
func (s *Server) deleteAccount(c *conn, requestID string) *frameError {
	a := c.acct
	if a.deleted {
		return denied("account deleted")
	}
	if c.role != pb.DeviceRole_DEVICE_ROLE_CLIENT || !bytes.Equal(c.key, a.list.phoneKey) {
		return denied("only the account's phone deletes the account")
	}
	if err := s.store.DeleteAccount(a.id); err != nil {
		s.log.Error("cannot delete an account", "err", err)
		return internal()
	}
	s.forgetDeletedLocked(a)
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

// forgetDeletedLocked drops a deleted account from memory: its sessions,
// their copies, its kept notices, channels and joins end, and it is no
// longer loaded. Under s.mu.
func (s *Server) forgetDeletedLocked(a *account) {
	a.deleted = true
	delete(s.accounts, string(a.id))
	for id, se := range a.sessions {
		s.endLocked(a, id, se, false)
	}
	forgetEndedLocked(a)
	for o := range a.conns {
		s.closeChannelsLocked(o, pb1.ErrorCode_ERROR_CODE_SESSION_GONE)
		s.joins.dropLocked(s, o)
	}
}
