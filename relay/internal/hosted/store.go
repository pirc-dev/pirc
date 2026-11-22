// The hosted relay's store: every account's newest list, the keys removed
// from it, push handles, attestations and subscriptions, in SQLite
// (docs/design.md, step 14), and the names the account's phone seals to
// each client. Sessions and their sealed copies live in memory only: they
// last as long as a host's connection.

package hosted

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// storeVersion is the layout's PRAGMA user_version. A file with tables and
// another version is refused: the relay never wipes one itself.
const storeVersion = 2

const schema = `
-- An account's ID is SHA-256 of its list's version 1 body.
CREATE TABLE IF NOT EXISTS accounts (
  id BLOB PRIMARY KEY,
  created_ms INTEGER NOT NULL
);
-- Each account's newest list, as signed: the signature, then the body;
-- and the account's phone's signing key, version 1's one device.
CREATE TABLE IF NOT EXISTS lists (
  account BLOB PRIMARY KEY,
  phone_key BLOB NOT NULL UNIQUE,
  counter INTEGER NOT NULL,
  hash BLOB NOT NULL,
  signed BLOB NOT NULL,
  taken_ms INTEGER NOT NULL
);
-- The account's phone's names, sealed to each client's box key.
CREATE TABLE IF NOT EXISTS names (
  account BLOB NOT NULL,
  recipient BLOB NOT NULL,
  sealed BLOB NOT NULL,
  PRIMARY KEY (account, recipient)
);
-- Signing and read-only keys a version of the account's list removed,
-- until the account is deleted.
CREATE TABLE IF NOT EXISTS removed (
  account BLOB NOT NULL,
  key BLOB NOT NULL,
  PRIMARY KEY (account, key)
);
-- Listed devices only, by signing key.
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
	// The check, the tables and the version in one transaction: a file is
	// never left with tables and no version.
	if err := (&Store{db: db}).tx(func(t *sql.Tx) error {
		if err := checkVersion(t); err != nil {
			return err
		}
		_, err := t.Exec(schema + fmt.Sprintf("PRAGMA user_version = %d;", storeVersion))
		return err
	}); err != nil {
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

// checkVersion refuses a file that has tables but another layout.
func checkVersion(db *sql.Tx) error {
	var v, tables int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return err
	}
	if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type = 'table'`).Scan(&tables); err != nil {
		return err
	}
	if tables > 0 && v != storeVersion {
		return fmt.Errorf("layout %d, not %d: the file is from an older relay, and no migration exists; move it away to start with an empty store", v, storeVersion)
	}
	return nil
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

// StoredList is an account's newest list as the store has it.
type StoredList struct {
	PhoneKey []byte
	Counter  uint64
	Hash     []byte
	Signed   []byte
}

// CreateAccount makes an account with its list's version 1, the phone's
// device row and, when att is not nil, its attestation, in one
// transaction.
func (s *Store) CreateAccount(id []byte, l StoredList, att *Attested, nowMs int64) error {
	return s.tx(func(t *sql.Tx) error {
		if _, err := t.Exec(`INSERT INTO accounts (id, created_ms) VALUES (?, ?)`, id, nowMs); err != nil {
			return err
		}
		if _, err := t.Exec(`INSERT INTO lists (account, phone_key, counter, hash, signed, taken_ms) VALUES (?, ?, ?, ?, ?, ?)`, id, l.PhoneKey, int64(l.Counter), l.Hash, l.Signed, nowMs); err != nil {
			return err
		}
		if _, err := t.Exec(`INSERT INTO devices (account, device) VALUES (?, ?)`, id, l.PhoneKey); err != nil {
			return err
		}
		if att == nil {
			return nil
		}
		_, err := t.Exec(`INSERT OR REPLACE INTO attestations (account, device, kind, ident) VALUES (?, ?, ?, ?)`, id, l.PhoneKey, att.Kind, att.Ident)
		return err
	})
}

