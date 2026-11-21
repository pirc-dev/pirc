// The hosted relay's store: every account's members, push handles,
// attestations and subscriptions, in SQLite (docs/design.md, step 14).
// Sessions live in memory only: they last as long as a host's connection.

package hosted

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

const schema = `
CREATE TABLE IF NOT EXISTS accounts (
  id BLOB PRIMARY KEY,
  created_ms INTEGER NOT NULL
);
-- The keys the relay admits to each account, and each one's role
-- (relay.proto's DeviceRole).
CREATE TABLE IF NOT EXISTS members (
  account BLOB NOT NULL,
  device BLOB NOT NULL,
  role INTEGER NOT NULL,
  PRIMARY KEY (account, device)
);
CREATE TABLE IF NOT EXISTS devices (
  account BLOB NOT NULL,
  device BLOB NOT NULL,
  last_seen_ms INTEGER NOT NULL DEFAULT 0,
  push_handle TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (account, device)
);
CREATE TABLE IF NOT EXISTS attestations (
  account BLOB NOT NULL,
  device BLOB NOT NULL,
  kind TEXT NOT NULL,
  ident BLOB NOT NULL,
  PRIMARY KEY (account, device, kind)
);
CREATE TABLE IF NOT EXISTS subscriptions (
  account BLOB NOT NULL,
  kind TEXT NOT NULL,
  ident BLOB NOT NULL,
  expires_ms INTEGER NOT NULL,
  trial INTEGER NOT NULL,
  grace INTEGER NOT NULL,
  sandbox INTEGER NOT NULL,
  checked_ms INTEGER NOT NULL,
  -- What the store said at checked_ms: live, or why not.
  lapsed INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  -- When it was first seen lapsed, while it stays so; else 0.
  lapsed_ms INTEGER NOT NULL DEFAULT 0,
  -- The store will renew it at its end.
  renews INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account, kind, ident)
);
`

// Store is the SQLite database of hosted accounts.
type Store struct {
	db *sql.DB
}

// OpenStore opens, or makes, the database file hosted.db in dir.
func OpenStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "hosted.db")
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)")
	if err != nil {
		return nil, err
	}
	// One writer: the server serialises its changes anyway.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	// Columns added since a table was first made: CREATE TABLE IF NOT
	// EXISTS leaves an older file's table as it was.
	for _, c := range []struct{ table, column, def, then string }{
		// Not known until the store is asked: every one is asked at the
		// next check, so that renews is not reported false meanwhile.
		{"subscriptions", "renews", "INTEGER NOT NULL DEFAULT 0", "UPDATE subscriptions SET checked_ms = 0"},
	} {
		if err := addColumn(db, c.table, c.column, c.def, c.then); err != nil {
			db.Close()
			return nil, fmt.Errorf("%s: %w", path, err)
		}
	}
	return &Store{db: db}, nil
}

// addColumn adds a column to a table that lacks it, then runs then.
func addColumn(db *sql.DB, table, column, def, then string) error {
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM pragma_table_info(?) WHERE name = ?`, table, column).Scan(&n); err != nil || n > 0 {
		return err
	}
	if _, err := db.Exec(`ALTER TABLE ` + table + ` ADD COLUMN ` + column + ` ` + def); err != nil {
		return err
	}
	_, err := db.Exec(then)
	return err
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) tx(f func(*sql.Tx) error) error {
	t, err := s.db.Begin()
	if err != nil {
		return err
	}
	if err := f(t); err != nil {
		t.Rollback()
		return err
	}
	return t.Commit()
}

// CreateAccount makes an account whose one member is client.
func (s *Store) CreateAccount(id, client []byte, nowMs int64) error {
	return s.tx(func(t *sql.Tx) error {
		if _, err := t.Exec(`INSERT INTO accounts (id, created_ms) VALUES (?, ?)`, id, nowMs); err != nil {
			return err
		}
		_, err := t.Exec(`INSERT INTO members (account, device, role) VALUES (?, ?, ?)`, id, client, int32(pb.DeviceRole_DEVICE_ROLE_CLIENT))
		return err
	})
}

// HasAccount says whether there is an account with that ID.
func (s *Store) HasAccount(id []byte) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT count(*) FROM accounts WHERE id = ?`, id).Scan(&n)
	return n > 0, err
}

