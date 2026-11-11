// The live session list, and frames routed between hosts and clients.

package server

import (
	"bytes"
	"crypto/ed25519"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	"pirc.dev/relay/internal/registry"
)

// Limits on fields the relay stores or echoes (relay.proto, common.proto).
const (
	MaxTokenBytes    = 256
	MaxSoftwareBytes = 128
	MaxIDBytes       = 128
	// The largest frame accepted before Welcome; a Hello within the limits
	// above is far smaller.
	loginReadLimit = 4096
)

// Bounds on Config.MaxFrameBytes.
const (
	MinFrameLimit = 4 << 10
	MaxFrameLimit = 256 << 20
)

// sessionID is a SessionRef as a map key.
type sessionID struct{ host, session, instance string }

func idOf(r *pb.SessionRef) sessionID {
	return sessionID{string(r.GetHostKey()), r.GetSessionId(), r.GetInstanceId()}
}

type session struct {
	ref         *pb.SessionRef
	owner       *conn
	hostLabel   string
	payload     []byte
	announcedAt time.Time
	attached    map[*conn]struct{}
}

type frameError struct {
	code pb.ErrorCode
	msg  string
	// The request it answers, if any.
	requestID string
}

func denied(msg string) *frameError {
	return &frameError{code: pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED, msg: msg}
}

func invalid(msg string) *frameError {
	return &frameError{code: pb.ErrorCode_ERROR_CODE_INVALID, msg: msg}
}

var (
	errNoSession        = &frameError{code: pb.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND, msg: "no such session"}
	errNotYours         = &frameError{code: pb.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND, msg: "no such session on this connection"}
	errBadRef           = invalid("session reference incomplete or too long")
	errTooLarge         = &frameError{code: pb.ErrorCode_ERROR_CODE_TOO_LARGE, msg: "frame would exceed the maximum size"}
	errAnnounceTooLarge = &frameError{code: pb.ErrorCode_ERROR_CODE_TOO_LARGE, msg: "session announcement too large"}
	errTooManyForOne    = &frameError{code: pb.ErrorCode_ERROR_CODE_RATE_LIMITED, msg: "too many sessions on this connection"}
)

func validRef(r *pb.SessionRef) bool {
	return r != nil && len(r.GetHostKey()) == ed25519.PublicKeySize &&
		r.GetSessionId() != "" && len(r.GetSessionId()) <= MaxIDBytes &&
		r.GetInstanceId() != "" && len(r.GetInstanceId()) <= MaxIDBytes
}

// encode marshals a frame the relay sends, refusing one larger than the
// maximum it advertises.
func (s *Server) encode(f *pb.Frame) ([]byte, *frameError) {
	b, err := proto.Marshal(f)
	if err != nil {
		return nil, &frameError{code: pb.ErrorCode_ERROR_CODE_INTERNAL, msg: "encoding failed"}
	}
	if len(b) > s.cfg.MaxFrameBytes {
		return nil, errTooLarge
	}
	return b, nil
}

func (s *Server) handle(c *conn, f *pb.Frame) *frameError {
	host := c.role == registry.RoleHost
	if _, list := f.GetBody().(*pb.Frame_SubscribeSessions); c.readOnly && !list {
		return denied("a read-only key only reads the session list")
	}
	switch b := f.GetBody().(type) {
	case *pb.Frame_SessionAnnounce:
		if !host {
			return denied("only hosts announce sessions")
		}
		return s.announce(c, b.SessionAnnounce)
	case *pb.Frame_SessionEnd:
		if !host {
			return denied("only hosts end sessions")
		}
		return s.end(c, b.SessionEnd.GetSession())
	case *pb.Frame_SubscribeSessions:
		if host {
			return denied("only clients subscribe")
		}
		s.subscribe(c)
		return nil
	case *pb.Frame_Attach:
		if host {
			return denied("only clients attach")
		}
		return s.attach(c, b.Attach.GetSession(), true)
	case *pb.Frame_Detach:
		if host {
			return denied("only clients detach")
		}
		return s.attach(c, b.Detach.GetSession(), false)
	case *pb.Frame_WatchPendingHosts:
		if host {
			return denied("only clients watch hosts awaiting approval")
		}
		s.watchPending(c)
		return nil
	case *pb.Frame_ApproveHost:
		if host {
			return denied("only clients approve hosts")
		}
		a := b.ApproveHost
		return s.decide(c, a.GetRequestId(), a.GetPublicKey(), true, a.GetLabel())
	case *pb.Frame_RejectHost:
		if host {
			return denied("only clients reject hosts")
		}
		r := b.RejectHost
		return s.decide(c, r.GetRequestId(), r.GetPublicKey(), false, "")
	case *pb.Frame_WatchKeys:
		if host {
			return denied("only clients watch the registered keys")
		}
		s.watchKeys(c)
		return nil
	case *pb.Frame_RenameKey:
		if host {
			return denied("only clients rename keys")
		}
		return s.rename(c, b.RenameKey)
	case *pb.Frame_RemoveKey:
		if host {
			return denied("only clients remove keys")
		}
		return s.remove(c, b.RemoveKey)
	case *pb.Frame_IssueToken:
		if host {
			return denied("only clients issue tokens")
		}
		return s.issueToken(c, b.IssueToken)
	case *pb.Frame_RegisterPush:
		if host {
			return denied("only clients register for push")
		}
		return s.setPush(c, b.RegisterPush.GetRequestId(), b.RegisterPush.GetHandle(), true)
	case *pb.Frame_RegisterReadKey:
		if host {
			return denied("only clients register a read-only key")
		}
		return s.registerReadKey(c, b.RegisterReadKey)
	case *pb.Frame_UnregisterPush:
		if host {
			return denied("only clients register for push")
		}
		return s.setPush(c, b.UnregisterPush.GetRequestId(), "", false)
	case *pb.Frame_Routed:
		if host {
			return s.routeFromHost(c, b.Routed)
		}
		return s.routeFromClient(c, b.Routed)
	default:
		return invalid("unexpected frame")
	}
}