// HasAccount says whether there is an account with that ID.
func (s *Store) HasAccount(id []byte) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT count(*) FROM accounts WHERE id = ?`, id).Scan(&n)
	return n > 0, err
}

// AccountOfPhone is the account the phone's key made, and its version
// 1 as signed; nil when it made none.
func (s *Store) AccountOfPhone(phoneKey []byte) (id, first []byte, err error) {
	var counter int64
	var signed []byte
	err = s.db.QueryRow(`SELECT account, counter, signed FROM lists WHERE phone_key = ?`, phoneKey).Scan(&id, &counter, &signed)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	if counter == 1 {
		first = signed
	}
	return id, first, nil
}

// List is the account's newest list; ok is false when there is none.
func (s *Store) List(account []byte) (l StoredList, ok bool, err error) {
	var counter int64
	err = s.db.QueryRow(`SELECT phone_key, counter, hash, signed FROM lists WHERE account = ?`, account).Scan(&l.PhoneKey, &counter, &l.Hash, &l.Signed)
	if errors.Is(err, sql.ErrNoRows) {
		return l, false, nil
	}
	l.Counter = uint64(counter)
	return l, err == nil, err
}

// RemovedDevice is a device a version removed: its signing key, its
// box key, and a phone's read-only key.
type RemovedDevice struct {
	SigningKey, BoxKey, ReadOnlyKey []byte
}

// TakeList replaces the account's list with a newer version and, for
// each device it removes, deletes its device row, the names sealed to it
// and its attestations, and records its keys as removed: in one
// transaction, committed to disk before it returns.
func (s *Store) TakeList(account []byte, l StoredList, removed []RemovedDevice, nowMs int64) error {
	return s.tx(func(t *sql.Tx) error {
		r, err := t.Exec(`UPDATE lists SET counter = ?, hash = ?, signed = ?, taken_ms = ? WHERE account = ? AND counter < ?`, int64(l.Counter), l.Hash, l.Signed, nowMs, account, int64(l.Counter))
		if err != nil {
			return err
		}
		if n, err := r.RowsAffected(); err != nil || n != 1 {
			return fmt.Errorf("hosted: no older list to replace (%d, %v)", n, err)
		}
		for _, d := range removed {
			for _, q := range []struct {
				sql string
				key []byte
			}{
				{`DELETE FROM devices WHERE account = ? AND device = ?`, d.SigningKey},
				{`DELETE FROM attestations WHERE account = ? AND device = ?`, d.SigningKey},
				{`DELETE FROM names WHERE account = ? AND recipient = ?`, d.BoxKey},
				{`INSERT OR IGNORE INTO removed (account, key) VALUES (?, ?)`, d.SigningKey},
				{`INSERT OR IGNORE INTO removed (account, key) VALUES (?, ?)`, d.ReadOnlyKey},
			} {
				if len(q.key) == 0 {
					continue
				}
				if _, err := t.Exec(q.sql, account, q.key); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

// SetNames replaces every names copy of the account with these, by
// recipient box key, in one transaction.
func (s *Store) SetNames(account []byte, copies map[string][]byte) error {
	return s.tx(func(t *sql.Tx) error {
		if _, err := t.Exec(`DELETE FROM names WHERE account = ?`, account); err != nil {
			return err
		}
		for k, b := range copies {
			if _, err := t.Exec(`INSERT INTO names (account, recipient, sealed) VALUES (?, ?, ?)`, account, []byte(k), b); err != nil {
				return err
			}
		}
		return nil
	})
}

// Names are the account's names copies, by recipient box key.
func (s *Store) Names(account []byte) (map[string][]byte, error) {
	rows, err := s.db.Query(`SELECT recipient, sealed FROM names WHERE account = ?`, account)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]byte{}
	for rows.Next() {
		var k, b []byte
		if err := rows.Scan(&k, &b); err != nil {
			return nil, err
		}
		out[string(k)] = b
	}
	return out, rows.Err()
}

// Removed says whether a version of the account's list removed the key.
func (s *Store) Removed(account, key []byte) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT count(*) FROM removed WHERE account = ? AND key = ?`, account, key).Scan(&n)
	return n > 0, err
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

// accountTables are every table with an account column.
var accountTables = []string{"lists", "names", "removed", "devices", "attestations", "subscriptions"}

// DeleteAccount removes the account and everything of it.
func (s *Store) DeleteAccount(account []byte) error {
	return s.tx(func(t *sql.Tx) error {
		for _, table := range accountTables {
			if _, err := t.Exec(`DELETE FROM `+table+` WHERE account = ?`, account); err != nil {
				return err
			}
		}
		_, err := t.Exec(`DELETE FROM accounts WHERE id = ?`, account)
		return err
	})
}