// AddMember adds a key to an account with a role, or gives a member
// another.
func (s *Store) AddMember(account, device []byte, role pb.DeviceRole) error {
	_, err := s.db.Exec(`INSERT INTO members (account, device, role) VALUES (?, ?, ?) ON CONFLICT (account, device) DO UPDATE SET role = excluded.role`, account, device, int32(role))
	return err
}

// Role is the key's role in the account; unspecified when it is not a
// member, or there is no such account.
func (s *Store) Role(account, device []byte) (pb.DeviceRole, error) {
	var r int32
	err := s.db.QueryRow(`SELECT role FROM members WHERE account = ? AND device = ?`, account, device).Scan(&r)
	if errors.Is(err, sql.ErrNoRows) {
		return pb.DeviceRole_DEVICE_ROLE_UNSPECIFIED, nil
	}
	return pb.DeviceRole(r), err
}

// Member is one key of an account, and its role.
type Member struct {
	Key  []byte
	Role pb.DeviceRole
}

// Members is every member of the account, by key.
func (s *Store) Members(account []byte) ([]Member, error) {
	rows, err := s.db.Query(`SELECT device, role FROM members WHERE account = ? ORDER BY device`, account)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Member
	for rows.Next() {
		var m Member
		var r int32
		if err := rows.Scan(&m.Key, &r); err != nil {
			return nil, err
		}
		m.Role = pb.DeviceRole(r)
		out = append(out, m)
	}
	return out, rows.Err()
}

// Seen records when a device was last connected.
func (s *Store) Seen(account, device []byte, nowMs int64) error {
	_, err := s.db.Exec(`INSERT INTO devices (account, device, last_seen_ms) VALUES (?, ?, ?) ON CONFLICT (account, device) DO UPDATE SET last_seen_ms = excluded.last_seen_ms`, account, device, nowMs)
	return err
}

// SetPush registers a client's push handle, or with "" unregisters it.
func (s *Store) SetPush(account, device []byte, handle string) error {
	_, err := s.db.Exec(`INSERT INTO devices (account, device, push_handle) VALUES (?, ?, ?) ON CONFLICT (account, device) DO UPDATE SET push_handle = excluded.push_handle`, account, device, handle)
	return err
}

type deviceRow struct {
	lastSeenMs int64
	pushHandle string
}

// Devices is what the store knows of each device, by key.
func (s *Store) Devices(account []byte) (map[string]deviceRow, error) {
	rows, err := s.db.Query(`SELECT device, last_seen_ms, push_handle FROM devices WHERE account = ?`, account)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]deviceRow{}
	for rows.Next() {
		var d []byte
		var r deviceRow
		if err := rows.Scan(&d, &r.lastSeenMs, &r.pushHandle); err != nil {
			return nil, err
		}
		out[string(d)] = r
	}
	return out, rows.Err()
}

// AddAttestation records what an attestation tied the account to, for its
// deletion.
func (s *Store) AddAttestation(account, device []byte, kind string, ident []byte) error {
	_, err := s.db.Exec(`INSERT OR REPLACE INTO attestations (account, device, kind, ident) VALUES (?, ?, ?, ?)`, account, device, kind, ident)
	return err
}

// AddSubscription keeps what a store said of an account's subscription,
// checked at checkedMs, or what it says now of one kept already: live, or
// lapsed for reason.
func (s *Store) AddSubscription(account []byte, sub Subscription, checkedMs int64) error {
	return s.setSubscription(account, sub, checkedMs, "")
}

// LapseSubscription keeps that the store no longer has sub live, and why.
func (s *Store) LapseSubscription(account []byte, sub Subscription, checkedMs int64, reason string) error {
	return s.setSubscription(account, sub, checkedMs, reason)
}

func (s *Store) setSubscription(account []byte, sub Subscription, checkedMs int64, reason string) error {
	var expires int64
	if !sub.Expires.IsZero() {
		expires = sub.Expires.UnixMilli()
	}
	_, err := s.db.Exec(`INSERT INTO subscriptions (account, kind, ident, expires_ms, trial, grace, sandbox, checked_ms, lapsed, reason, lapsed_ms, renews)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, CASE WHEN ?9 THEN ?8 ELSE 0 END, ?11)
		ON CONFLICT (account, kind, ident) DO UPDATE SET expires_ms = excluded.expires_ms, trial = excluded.trial, grace = excluded.grace,
		  sandbox = excluded.sandbox, checked_ms = excluded.checked_ms, lapsed = excluded.lapsed, reason = excluded.reason,
		  lapsed_ms = CASE WHEN NOT excluded.lapsed THEN 0 WHEN subscriptions.lapsed THEN subscriptions.lapsed_ms ELSE excluded.checked_ms END,
		  renews = excluded.renews`,
		account, sub.Kind, sub.Ident, expires, sub.Trial, sub.Grace, sub.Sandbox, checkedMs, reason != "", reason, sub.Renews)
	return err
}

