// An account's live sessions and the copies sealed for them (docs/e2e.md,
// section 5), kept in memory with the session: each client is given only
// the copy sealed to its box key, and a phone's read-only key only the
// notices sealed to its notification key. The relay reads none of them.

package hosted

import (
	"bytes"
	"crypto/ed25519"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb1 "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

// Bounds on a sealed copy: at least a nonce and a MAC; an announcement at
// every field's cap with a 128-byte session ID is 6,005 bytes.
const (
	MinSealedBytes = 40
	MaxSealedBytes = 8192
	// Signed names sealed to a client (e2e/names.ts, NAMES_MAX_BYTES).
	MaxNamesBytes = 32768
	// Copies of one kind in one frame: one per client, at most 10.
	MaxCopies = 10
)

// sessionID is a SessionRef as a map key.
type sessionID struct{ host, session, instance string }

func idOf(r *pb1.SessionRef) sessionID {
	return sessionID{string(r.GetHostKey()), r.GetSessionId(), r.GetInstanceId()}
}

// copies are sealed copies by recipient key.
type copies map[string][]byte

func (cs copies) size() int {
	n := 0
	for _, b := range cs {
		n += len(b)
	}
	return n
}

type session struct {
	ref         *pb1.SessionRef
	owner       *conn
	announcedAt time.Time
	// By a client's box key, and by a phone's notification key.
	announcements, notices copies
}

// endedNotices are a session's notices kept after it ended, until
// expires.
type endedNotices struct {
	ref      *pb1.SessionRef
	storedAt time.Time
	notices  copies
	timer    *time.Timer
}

func msTime(ms int64) *timestamppb.Timestamp { return timestamppb.New(time.UnixMilli(ms)) }

func validRef(r *pb1.SessionRef) bool {
	return r != nil && len(r.GetHostKey()) == ed25519.PublicKeySize &&
		r.GetSessionId() != "" && len(r.GetSessionId()) <= MaxIDBytes &&
		r.GetInstanceId() != "" && len(r.GetInstanceId()) <= MaxIDBytes
}

var errBadRef = invalid("session reference incomplete or too long")

// checkCopies checks one kind's copies in a frame: at most MaxCopies, one
// per recipient, each min to max bytes. It keeps those the recipient
// function takes, by recipient key.
func checkCopies(in []*pb.SealedCopy, min, max int, recipient func([]byte) bool) (copies, *frameError) {
	if len(in) > MaxCopies {
		return nil, invalid("more than 10 sealed copies of a kind")
	}
	seen := map[string]bool{}
	out := copies{}
	for _, c := range in {
		k := string(c.GetRecipientKey())
		if seen[k] {
			return nil, invalid("a recipient twice")
		}
		seen[k] = true
		switch n := len(c.GetSealed()); {
		case n > max:
			return nil, &frameError{code: pb1.ErrorCode_ERROR_CODE_TOO_LARGE, msg: "sealed copy too large"}
		case n < min:
			return nil, invalid("sealed copy too short")
		}
		if recipient(c.GetRecipientKey()) {
			out[k] = c.GetSealed()
		}
	}
	return out, nil
}

// boxKeyListed says whether the key is the box key of a client on the
// list.
func (l *accountList) boxKeyListed(k []byte) bool {
	for _, d := range l.body.GetDevices() {
		if d.GetRole() == RoleClient && bytes.Equal(d.GetBoxKey(), k) {
			return true
		}
	}
	return false
}

// notificationKeyListed says whether the key is the notification key of a
// phone on the list.
func (l *accountList) notificationKeyListed(k []byte) bool {
	for _, d := range l.body.GetDevices() {
		if d.GetRole() == RoleClient && len(d.GetNotificationKey()) > 0 && bytes.Equal(d.GetNotificationKey(), k) {
			return true
		}
	}
	return false
}

// computerListed says whether the key is the signing key of a computer on
// the list.
func (l *accountList) computerListed(k []byte) bool {
	for _, d := range l.body.GetDevices() {
		if d.GetRole() == RoleComputer && bytes.Equal(d.GetSigningKey(), k) {
			return true
		}
	}
	return false
}

// takeAnnounce refills c's bucket and takes one announcement from it;
// false when it is empty.
func (s *Server) takeAnnounce(c *conn) bool {
	now := s.cfg.Now()
	if c.announceAt.IsZero() {
		c.announceTokens = float64(s.cfg.MaxAnnounceBurst)
	} else if d := now.Sub(c.announceAt); d > 0 {
		c.announceTokens = min(float64(s.cfg.MaxAnnounceBurst), c.announceTokens+d.Seconds()*float64(s.cfg.MaxAnnouncesPerSecond))
	}
	c.announceAt = now
	if c.announceTokens < 1 {
		return false
	}
	c.announceTokens--
	return true
}

func (s *Server) announce(c *conn, an *pb.SessionAnnounce) *frameError {
	ref := an.GetSession()
	if !validRef(ref) {
		return errBadRef
	}
	if !bytes.Equal(ref.GetHostKey(), c.key) {
		return denied("session belongs to another host")
	}
	if ref.GetInstanceId() != c.instance {
		return invalid("the session's instance ID is not this connection's")
	}
	a := c.acct
	ann, e := checkCopies(an.GetAnnouncements(), MinSealedBytes, MaxSealedBytes, a.list.boxKeyListed)
	if e != nil {
		return e
	}
	notices, e := checkCopies(an.GetNotices(), MinSealedBytes, MaxSealedBytes, a.list.notificationKeyListed)
	if e != nil {
		return e
	}
	if !s.takeAnnounce(c) {
		return rateLimited("too many announcements on this connection")
	}
	id := idOf(ref)
	se, ok := a.sessions[id]
	if (!ok || se.owner != c) && c.sessions >= s.cfg.MaxSessionsPerConn {
		return rateLimited("too many sessions on this connection")
	}
	if !ok && len(a.sessions) >= s.cfg.MaxSessionsPerAccount {
		return rateLimited("too many sessions in this account")
	}
	// The bytes this announcement replaces: its live copies, or the
	// notices kept since it ended, deleted below.
	held := 0
	if ok {
		held = se.announcements.size() + se.notices.size()
	} else {
		for e := range a.ended {
			if idOf(e.ref) == id {
				held += e.notices.size()
			}
		}
	}
	if s.sealedBytesLocked(a)-held+ann.size()+notices.size() > s.cfg.MaxSealedBytesPerAccount {
		return rateLimited("too many sealed copies in this account")
	}
	if !ok {
		se = &session{}
		a.sessions[id] = se
		// A session announced again (its process reconnected) has its
		// live notices; the kept ones would be fetched twice.
		for e := range a.ended {
			if idOf(e.ref) == id {
				e.timer.Stop()
				delete(a.ended, e)
			}
		}
	}
	// A newer connection of the same process takes the session over.
	if se.owner != c {
		if se.owner != nil {
			se.owner.sessions--
		}
		c.sessions++
	}
	se.ref, se.owner, se.announcedAt, se.announcements, se.notices = ref, c, s.cfg.Now(), ann, notices
	s.updatedLocked(a, se)
	// an.Push: waking phones comes with the push gateway (docs/design.md,
	// step 14, stage 5, part 5).
	return nil
}

// sealedBytesLocked are the bytes of every copy the account holds in
// memory. Under s.mu.
func (s *Server) sealedBytesLocked(a *account) int {
	n := 0
	for _, se := range a.sessions {
		n += se.announcements.size() + se.notices.size()
	}
	for e := range a.ended {
		n += e.notices.size()
	}
	return n
}

// entryFor is a session's entry as client c is told it, with the copy
// sealed to its box key. Under s.mu.
func entryFor(se *session, c *conn) *pb.SessionEntry {
	return &pb.SessionEntry{Session: se.ref, AnnouncedAt: timestamppb.New(se.announcedAt), Sealed: se.announcements[string(c.device.GetBoxKey())]}
}

// updatedLocked tells each subscriber that a session's entry changed,
// with its own copy. Under s.mu.
func (s *Server) updatedLocked(a *account, se *session) {
	for sub := range a.subscribers {
		sub.queue(&pb.Frame{Body: &pb.Frame_SessionUpdated{SessionUpdated: &pb.SessionUpdated{Entry: entryFor(se, sub)}}})
	}
}

// endLocked removes a session and tells subscribers. With keep, its
// notices stay fetchable for NoticeRetention. Under s.mu.
func (s *Server) endLocked(a *account, id sessionID, se *session, keep bool) {
	delete(a.sessions, id)
	se.owner.sessions--
	if keep && len(se.notices) > 0 {
		s.keepNoticesLocked(a, se)
	}
	ended, err := s.encode(&pb.Frame{Body: &pb.Frame_SessionEnded{SessionEnded: &pb.SessionEnded{Session: se.ref}}})
	if err != nil {
		return
	}
	for sub := range a.subscribers {
		sub.queueBytes(ended)
	}
}

// keepNoticesLocked keeps an ended session's notices for
// NoticeRetention, keeping the account loaded meanwhile. Under s.mu.
func (s *Server) keepNoticesLocked(a *account, se *session) {
	e := &endedNotices{ref: se.ref, storedAt: se.announcedAt, notices: se.notices}
	e.timer = time.AfterFunc(s.cfg.NoticeRetention, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if a.ended[e] {
			delete(a.ended, e)
			s.unloadLocked(a)
		}
	})
	a.ended[e] = true
}

