// The hosted relay's store: every account's versions, withdrawals,
// pre-keys, label records, label-key wraps, push handles and
// attestations, in SQLite (docs/design.md, step 14, stage 2). Sessions and
// bundles live in memory only: they last as long as a host's connection.
//
// Version numbers are stored as SQLite's signed 64-bit integers; a chain
// reaches 2^63 only after that many versions.

package hosted

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

const schema = `
CREATE TABLE IF NOT EXISTS accounts (
  id BLOB PRIMARY KEY,
  created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  account BLOB NOT NULL,
  number INTEGER NOT NULL,
  hash BLOB NOT NULL,
  object BLOB NOT NULL,
  PRIMARY KEY (account, number)
);
CREATE TABLE IF NOT EXISTS withdrawals (
  account BLOB NOT NULL,
  withdrawn BLOB NOT NULL,
  object BLOB NOT NULL,
  PRIMARY KEY (account, withdrawn)
);
CREATE TABLE IF NOT EXISTS pre_keys (
  account BLOB NOT NULL,
  device BLOB NOT NULL,
  object BLOB NOT NULL,
  PRIMARY KEY (account, device)
);
CREATE TABLE IF NOT EXISTS labels (
  account BLOB NOT NULL,
  key_number INTEGER NOT NULL,
  key_hash BLOB NOT NULL,
  counter INTEGER NOT NULL,
  hash BLOB NOT NULL,
  object BLOB NOT NULL,
  PRIMARY KEY (account, key_number, key_hash, hash)
);
CREATE TABLE IF NOT EXISTS label_key_wraps (
  account BLOB NOT NULL,
  key_number INTEGER NOT NULL,
  key_hash BLOB NOT NULL,
  recipient BLOB NOT NULL,
  object BLOB NOT NULL,
  PRIMARY KEY (account, key_number, key_hash, recipient)
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
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func marshal(o *pb.SignedObject) []byte {
	b, _ := proto.Marshal(o)
	return b
}

func unmarshal(b []byte) (*pb.SignedObject, error) {
	o := &pb.SignedObject{}
	return o, proto.Unmarshal(b, o)
}

// objects reads a column of encoded SignedObjects.
func objects(rows *sql.Rows, err error) ([]*pb.SignedObject, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*pb.SignedObject
	for rows.Next() {
		var b []byte
		if err := rows.Scan(&b); err != nil {
			return nil, err
		}
		o, err := unmarshal(b)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

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

// CreateAccount stores version 1 as a new account.
func (s *Store) CreateAccount(id []byte, v1 *pb.SignedObject, nowMs int64) error {
	return s.tx(func(t *sql.Tx) error {
		if _, err := t.Exec(`INSERT INTO accounts (id, created_ms) VALUES (?, ?)`, id, nowMs); err != nil {
			return err
		}
		_, err := t.Exec(`INSERT INTO versions (account, number, hash, object) VALUES (?, 1, ?, ?)`, id, id, marshal(v1))
		return err
	})
}

// Latest is the account's latest version, nil when there is no such
// account.
func (s *Store) Latest(account []byte) (*pb.SignedObject, error) {
	var b []byte
	err := s.db.QueryRow(`SELECT object FROM versions WHERE account = ? ORDER BY number DESC LIMIT 1`, account).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return unmarshal(b)
}

// VersionHash is the hash of the account's version with that number, nil
// when it has none.
func (s *Store) VersionHash(account []byte, number uint64) ([]byte, error) {
	var h []byte
	err := s.db.QueryRow(`SELECT hash FROM versions WHERE account = ? AND number = ?`, account, int64(number)).Scan(&h)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return h, err
}

// AddVersion stores a version that chains from the latest, and forgets
// what belonged to the devices it removes.
func (s *Store) AddVersion(account []byte, number uint64, hash []byte, obj *pb.SignedObject, removed [][]byte) error {
	return s.tx(func(t *sql.Tx) error {
		if _, err := t.Exec(`INSERT INTO versions (account, number, hash, object) VALUES (?, ?, ?, ?)`, account, int64(number), hash, marshal(obj)); err != nil {
			return err
		}
		for _, d := range removed {
			for _, q := range []string{
				`DELETE FROM pre_keys WHERE account = ? AND device = ?`,
				`DELETE FROM label_key_wraps WHERE account = ? AND recipient = ?`,
				`DELETE FROM devices WHERE account = ? AND device = ?`,
			} {
				if _, err := t.Exec(q, account, d); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

// Versions is every version from number `from` on, oldest first.
func (s *Store) Versions(account []byte, from uint64) ([]*pb.SignedObject, error) {
	return objects(s.db.Query(`SELECT object FROM versions WHERE account = ? AND number >= ? ORDER BY number`, account, int64(from)))
}

// AddWithdrawal stores a withdrawal; false when one of that hash is there
// already.
func (s *Store) AddWithdrawal(account, withdrawn []byte, obj *pb.SignedObject) (bool, error) {
	r, err := s.db.Exec(`INSERT OR IGNORE INTO withdrawals (account, withdrawn, object) VALUES (?, ?, ?)`, account, withdrawn, marshal(obj))
	if err != nil {
		return false, err
	}
	n, err := r.RowsAffected()
	return n == 1, err
}

func (s *Store) Withdrawals(account []byte) ([]*pb.SignedObject, error) {
	return objects(s.db.Query(`SELECT object FROM withdrawals WHERE account = ? ORDER BY rowid`, account))
}

// SetPreKey replaces the device's pre-key.
func (s *Store) SetPreKey(account, device []byte, obj *pb.SignedObject) error {
	_, err := s.db.Exec(`INSERT OR REPLACE INTO pre_keys (account, device, object) VALUES (?, ?, ?)`, account, device, marshal(obj))
	return err
}

func (s *Store) PreKeys(account []byte) ([]*pb.SignedObject, error) {
	return objects(s.db.Query(`SELECT object FROM pre_keys WHERE account = ? ORDER BY device`, account))
}

// PreKey is the device's pre-key, nil when it has none.
func (s *Store) PreKey(account, device []byte) (*pb.SignedObject, error) {
	var b []byte
	err := s.db.QueryRow(`SELECT object FROM pre_keys WHERE account = ? AND device = ?`, account, device).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return unmarshal(b)
}

// labelTop is the highest label key's version number among the records
// and wraps, and the highest counter under the key named, -1 for none.
func labelTop(t *sql.Tx, account []byte, keyHash []byte, keyNumber uint64) (maxNumber int64, maxCounter int64, err error) {
	err = t.QueryRow(`SELECT COALESCE(MAX(n), -1) FROM (SELECT key_number AS n FROM labels WHERE account = ? UNION ALL SELECT key_number FROM label_key_wraps WHERE account = ?)`, account, account).Scan(&maxNumber)
	if err != nil {
		return
	}
	err = t.QueryRow(`SELECT COALESCE(MAX(counter), -1) FROM labels WHERE account = ? AND key_number = ? AND key_hash = ?`, account, int64(keyNumber), keyHash).Scan(&maxCounter)
	return
}

// errStale is a label record or wrap under an older label key than the
// newest the relay has, or a record with a lower counter than the highest
// under its key.
var errStale = errors.New("stale")

// AddLabels keeps a label record if it is under the newest label key and
// its counter is the highest under that key, and drops the records it
// supersedes: those under older label keys, and those with lower
// counters.
func (s *Store) AddLabels(account []byte, keyNumber uint64, keyHash []byte, counter uint64, hash []byte, obj *pb.SignedObject) error {
	return s.tx(func(t *sql.Tx) error {
		maxNumber, maxCounter, err := labelTop(t, account, keyHash, keyNumber)
		if err != nil {
			return err
		}
		if int64(keyNumber) < maxNumber || int64(counter) < maxCounter {
			return errStale
		}
		if _, err := t.Exec(`INSERT OR IGNORE INTO labels (account, key_number, key_hash, counter, hash, object) VALUES (?, ?, ?, ?, ?, ?)`, account, int64(keyNumber), keyHash, int64(counter), hash, marshal(obj)); err != nil {
			return err
		}
		if _, err := t.Exec(`DELETE FROM labels WHERE account = ? AND (key_number < ? OR (key_number = ? AND key_hash = ? AND counter < ?))`, account, int64(keyNumber), int64(keyNumber), keyHash, int64(counter)); err != nil {
			return err
		}
		_, err = t.Exec(`DELETE FROM label_key_wraps WHERE account = ? AND key_number < ?`, account, int64(keyNumber))
		return err
	})
}

// Labels is the current label records: under the newest label key or
// keys, those with the highest counter.
func (s *Store) Labels(account []byte) ([]*pb.SignedObject, error) {
	return objects(s.db.Query(`SELECT object FROM labels WHERE account = ? ORDER BY key_hash, hash`, account))
}

// AddWraps keeps label-key wraps under the newest label key, one per
// recipient and key, the latest replacing the one before.
func (s *Store) AddWraps(account []byte, wraps []storedWrap) error {
	return s.tx(func(t *sql.Tx) error {
		for _, w := range wraps {
			maxNumber, _, err := labelTop(t, account, w.keyHash, w.keyNumber)
			if err != nil {
				return err
			}
			if int64(w.keyNumber) < maxNumber {
				return errStale
			}
			if _, err := t.Exec(`INSERT OR REPLACE INTO label_key_wraps (account, key_number, key_hash, recipient, object) VALUES (?, ?, ?, ?, ?)`, account, int64(w.keyNumber), w.keyHash, w.recipient, marshal(w.obj)); err != nil {
				return err
			}
			if _, err := t.Exec(`DELETE FROM labels WHERE account = ? AND key_number < ?`, account, int64(w.keyNumber)); err != nil {
				return err
			}
			if _, err := t.Exec(`DELETE FROM label_key_wraps WHERE account = ? AND key_number < ?`, account, int64(w.keyNumber)); err != nil {
				return err
			}
		}
		return nil
	})
}

type storedWrap struct {
	keyNumber uint64
	keyHash   []byte
	recipient []byte
	obj       *pb.SignedObject
}

// Wraps is the label-key wraps for one recipient.
func (s *Store) Wraps(account, recipient []byte) ([]*pb.SignedObject, error) {
	return objects(s.db.Query(`SELECT object FROM label_key_wraps WHERE account = ? AND recipient = ? ORDER BY key_hash`, account, recipient))
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
// deletion (docs/e2e.md, section 7).
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
	_, err := s.db.Exec(`INSERT OR REPLACE INTO subscriptions (account, kind, ident, expires_ms, trial, grace, sandbox, checked_ms, lapsed, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		account, sub.Kind, sub.Ident, expires, sub.Trial, sub.Grace, sub.Sandbox, checkedMs, reason != "", reason)
	return err
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
	rows, err := s.db.Query(`SELECT account, kind, ident, expires_ms, trial, grace, sandbox, checked_ms, lapsed, reason FROM subscriptions
		WHERE checked_ms <= ? OR (expires_ms <= ? AND checked_ms <= ?) ORDER BY checked_ms`, nowMs-24*3600_000, nowMs, nowMs-3600_000)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []KeptSubscription
	for rows.Next() {
		var k KeptSubscription
		var expires int64
		if err := rows.Scan(&k.Account, &k.Sub.Kind, &k.Sub.Ident, &expires, &k.Sub.Trial, &k.Sub.Grace, &k.Sub.Sandbox, &k.CheckedMs, &k.Lapsed, &k.Reason); err != nil {
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
		for _, table := range []string{"versions", "withdrawals", "pre_keys", "labels", "label_key_wraps", "devices", "attestations", "subscriptions"} {
			if _, err := t.Exec(`DELETE FROM `+table+` WHERE account = ?`, account); err != nil {
				return err
			}
		}
		_, err := t.Exec(`DELETE FROM accounts WHERE id = ?`, account)
		return err
	})
}