// Subscriptions are the account's, as the stores last said: what a
// client is shown at login. Ordered by their end, the latest last.
func (s *Store) Subscriptions(account []byte) ([]KeptSubscription, error) {
	rows, err := s.db.Query(`SELECT kind, expires_ms, trial, grace, sandbox, renews, checked_ms, lapsed, reason FROM subscriptions
		WHERE account = ? ORDER BY expires_ms = 0 DESC, expires_ms, kind, ident`, account)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []KeptSubscription
	for rows.Next() {
		k := KeptSubscription{Account: account}
		var expires int64
		if err := rows.Scan(&k.Sub.Kind, &expires, &k.Sub.Trial, &k.Sub.Grace, &k.Sub.Sandbox, &k.Sub.Renews, &k.CheckedMs, &k.Lapsed, &k.Reason); err != nil {
			return nil, err
		}
		if expires != 0 {
			k.Sub.Expires = time.UnixMilli(expires)
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// Locked says whether every subscription the account has had has lapsed,
// and since when: the last one's lapse. An account with none, which only
// a relay without the stores' checks makes, is never locked.
func (s *Store) Locked(account []byte) (bool, int64, error) {
	var n, live int
	var since int64
	err := s.db.QueryRow(`SELECT count(*), coalesce(sum(NOT lapsed), 0), coalesce(max(lapsed_ms), 0) FROM subscriptions WHERE account = ?`, account).Scan(&n, &live, &since)
	if err != nil || n == 0 || live > 0 {
		return false, 0, err
	}
	return true, since, nil
}

// LockedBefore lists the accounts locked since before ms; never one with
// a lapse of no known time.
func (s *Store) LockedBefore(ms int64) ([][]byte, error) {
	rows, err := s.db.Query(`SELECT account FROM subscriptions GROUP BY account HAVING sum(NOT lapsed) = 0 AND min(lapsed_ms) > 0 AND max(lapsed_ms) < ?`, ms)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out [][]byte
	for rows.Next() {
		var a []byte
		if err := rows.Scan(&a); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// KeptSubscription is a subscription as the store last said, and of which
// account.
type KeptSubscription struct {
	Account   []byte
	Sub       Subscription
	CheckedMs int64
	Lapsed    bool
	Reason    string
}

// SubscriptionsDue are those to ask the store about again at nowMs: any
// not asked about for a day, and those past their end (lapsed ones
// included, which a late payment can bring back) not asked about for
// an hour.
func (s *Store) SubscriptionsDue(nowMs int64) ([]KeptSubscription, error) {
	rows, err := s.db.Query(`SELECT account, kind, ident, expires_ms, trial, grace, sandbox, renews, checked_ms, lapsed, reason FROM subscriptions
		WHERE checked_ms <= ? OR (expires_ms <= ? AND checked_ms <= ?) ORDER BY checked_ms`, nowMs-24*3600_000, nowMs, nowMs-3600_000)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []KeptSubscription
	for rows.Next() {
		var k KeptSubscription
		var expires int64
		if err := rows.Scan(&k.Account, &k.Sub.Kind, &k.Sub.Ident, &expires, &k.Sub.Trial, &k.Sub.Grace, &k.Sub.Sandbox, &k.Sub.Renews, &k.CheckedMs, &k.Lapsed, &k.Reason); err != nil {
			return nil, err
		}
		if expires != 0 {
			k.Sub.Expires = time.UnixMilli(expires)
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// DeleteAccount removes the account and everything of it.
func (s *Store) DeleteAccount(account []byte) error {
	return s.tx(func(t *sql.Tx) error {
		for _, table := range []string{"members", "devices", "attestations", "subscriptions"} {
			if _, err := t.Exec(`DELETE FROM `+table+` WHERE account = ?`, account); err != nil {
				return err
			}
		}
		_, err := t.Exec(`DELETE FROM accounts WHERE id = ?`, account)
		return err
	})
}
