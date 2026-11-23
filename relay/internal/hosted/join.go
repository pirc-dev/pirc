// Joining: the relay pairs the device that shows a code with the account's
// phone that types it, by the code's eight lookup characters, and passes
// their steps along unread. Each lookup pairs once; a wait ends after the
// code's ten minutes, and the join with it.

package hosted

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"regexp"
	"time"

	"github.com/coder/websocket"
	pb1 "pirc.dev/relay/internal/pb/pirc/v1alpha1"
	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

// Eight Crockford base32 characters, upper case.
var lookupPattern = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{8}$`)

type joinWait struct {
	lookup  string
	conn    *conn
	att     *Attested
	started time.Time
	timer   *time.Timer
}

// A join holds no step. Its attestation is the joining phone's, kept
// until the account's phone publishes a list that has the device (see
// storeAttestationsLocked), so that a join that fails stores nothing.
type join struct {
	id             string
	device, client *conn
	steps          int
	timer          *time.Timer
	att            *Attested
}

// counter counts lookups in the hour since `since`.
type counter struct {
	n     int
	since time.Time
}

type joins struct {
	waits  map[string]*joinWait
	active map[string]*join
	// Waits by address, and lookups this hour by account and by address.
	waitsByAddr     map[string]int
	lookupsByAcct   map[string]*counter
	lookupsByAddr   map[string]*counter
	lastCounterTrim time.Time
}

func newJoins() joins {
	return joins{
		waits:         map[string]*joinWait{},
		active:        map[string]*join{},
		waitsByAddr:   map[string]int{},
		lookupsByAcct: map[string]*counter{},
		lookupsByAddr: map[string]*counter{},
	}
}

// count adds one to key's count this hour; false when that would pass max.
func count(m map[string]*counter, key string, max int, now time.Time) bool {
	c := m[key]
	if c == nil || now.Sub(c.since) >= time.Hour {
		c = &counter{since: now}
		m[key] = c
	}
	if c.n >= max {
		return false
	}
	c.n++
	return true
}

func (j *joins) trimCounters(now time.Time) {
	if now.Sub(j.lastCounterTrim) < time.Hour {
		return
	}
	j.lastCounterTrim = now
	for _, m := range []map[string]*counter{j.lookupsByAcct, j.lookupsByAddr} {
		for k, c := range m {
			if now.Sub(c.since) >= time.Hour {
				delete(m, k)
			}
		}
	}
}

func (s *Server) joinWait(ctx context.Context, c *conn, w *pb.JoinWait) *frameError {
	if !lookupPattern.MatchString(w.GetLookup()) {
		return invalid("a lookup is eight Crockford base32 characters, upper case")
	}
	var att *Attested
	if w.GetAttestation() != nil {
		if s.cfg.Verifier == nil {
			return denied("this relay takes no attestations")
		}
		a, err := s.cfg.Verifier.Attest(ctx, w.GetAttestation(), s.attestData(c))
		if err != nil {
			return denied("attestation refused: " + err.Error())
		}
		att = &a
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	j := &s.joins
	if c.wait != nil || c.joinID != "" {
		return invalid("already waiting for a join")
	}
	if j.waitsByAddr[c.addr] >= s.cfg.MaxWaitsPerAddr || len(j.waits) >= s.cfg.MaxWaits {
		return rateLimited("too many joins waiting")
	}
	if j.waits[w.GetLookup()] != nil {
		return invalid("a join with this lookup is waiting")
	}
	wait := &joinWait{lookup: w.GetLookup(), conn: c, att: att, started: s.cfg.Now()}
	wait.timer = time.AfterFunc(s.cfg.JoinTimeout, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if j.waits[wait.lookup] == wait {
			s.unwaitLocked(wait)
			c.queue(errorFrame(pb1.ErrorCode_ERROR_CODE_TIMEOUT, "the join code expired", ""))
		}
	})
	j.waits[wait.lookup] = wait
	j.waitsByAddr[c.addr]++
	c.wait = wait
	return nil
}

// unwaitLocked ends a wait. Under s.mu.
func (s *Server) unwaitLocked(w *joinWait) {
	j := &s.joins
	w.timer.Stop()
	delete(j.waits, w.lookup)
	if j.waitsByAddr[w.conn.addr]--; j.waitsByAddr[w.conn.addr] <= 0 {
		delete(j.waitsByAddr, w.conn.addr)
	}
	w.conn.wait = nil
}

func (s *Server) joinLookup(c *conn, l *pb.JoinLookup) *frameError {
	j := &s.joins
	now := s.cfg.Now()
	j.trimCounters(now)
	if c.joinID != "" {
		return invalid("already joining a device")
	}
	// Only the account's phone signs a device on; a refused lookup spends
	// nothing and leaves the wait.
	if c.role != pb.DeviceRole_DEVICE_ROLE_CLIENT || !bytes.Equal(c.key, c.acct.list.phoneKey) {
		return denied("only the account's phone looks up a join")
	}
	if !count(j.lookupsByAcct, string(c.acct.id), s.cfg.MaxLookupsPerAccount, now) || !count(j.lookupsByAddr, c.addr, s.cfg.MaxLookupsPerAddr, now) {
		return rateLimited("too many join lookups; try again in an hour")
	}
	w := j.waits[l.GetLookup()]
	if w == nil || w.conn == c {
		return &frameError{code: pb1.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND, msg: "no device waits with that code"}
	}
	s.unwaitLocked(w)
	idb := make([]byte, 16)
	rand.Read(idb)
	jn := &join{id: hex.EncodeToString(idb), device: w.conn, client: c, att: w.att}
	left := s.cfg.JoinTimeout - now.Sub(w.started)
	jn.timer = time.AfterFunc(max(left, 0), func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if j.active[jn.id] == jn {
			s.endJoinLocked(jn, nil)
		}
	})
	j.active[jn.id] = jn
	w.conn.joinID, c.joinID = jn.id, jn.id
	c.queue(&pb.Frame{Body: &pb.Frame_JoinPaired{JoinPaired: &pb.JoinPaired{RequestId: l.GetRequestId(), JoinId: jn.id}}})
	w.conn.queue(&pb.Frame{Body: &pb.Frame_JoinPaired{JoinPaired: &pb.JoinPaired{JoinId: jn.id}}})
	return nil
}

// storeAttestationsLocked writes the attestation of each live join of a
// whose device the list a now has lists, and forgets it. Under s.mu.
func (s *Server) storeAttestationsLocked(a *account) {
	for _, jn := range s.joins.active {
		if jn.att == nil || jn.client.acct != a {
			continue
		}
		if _, role := a.list.deviceFor(jn.device.key); role != pb.DeviceRole_DEVICE_ROLE_CLIENT && role != pb.DeviceRole_DEVICE_ROLE_HOST {
			continue
		}
		if err := s.store.AddAttestation(a.id, jn.device.key, jn.att.Kind, jn.att.Ident); err != nil {
			s.log.Error("cannot store an attestation", "err", err)
			continue
		}
		jn.att = nil
	}
}

// armIdleLocked closes c when it has been logged in without an account
// and in no wait or join for NoAccountIdle. Under s.mu.
func (s *Server) armIdleLocked(c *conn) {
	c.idle = time.AfterFunc(s.cfg.NoAccountIdle, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if _, ok := s.conns[c]; !ok || c.acct != nil {
			return
		}
		if c.wait == nil && c.joinID == "" {
			c.close(websocket.StatusPolicyViolation, "idle")
			return
		}
		s.armIdleLocked(c)
	})
}

// other is the side of j that is not c; nil when c is not in it.
func (jn *join) other(c *conn) *conn {
	switch c {
	case jn.device:
		return jn.client
	case jn.client:
		return jn.device
	}
	return nil
}

// endJoinLocked ends a join and tells its sides, but for `by`, which
// ended it. Under s.mu.
func (s *Server) endJoinLocked(jn *join, by *conn) {
	jn.timer.Stop()
	delete(s.joins.active, jn.id)
	for _, side := range []*conn{jn.device, jn.client} {
		side.joinID = ""
		if side != by {
			side.queue(&pb.Frame{Body: &pb.Frame_JoinEnded{JoinEnded: &pb.JoinEnded{JoinId: jn.id}}})
		}
	}
}

func (s *Server) joinMessage(c *conn, m *pb.JoinMessage) *frameError {
	jn := s.joins.active[m.GetJoinId()]
	if jn == nil || jn.other(c) == nil {
		return &frameError{code: pb1.ErrorCode_ERROR_CODE_SESSION_NOT_FOUND, msg: "no such join"}
	}
	if len(m.GetStep()) > maxJoinStepBytes {
		return &frameError{code: pb1.ErrorCode_ERROR_CODE_TOO_LARGE, msg: "join step too large"}
	}
	if jn.steps++; jn.steps > maxJoinSteps {
		s.endJoinLocked(jn, nil)
		return invalid("too many join steps")
	}
	jn.other(c).queue(&pb.Frame{Body: &pb.Frame_JoinMessage{JoinMessage: &pb.JoinMessage{JoinId: jn.id, Step: m.GetStep()}}})
	return nil
}

func (s *Server) joinEnded(c *conn, id string) {
	if jn := s.joins.active[id]; jn != nil && jn.other(c) != nil {
		s.endJoinLocked(jn, c)
	}
}

// dropLocked ends c's wait or join, when it goes. Under s.mu.
func (j *joins) dropLocked(s *Server, c *conn) {
	if c.wait != nil {
		s.unwaitLocked(c.wait)
	}
	if jn := j.active[c.joinID]; jn != nil {
		s.endJoinLocked(jn, c)
	}
}