// forgetEndedLocked deletes every kept notice of a. Under s.mu.
func forgetEndedLocked(a *account) {
	for e := range a.ended {
		e.timer.Stop()
		delete(a.ended, e)
	}
}

// dropUnlistedLocked deletes the copies whose recipient a's newest list
// no longer has, and kept notices of computers it no longer has. Under
// s.mu.
func dropUnlistedLocked(a *account) {
	l := a.list
	for _, se := range a.sessions {
		for k := range se.announcements {
			if !l.boxKeyListed([]byte(k)) {
				delete(se.announcements, k)
			}
		}
		for k := range se.notices {
			if !l.notificationKeyListed([]byte(k)) {
				delete(se.notices, k)
			}
		}
	}
	for e := range a.ended {
		for k := range e.notices {
			if !l.notificationKeyListed([]byte(k)) {
				delete(e.notices, k)
			}
		}
		if len(e.notices) == 0 || !l.computerListed(e.ref.GetHostKey()) {
			e.timer.Stop()
			delete(a.ended, e)
		}
	}
}

func (s *Server) end(c *conn, ref *pb1.SessionRef) *frameError {
	id := idOf(ref)
	a := c.acct
	se, ok := a.sessions[id]
	if !ok || se.owner != c {
		return &frameError{code: pb1.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND, msg: "no such session on this connection"}
	}
	s.endLocked(a, id, se, true)
	return nil
}

