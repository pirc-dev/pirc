// An account's live sessions, its processes' bundles, and the frames
// routed between hosts and clients, all within one account (docs/e2e.md,
// sections 4 and 6). The relay reads only the frames' clear part.

package hosted

import (
	"bytes"
	"crypto/ed25519"
	"sort"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	"pirc.dev/relay/internal/e2e"
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
	keys        *pb.FrameKeys
	payload     []byte
	announcedAt time.Time
	attached    map[*conn]struct{}
}

// bundle is a process's keys of the day as it published them, kept while
// a live session uses it or a newer one, or while it is the newest of its
// process and the connection that published it is there.
type bundle struct {
	host     string
	instance string
	madeAt   int64
	obj      *pb.SignedObject
	owner    *conn
}

func msTime(ms int64) *timestamppb.Timestamp { return timestamppb.New(time.UnixMilli(ms)) }

func validRef(r *pb1.SessionRef) bool {
	return r != nil && len(r.GetHostKey()) == ed25519.PublicKeySize &&
		r.GetSessionId() != "" && len(r.GetSessionId()) <= MaxIDBytes &&
		r.GetInstanceId() != "" && len(r.GetInstanceId()) <= MaxIDBytes
}

var errBadRef = invalid("session reference incomplete or too long")

const keyIDBytes = 16

