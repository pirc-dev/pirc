package hosted

// Who may sign up (docs/design.md, step 14, decision 2, and stage 6): the
// relay's sign-ups are open, by invite code, or closed, a setting kept in
// the store, so that the operator's command changes it while the relay
// runs. An invite code is used once per account made, up to its uses,
// until it expires. A review code, given to the stores' reviewers, also
// stands in for the subscription: the account it makes has a review
// subscription for ReviewFor, and is deleted when that ends.

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

// The sign-up modes.
const (
	SignUpsOpen   = "open"
	SignUpsInvite = "invite"
	SignUpsClosed = "closed"
)

// DefaultSignUps is the mode of a relay whose store has none set and
// whose Config names none.
const DefaultSignUps = SignUpsInvite

// ReviewFor is how long a review code's account lasts.
const ReviewFor = 30 * 24 * time.Hour

// reviewKind is a review code's subscription's kind.
const reviewKind = "review"

// Invite is an invite code as kept.
type Invite struct {
	CodeHash []byte
	Review   bool
	UsesLeft int
	Expires  time.Time
	Made     time.Time
	Note     string
}

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// NewInviteCode is 80 random bits as 16 Crockford base32 characters in
// four groups.
func NewInviteCode() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	var s strings.Builder
	for i, c := range b {
		if i > 0 && i%4 == 0 {
			s.WriteByte('-')
		}
		s.WriteByte(crockford[c&31])
	}
	return s.String()
}

// normalInvite is a code as typed made comparable: upper case, without
// spaces or dashes, with O, I and L read as 0, 1 and 1.
func normalInvite(code string) string {
	r := strings.NewReplacer("-", "", " ", "", "O", "0", "I", "1", "L", "1")
	return r.Replace(strings.ToUpper(strings.TrimSpace(code)))
}

func inviteHash(code string) []byte {
	h := sha256.Sum256([]byte("pirc invite " + normalInvite(code)))
	return h[:]
}

// AddInvite keeps a new code for uses sign-ups until expires.
func (s *Store) AddInvite(code string, review bool, uses int, expires, now time.Time, note string) error {
	if uses < 1 {
		return errors.New("an invite needs at least one use")
	}
	_, err := s.db.Exec(`INSERT INTO invites (code_hash, review, uses_left, expires_ms, made_ms, note) VALUES (?, ?, ?, ?, ?, ?)`, inviteHash(code), review, uses, expires.UnixMilli(), now.UnixMilli(), note)
	return err
}

// Invites are every code kept, newest first.
func (s *Store) Invites() ([]Invite, error) {
	rows, err := s.db.Query(`SELECT code_hash, review, uses_left, expires_ms, made_ms, note FROM invites ORDER BY made_ms DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Invite
	for rows.Next() {
		var i Invite
		var exp, made int64
		if err := rows.Scan(&i.CodeHash, &i.Review, &i.UsesLeft, &exp, &made, &i.Note); err != nil {
			return nil, err
		}
		i.Expires, i.Made = time.UnixMilli(exp), time.UnixMilli(made)
		out = append(out, i)
	}
	return out, rows.Err()
}

// RevokeInvites ends every code whose hash starts with prefix (hex, as
// pirc-relay invites-hosted lists them); how many it ended.
func (s *Store) RevokeInvites(prefix string) (int, error) {
	if len(prefix) < 6 || strings.Trim(strings.ToLower(prefix), "0123456789abcdef") != "" {
		return 0, errors.New("give at least 6 hex characters of the code's ID")
	}
	r, err := s.db.Exec(`DELETE FROM invites WHERE lower(hex(code_hash)) LIKE ? || '%'`, strings.ToLower(prefix))
	if err != nil {
		return 0, err
	}
	n, err := r.RowsAffected()
	return int(n), err
}

// errNoInvite is a code that is not kept, used up or expired.
var errNoInvite = errors.New("the invite code is not valid, used up or expired")

// lookInvite says whether a code may be used now, and whether it is a
// review code, without using it.
func (s *Store) lookInvite(code string, now time.Time) (review bool, err error) {
	err = s.db.QueryRow(`SELECT review FROM invites WHERE code_hash = ? AND uses_left > 0 AND expires_ms > ?`, inviteHash(code), now.UnixMilli()).Scan(&review)
	if errors.Is(err, sql.ErrNoRows) {
		return false, errNoInvite
	}
	return review, err
}

// useInviteTx uses one of a code's uses, in the account's transaction.
func useInviteTx(t *sql.Tx, code string, now time.Time) error {
	r, err := t.Exec(`UPDATE invites SET uses_left = uses_left - 1 WHERE code_hash = ? AND uses_left > 0 AND expires_ms > ?`, inviteHash(code), now.UnixMilli())
	if err != nil {
		return err
	}
	if n, err := r.RowsAffected(); err != nil || n != 1 {
		return errNoInvite
	}
	return nil
}

// SignUps is the sign-up mode set, "" when none is.
func (s *Store) SignUps() (string, error) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE name = 'signups'`).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

// signUps is the mode in force: the store's, else the Config's, else
// DefaultSignUps.
func (s *Server) signUps() (string, error) {
	m, err := s.store.SignUps()
	switch {
	case err != nil:
		return "", err
	case m != "":
		return m, nil
	case s.cfg.SignUps != "":
		return s.cfg.SignUps, nil
	}
	return DefaultSignUps, nil
}

// SetSignUps sets the sign-up mode.
func (s *Store) SetSignUps(mode string) error {
	switch mode {
	case SignUpsOpen, SignUpsInvite, SignUpsClosed:
	default:
		return fmt.Errorf("sign-ups are %s, %s or %s, not %q", SignUpsOpen, SignUpsInvite, SignUpsClosed, mode)
	}
	_, err := s.db.Exec(`INSERT INTO settings (name, value) VALUES ('signups', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value`, mode)
	return err
}

// maxInviteChecks is how many CheckInvite one connection may send.
const maxInviteChecks = 10

// checkInvite answers CheckInvite: the mode, and the code's state.
func (s *Server) checkInvite(c *conn, ci *pb.CheckInvite) *frameError {
	if c.inviteChecks.Add(1) > maxInviteChecks {
		return rateLimited("too many invite checks")
	}
	if ci.GetInviteCode() != "" && !s.countInviteTry(c) {
		return rateLimited("too many invite codes tried from this address; try again in an hour")
	}
	mode, err := s.signUps()
	if err != nil {
		return internal()
	}
	out := &pb.InviteChecked{RequestId: ci.GetRequestId(), Mode: map[string]pb.SignUpMode{
		SignUpsOpen:   pb.SignUpMode_SIGN_UP_MODE_OPEN,
		SignUpsInvite: pb.SignUpMode_SIGN_UP_MODE_INVITE,
		SignUpsClosed: pb.SignUpMode_SIGN_UP_MODE_CLOSED,
	}[mode]}
	if code := ci.GetInviteCode(); code != "" {
		review, err := s.store.lookInvite(code, s.cfg.Now())
		switch {
		case err == nil:
			out.Valid, out.Review = true, review
		case !errors.Is(err, errNoInvite):
			return internal()
		}
	}
	c.queue(&pb.Frame{Body: &pb.Frame_InviteChecked{InviteChecked: out}})
	return nil
}

// countInviteTry counts a code tried, by CheckInvite or SignUp, from the
// connection's address: false past MaxInviteTriesPerAddr an hour.
func (s *Server) countInviteTry(c *conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return count(s.inviteTries, c.addr, s.cfg.MaxInviteTriesPerAddr, s.cfg.Now())
}