func listFrame(entries []*pb.SessionEntry, more bool) *pb.Frame {
	return &pb.Frame{Body: &pb.Frame_SessionList{SessionList: &pb.SessionList{Sessions: entries, More: more}}}
}

// subscribe sends the account's session list as c is told it, in as many
// frames as the size limit needs, and adds c to its subscribers.
func (s *Server) subscribe(c *conn) {
	a := c.acct
	a.subscribers[c] = struct{}{}
	var batch []*pb.SessionEntry
	for _, se := range a.sessions {
		e := entryFor(se, c)
		if len(batch) > 0 && proto.Size(listFrame(append(batch, e), true)) > s.cfg.MaxFrameBytes {
			c.queue(listFrame(batch, true))
			batch = nil
		}
		batch = append(batch, e)
	}
	c.queue(listFrame(batch, false))
}

// fetchNotices sends a read-only key every notice sealed to its phone's
// notification key: of live sessions, then of those ended and kept.
func (s *Server) fetchNotices(c *conn, requestID string) *frameError {
	if !countIn(&c.fetches, s.cfg.MaxNoticeFetchesPerMinute, s.cfg.Now(), time.Minute) {
		return rateLimited("too many notice fetches; try again in a minute")
	}
	a := c.acct
	key := string(c.device.GetNotificationKey())
	var all []*pb.StoredNotice
	if key != "" {
		for _, se := range a.sessions {
			if b, ok := se.notices[key]; ok {
				all = append(all, &pb.StoredNotice{Session: se.ref, Sealed: b, StoredAt: timestamppb.New(se.announcedAt)})
			}
		}
		for e := range a.ended {
			if b, ok := e.notices[key]; ok {
				all = append(all, &pb.StoredNotice{Session: e.ref, Sealed: b, StoredAt: timestamppb.New(e.storedAt)})
			}
		}
	}
	frame := func(ns []*pb.StoredNotice, more bool) *pb.Frame {
		return &pb.Frame{Body: &pb.Frame_Notices{Notices: &pb.Notices{RequestId: requestID, Notices: ns, More: more}}}
	}
	var batch []*pb.StoredNotice
	for _, n := range all {
		if len(batch) > 0 && proto.Size(frame(append(batch, n), true)) > s.cfg.MaxFrameBytes {
			c.queue(frame(batch, true))
			batch = nil
		}
		batch = append(batch, n)
	}
	c.queue(frame(batch, false))
	return nil
}

// countIn adds one to a count for the window since c.since; false when
// that would pass max.
func countIn(c *counter, max int, now time.Time, window time.Duration) bool {
	if now.Sub(c.since) >= window {
		*c = counter{since: now}
	}
	if c.n >= max {
		return false
	}
	c.n++
	return true
}