// entryLocked is a session's entry in the list: its announcement, and the
// bundles of its process from the one the announcement uses on, oldest
// first. Under s.mu.
func entryLocked(a *account, se *session) *pb.SessionEntry {
	e := &pb.SessionEntry{Session: se.ref, Keys: se.keys, Payload: se.payload, AnnouncedAt: timestamppb.New(se.announcedAt)}
	used := a.bundles[string(se.keys.GetKeyId())]
	if used == nil {
		return e
	}
	var bs []*bundle
	for _, b := range a.bundles {
		if b.host == used.host && b.instance == used.instance && b.madeAt >= used.madeAt {
			bs = append(bs, b)
		}
	}
	sort.Slice(bs, func(i, j int) bool { return bs[i].madeAt < bs[j].madeAt })
	for _, b := range bs {
		e.Bundles = append(e.Bundles, b.obj)
	}
	return e
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
	keys := an.GetKeys()
	if len(keys.GetKeyId()) != keyIDBytes {
		return invalid("key ID must be 16 bytes")
	}
	a := c.acct
	if b := a.bundles[string(keys.GetKeyId())]; b == nil || b.host != string(c.key) || b.instance != ref.GetInstanceId() {
		return invalid("no bundle of this process with that key ID")
	}
	id := idOf(ref)
	se, ok := a.sessions[id]
	if (!ok || se.owner != c) && c.sessions >= s.cfg.MaxSessionsPerConn {
		return rateLimited("too many sessions on this connection")
	}
	next := &session{ref: ref, keys: keys, payload: an.GetPayload(), announcedAt: s.cfg.Now()}
	// Every entry must fit a SessionList frame of its own (subscribe).
	if _, err := s.encode(listFrame([]*pb.SessionEntry{entryLocked(a, next)}, true)); err != nil {
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
	se.ref, se.owner, se.keys, se.payload, se.announcedAt = ref, c, keys, next.payload, next.announcedAt
	s.pruneBundlesLocked(a)
	s.updatedLocked(a, se)
	// an.Push: waking clients comes with the app's notifications
	// (docs/design.md, step 14, stage 5).
	return nil
}

// updatedLocked tells subscribers that a session's entry changed. Under
// s.mu.
func (s *Server) updatedLocked(a *account, se *session) {
	upd, err := s.encode(&pb.Frame{Body: &pb.Frame_SessionUpdated{SessionUpdated: &pb.SessionUpdated{Entry: entryLocked(a, se)}}})
	if err != nil {
		return
	}
	for sub := range a.subscribers {
		sub.queueBytes(upd)
	}
}

func (s *Server) publishBundle(c *conn, obj *pb.SignedObject) *frameError {
	if proto.Size(obj) > maxBundleBytes {
		return &frameError{code: pb1.ErrorCode_ERROR_CODE_TOO_LARGE, msg: "bundle too large"}
	}
	a := c.acct
	body, err := e2e.OpenBundle(a.id, obj)
	if err != nil {
		return refused(err)
	}
	if !bytes.Equal(body.GetHostKey(), c.key) {
		return invalid("not this host's bundle")
	}
	switch {
	case len(body.GetKeyId()) != keyIDBytes:
		return invalid("key ID must be 16 bytes")
	case body.GetInstanceId() == "" || len(body.GetInstanceId()) > MaxIDBytes:
		return invalid("instance ID empty or too long")
	case body.GetMadeAt() == nil:
		return invalid("no time made")
	case len(body.GetRequestKey()) != 32:
		return invalid("request key must be 32 bytes")
	}
	if e := s.storedRef(a, body.GetListVersion()); e != nil {
		return e
	}
	id := string(body.GetKeyId())
	b := &bundle{host: string(c.key), instance: body.GetInstanceId(), madeAt: body.GetMadeAt().AsTime().UnixMilli(), obj: obj, owner: c}
	if have := a.bundles[id]; have != nil {
		if bytes.Equal(e2e.Hash(have.obj), e2e.Hash(obj)) {
			return nil
		}
		// The same keys wrapped again, for a pre-key renewed or a device
		// added (docs/e2e.md, section 4): the newer replaces the older.
		if have.host != b.host || have.instance != b.instance || b.madeAt <= have.madeAt {
			return invalid("another bundle has this key ID")
		}
		have.owner.bundles--
	} else if c.bundles >= maxBundlesPerConn {
		return rateLimited("too many bundles on this connection")
	}
	a.bundles[id] = b
	c.bundles++
	s.pruneBundlesLocked(a)
	for _, se := range a.sessions {
		if string(se.ref.GetHostKey()) == b.host && se.ref.GetInstanceId() == b.instance {
			s.updatedLocked(a, se)
		}
	}
	return nil
}

// pruneBundlesLocked drops the bundles nothing needs: per process, those
// older than the oldest a live session uses, and with no live session,
// all but the newest while its connection is there. Under s.mu.
func (s *Server) pruneBundlesLocked(a *account) {
	type process struct{ host, instance string }
	minUsed := map[process]int64{}
	for _, se := range a.sessions {
		if b := a.bundles[string(se.keys.GetKeyId())]; b != nil {
			p := process{b.host, b.instance}
			if m, ok := minUsed[p]; !ok || b.madeAt < m {
				minUsed[p] = b.madeAt
			}
		}
	}
	newest := map[process]*bundle{}
	for _, b := range a.bundles {
		p := process{b.host, b.instance}
		if n := newest[p]; n == nil || b.madeAt > n.madeAt {
			newest[p] = b
		}
	}
	for id, b := range a.bundles {
		p := process{b.host, b.instance}
		m, used := minUsed[p]
		_, live := a.conns[b.owner]
		if (used && b.madeAt >= m) || (newest[p] == b && live) {
			continue
		}
		delete(a.bundles, id)
		b.owner.bundles--
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
	s.pruneBundlesLocked(a)
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
		e := entryLocked(a, se)
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
	if len(r.GetKeys().GetKeyId()) != keyIDBytes {
		return invalid("key ID must be 16 bytes")
	}
	se, ok := c.acct.sessions[idOf(r.GetSession())]
	if !ok {
		return errNoSession
	}
	// The relay, not the client, says who sent it; the host then checks
	// the envelope's signature (docs/e2e.md, section 4).
	out, err := s.encode(&pb.Frame{Body: &pb.Frame_Routed{Routed: &pb.Routed{
		Session:   se.ref,
		ClientKey: c.key,
		Keys:      &pb.FrameKeys{KeyId: r.GetKeys().GetKeyId()},
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
	if len(r.GetKeys().GetKeyId()) != keyIDBytes {
		return invalid("key ID must be 16 bytes")
	}
	a := c.acct
	se, ok := a.sessions[idOf(r.GetSession())]
	if !ok || se.owner != c {
		return &frameError{code: pb1.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND, msg: "no such session on this connection"}
	}
	out, err := s.encode(&pb.Frame{Body: &pb.Frame_Routed{Routed: &pb.Routed{
		Session:   se.ref,
		ClientKey: to,
		Keys:      r.GetKeys(),
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
