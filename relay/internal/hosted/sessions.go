// An account's live sessions, and the frames routed between hosts and
// clients, all within one account. The relay passes payloads on unread.

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

// sessionID is a SessionRef as a map key.
type sessionID struct{ host, session, instance string }

func idOf(r *pb1.SessionRef) sessionID {
	return sessionID{string(r.GetHostKey()), r.GetSessionId(), r.GetInstanceId()}
}

type session struct {
	ref         *pb1.SessionRef
	owner       *conn
	payload     []byte
	announcedAt time.Time
	attached    map[*conn]struct{}
}

func msTime(ms int64) *timestamppb.Timestamp { return timestamppb.New(time.UnixMilli(ms)) }

func validRef(r *pb1.SessionRef) bool {
	return r != nil && len(r.GetHostKey()) == ed25519.PublicKeySize &&
		r.GetSessionId() != "" && len(r.GetSessionId()) <= MaxIDBytes &&
		r.GetInstanceId() != "" && len(r.GetInstanceId()) <= MaxIDBytes
}

var errBadRef = invalid("session reference incomplete or too long")

// entryLocked is a session's entry in the list. Under s.mu.
func entryLocked(se *session) *pb.SessionEntry {
	return &pb.SessionEntry{Session: se.ref, Payload: se.payload, AnnouncedAt: timestamppb.New(se.announcedAt)}
}

func (s *Server) announce(c *conn, an *pb.SessionAnnounce) *frameError {
	ref := an.GetSession()
	if !validRef(ref) {
		return errBadRef
	}
	if !bytes.Equal(ref.GetHostKey(), c.key) {
		return denied("session belongs to another host")
	}
	if len(an.GetPayload()) > s.cfg.MaxAnnounceBytes {
		return &frameError{code: pb1.ErrorCode_ERROR_CODE_TOO_LARGE, msg: "session announcement too large"}
	}
	a := c.acct
	id := idOf(ref)
	se, ok := a.sessions[id]
	if (!ok || se.owner != c) && c.sessions >= s.cfg.MaxSessionsPerConn {
		return rateLimited("too many sessions on this connection")
	}
	next := &session{ref: ref, payload: an.GetPayload(), announcedAt: s.cfg.Now()}
	// Every entry must fit a SessionList frame of its own (subscribe).
	if _, err := s.encode(listFrame([]*pb.SessionEntry{entryLocked(next)}, true)); err != nil {
		return err
	}
	if !ok {
		se = &session{attached: map[*conn]struct{}{}}
		a.sessions[id] = se
	}
	// A newer connection of the same process takes the session over.
	if se.owner != c {
		if se.owner != nil {
			se.owner.sessions--
		}
		c.sessions++
	}
	se.ref, se.owner, se.payload, se.announcedAt = ref, c, next.payload, next.announcedAt
	s.updatedLocked(a, se)
	// an.Push: waking clients comes with the app's notifications
	// (docs/design.md, step 14, stage 5).
	return nil
}

// updatedLocked tells subscribers that a session's entry changed. Under
// s.mu.
func (s *Server) updatedLocked(a *account, se *session) {
	upd, err := s.encode(&pb.Frame{Body: &pb.Frame_SessionUpdated{SessionUpdated: &pb.SessionUpdated{Entry: entryLocked(se)}}})
	if err != nil {
		return
	}
	for sub := range a.subscribers {
		sub.queueBytes(upd)
	}
}

// endLocked removes a session and tells subscribers and attached clients.
// Under s.mu.
func (s *Server) endLocked(a *account, id sessionID, se *session) {
	delete(a.sessions, id)
	se.owner.sessions--
	ended, err := s.encode(&pb.Frame{Body: &pb.Frame_SessionEnded{SessionEnded: &pb.SessionEnded{Session: se.ref}}})
	if err != nil {
		return
	}
	for sub := range a.subscribers {
		sub.queueBytes(ended)
	}
	for o := range se.attached {
		if _, ok := a.subscribers[o]; !ok {
			o.queueBytes(ended)
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
	s.endLocked(a, id, se)
	return nil
}

func listFrame(entries []*pb.SessionEntry, more bool) *pb.Frame {
	return &pb.Frame{Body: &pb.Frame_SessionList{SessionList: &pb.SessionList{Sessions: entries, More: more}}}
}

// subscribe sends the account's session list, in as many frames as the
// size limit needs, and adds c to its subscribers.
func (s *Server) subscribe(c *conn) {
	a := c.acct
	a.subscribers[c] = struct{}{}
	var batch []*pb.SessionEntry
	for _, se := range a.sessions {
		e := entryLocked(se)
		if len(batch) > 0 && proto.Size(listFrame(append(batch, e), true)) > s.cfg.MaxFrameBytes {
			c.queue(listFrame(batch, true))
			batch = nil
		}
		batch = append(batch, e)
	}
	c.queue(listFrame(batch, false))
}

func (s *Server) attach(c *conn, ref *pb1.SessionRef, on bool) *frameError {
	if !validRef(ref) {
		return errBadRef
	}
	se, ok := c.acct.sessions[idOf(ref)]
	if !ok {
		if !on {
			return nil
		}
		return errNoSession
	}
	if on {
		se.attached[c] = struct{}{}
	} else {
		delete(se.attached, c)
	}
	return nil
}

func (s *Server) routeFromClient(c *conn, r *pb.Routed) *frameError {
	if !validRef(r.GetSession()) {
		return errBadRef
	}
	se, ok := c.acct.sessions[idOf(r.GetSession())]
	if !ok {
		return errNoSession
	}
	// The relay, not the client, says who sent it.
	out, err := s.encode(&pb.Frame{Body: &pb.Frame_Routed{Routed: &pb.Routed{
		Session:   se.ref,
		ClientKey: c.key,
		Payload:   r.GetPayload(),
	}}})
	if err != nil {
		return err
	}
	se.owner.queueBytes(out)
	return nil
}

func (s *Server) routeFromHost(c *conn, r *pb.Routed) *frameError {
	to := r.GetClientKey()
	if len(to) != 0 && len(to) != ed25519.PublicKeySize {
		return invalid("client key must be 32 bytes")
	}
	a := c.acct
	se, ok := a.sessions[idOf(r.GetSession())]
	if !ok || se.owner != c {
		return &frameError{code: pb1.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND, msg: "no such session on this connection"}
	}
	out, err := s.encode(&pb.Frame{Body: &pb.Frame_Routed{Routed: &pb.Routed{
		Session:   se.ref,
		ClientKey: to,
		Payload:   r.GetPayload(),
	}}})
	if err != nil {
		return err
	}
	if len(to) == 0 {
		for o := range se.attached {
			o.queueBytes(out)
		}
		return nil
	}
	for o := range a.conns {
		if o.role == pb.DeviceRole_DEVICE_ROLE_CLIENT && bytes.Equal(o.key, to) {
			o.queueBytes(out)
		}
	}
	return nil
}