func (s *Server) entry(se *session) *pb.SessionEntry {
	return &pb.SessionEntry{
		Session:     se.ref,
		HostLabel:   se.hostLabel,
		Payload:     se.payload,
		AnnouncedAt: timestamppb.New(se.announcedAt),
	}
}

func (s *Server) announce(c *conn, a *pb.SessionAnnounce) *frameError {
	ref := a.GetSession()
	if !validRef(ref) {
		return errBadRef
	}
	if !bytes.Equal(ref.GetHostKey(), c.key) {
		return denied("session belongs to another host")
	}
	if len(a.GetPayload()) > s.cfg.MaxAnnounceBytes {
		return errAnnounceTooLarge
	}
	id := idOf(ref)
	s.mu.Lock()
	defer s.mu.Unlock()
	se, ok := s.sessions[id]
	if (!ok || se.owner != c) && c.sessions >= s.cfg.MaxSessionsPerConn {
		return errTooManyForOne
	}
	// The label registered now, which a rename since login changed.
	label := c.label
	if s.reg != nil {
		if k, ok := s.reg.Lookup(c.key); ok {
			label = k.Label
		}
	}
	next := &session{ref: ref, hostLabel: label, payload: a.GetPayload(), announcedAt: s.cfg.Now()}
	// Every entry must fit a SessionList frame of its own (subscribe).
	if _, err := s.encode(listFrame([]*pb.SessionEntry{s.entry(next)}, true)); err != nil {
		return err
	}
	upd, err := s.encode(&pb.Frame{Body: &pb.Frame_SessionUpdated{SessionUpdated: &pb.SessionUpdated{Entry: s.entry(next)}}})
	if err != nil {
		return err
	}
	if !ok {
		se = &session{attached: map[*conn]struct{}{}}
		s.sessions[id] = se
	}
	// A newer connection of the same process takes the session over: the
	// old one is a connection that has not noticed it is dead.
	if se.owner != c {
		if se.owner != nil {
			se.owner.sessions--
		}
		c.sessions++
	}
	se.ref, se.owner, se.hostLabel, se.payload, se.announcedAt = ref, c, next.hostLabel, next.payload, next.announcedAt
	for sub := range s.subscribers {
		sub.queueBytes(upd)
	}
	if a.GetPush() && s.waker != nil {
		s.waker.wakeAllLocked()
	}
	return nil
}

// endLocked removes a session and tells subscribers and attached clients.
func (s *Server) endLocked(id sessionID, se *session) {
	delete(s.sessions, id)
	se.owner.sessions--
	ended, err := s.encode(&pb.Frame{Body: &pb.Frame_SessionEnded{SessionEnded: &pb.SessionEnded{Session: se.ref}}})
	if err != nil {
		return
	}
	for sub := range s.subscribers {
		sub.queueBytes(ended)
	}
	for a := range se.attached {
		if _, ok := s.subscribers[a]; !ok {
			a.queueBytes(ended)
		}
	}
}

func (s *Server) end(c *conn, ref *pb.SessionRef) *frameError {
	id := idOf(ref)
	s.mu.Lock()
	defer s.mu.Unlock()
	se, ok := s.sessions[id]
	if !ok || se.owner != c {
		return errNotYours
	}
	s.endLocked(id, se)
	return nil
}

func listFrame(entries []*pb.SessionEntry, more bool) *pb.Frame {
	return &pb.Frame{Body: &pb.Frame_SessionList{SessionList: &pb.SessionList{Sessions: entries, More: more}}}
}

// subscribe sends the session list, in as many frames as the size limit
// needs, and adds c to the subscribers.
func (s *Server) subscribe(c *conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.subscribers[c] = struct{}{}
	var batch []*pb.SessionEntry
	for _, se := range s.sessions {
		e := s.entry(se)
		if len(batch) > 0 && proto.Size(listFrame(append(batch, e), true)) > s.cfg.MaxFrameBytes {
			c.queue(listFrame(batch, true))
			batch = nil
		}
		batch = append(batch, e)
	}
	c.queue(listFrame(batch, false))
}

func (s *Server) attach(c *conn, ref *pb.SessionRef, on bool) *frameError {
	if !validRef(ref) {
		return errBadRef
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	se, ok := s.sessions[idOf(ref)]
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
	s.mu.Lock()
	defer s.mu.Unlock()
	se, ok := s.sessions[idOf(r.GetSession())]
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
	s.mu.Lock()
	defer s.mu.Unlock()
	se, ok := s.sessions[idOf(r.GetSession())]
	if !ok || se.owner != c {
		return errNotYours
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
		for a := range se.attached {
			a.queueBytes(out)
		}
		return nil
	}
	for other := range s.conns {
		if other.role == registry.RoleClient && bytes.Equal(other.key, to) {
			other.queueBytes(out)
		}
	}
	return nil
}

// disconnect forgets the connection; safe for one that never logged in.
func (s *Server) disconnect(c *conn) {
	c.close(websocket.StatusNormalClosure, "")
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.conns[c]; !ok {
		return
	}
	delete(s.conns, c)
	delete(s.subscribers, c)
	delete(s.watchers, c)
	delete(s.keyWatchers, c)
	for id, se := range s.sessions {
		if se.owner == c {
			s.endLocked(id, se)
			continue
		}
		delete(se.attached, c)
	}
	s.pushKeysLocked()
	s.log.Info("disconnected", "role", c.role, "label", c.label)
}
