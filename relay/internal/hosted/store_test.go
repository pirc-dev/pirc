package hosted

import (
	"bytes"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

// storeTables are every table of the store's layout.
func storeTables(t *testing.T, s *Store) []string {
	t.Helper()
	rows, err := s.db.Query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		rows.Scan(&n)
		out = append(out, n)
	}
	return out
}

// A new file has the layout's version; a file with tables and another
// version, such as one with the members table, is refused, and left as
// it was.
func TestStoreLayout(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	var v int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil || v != storeVersion {
		t.Fatalf("user_version %d %v", v, err)
	}
	if got := strings.Join(storeTables(t, s), " "); got != "accounts attestations devices held_lists lists names removed subscriptions" {
		t.Errorf("tables %s", got)
	}
	s.Close()
	// Opened again: the same file.
	if s, err = OpenStore(dir); err != nil {
		t.Fatal(err)
	}
	s.Close()

	for _, old := range []string{
		`CREATE TABLE accounts (id BLOB PRIMARY KEY, created_ms INTEGER NOT NULL); CREATE TABLE members (account BLOB, device BLOB, role INTEGER)`,
		`CREATE TABLE accounts (id BLOB PRIMARY KEY, created_ms INTEGER NOT NULL); PRAGMA user_version = 3`,
	} {
		dir := t.TempDir()
		db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "hosted.db"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(old); err != nil {
			t.Fatal(err)
		}
		db.Close()
		if s, err := OpenStore(dir); err == nil || !strings.Contains(err.Error(), "move it away") {
			if s != nil {
				s.Close()
			}
			t.Errorf("%s: opened, %v", old, err)
		}
		db, _ = sql.Open("sqlite", "file:"+filepath.Join(dir, "hosted.db"))
		var n int
		if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name = 'lists'`).Scan(&n); err != nil || n != 0 {
			t.Errorf("an older file changed: %d %v", n, err)
		}
		db.Close()
	}
}

// Every table round-trips, and deleting an account leaves no row of it.
func TestStoreRoundTrip(t *testing.T) {
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	id, other := bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)
	phone, host := []byte("phone key"), []byte("host key")
	first := StoredList{PhoneKey: phone, Counter: 1, Hash: id, Signed: []byte("v1")}
	if err := s.CreateAccount(id, first, &Attested{Kind: "test", Ident: []byte("a")}, 5); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateAccount(other, StoredList{PhoneKey: phone, Counter: 1, Hash: other, Signed: []byte("x")}, nil, 5); err == nil {
		t.Error("a phone key made two accounts")
	}
	if err := s.CreateAccount(other, StoredList{PhoneKey: []byte("other phone"), Counter: 1, Hash: other, Signed: []byte("x")}, nil, 5); err != nil {
		t.Fatal(err)
	}
	if got, v1, err := s.AccountOfPhone(phone); err != nil || !bytes.Equal(got, id) || string(v1) != "v1" {
		t.Errorf("account of phone %x %q %v", got, v1, err)
	}
	if got, _, err := s.AccountOfPhone([]byte("nobody")); err != nil || got != nil {
		t.Errorf("account of nobody %x %v", got, err)
	}
	s.Seen(id, host, 7)
	s.SetPush(id, host, "handle")
	s.AddAttestation(id, host, "test", []byte("h"))
	s.AddSubscription(id, Subscription{Kind: "test", Ident: []byte("s")}, 5)
	s.db.Exec(`INSERT INTO names (account, recipient, sealed) VALUES (?, ?, x'00'), (?, ?, x'00')`, id, []byte("host box"), id, []byte("phone box"))

	second := StoredList{PhoneKey: phone, Counter: 2, Hash: []byte("h2"), Signed: []byte("v2")}
	if err := s.TakeList(id, second, []RemovedDevice{{SigningKey: host, BoxKey: []byte("host box")}}, 9); err != nil {
		t.Fatal(err)
	}
	if l, ok, err := s.List(id); err != nil || !ok || l.Counter != 2 || string(l.Signed) != "v2" || string(l.Hash) != "h2" || !bytes.Equal(l.PhoneKey, phone) {
		t.Errorf("list %v %v %v", l, ok, err)
	}
	// Every version held, by hash, per account.
	for _, h := range []struct {
		account, hash []byte
		want          bool
	}{{id, id, true}, {id, []byte("h2"), true}, {id, other, false}, {other, []byte("h2"), false}} {
		if got, err := s.Held(h.account, h.hash); err != nil || got != h.want {
			t.Errorf("held %q in %x: %v %v", h.hash, h.account[:1], got, err)
		}
	}
	// Not over a version as new.
	if err := s.TakeList(id, second, nil, 9); err == nil {
		t.Error("took counter 2 twice")
	}
	if rows, _ := s.Devices(id); len(rows) != 1 {
		t.Errorf("rows %v", rows)
	}
	for q, want := range map[string]int{
		`SELECT count(*) FROM attestations WHERE account = ?`: 1,
		`SELECT count(*) FROM names WHERE account = ?`:        1,
	} {
		var n int
		if s.db.QueryRow(q, id).Scan(&n); n != want {
			t.Errorf("%s: %d", q, n)
		}
	}
	if r, err := s.Removed(id, host); err != nil || !r {
		t.Errorf("removed %v %v", r, err)
	}
	if r, _ := s.Removed(other, host); r {
		t.Error("removed from another account")
	}

	if err := s.DeleteAccount(id); err != nil {
		t.Fatal(err)
	}
	for _, table := range storeTables(t, s) {
		col := "account"
		if table == "accounts" {
			col = "id"
		}
		var n int
		if err := s.db.QueryRow(`SELECT count(*) FROM `+table+` WHERE `+col+` = ?`, id).Scan(&n); err != nil || n != 0 {
			t.Errorf("%s: %d rows, %v", table, n, err)
		}
	}
	if ok, _ := s.HasAccount(other); !ok {
		t.Error("the other account went too")
	}
}

// A file made before held_lists has each account's newest put there.
func TestStoreSeedsHeld(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	id := bytes.Repeat([]byte{1}, 32)
	if err := s.CreateAccount(id, StoredList{PhoneKey: []byte("phone"), Counter: 1, Hash: id, Signed: []byte("v1")}, nil, 5); err != nil {
		t.Fatal(err)
	}
	s.TakeList(id, StoredList{PhoneKey: []byte("phone"), Counter: 2, Hash: []byte("h2"), Signed: []byte("v2")}, nil, 6)
	if _, err := s.db.Exec(`DELETE FROM held_lists`); err != nil {
		t.Fatal(err)
	}
	s.Close()
	if s, err = OpenStore(dir); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if ok, err := s.Held(id, []byte("h2")); err != nil || !ok {
		t.Errorf("the newest not seeded: %v %v", ok, err)
	}
	if ok, _ := s.Held(id, id); ok {
		t.Error("an older version seeded from nowhere")
	}
}

// A file of this layout made before subscriptions had renews gets the
// column.
func TestStoreAddsColumns(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "hosted.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE subscriptions (account BLOB NOT NULL, kind TEXT NOT NULL, ident BLOB NOT NULL, expires_ms INTEGER NOT NULL,
		trial INTEGER NOT NULL, grace INTEGER NOT NULL, sandbox INTEGER NOT NULL, checked_ms INTEGER NOT NULL, lapsed INTEGER NOT NULL DEFAULT 0,
		reason TEXT NOT NULL DEFAULT '', lapsed_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account, kind, ident));
		INSERT INTO subscriptions (account, kind, ident, expires_ms, trial, grace, sandbox, checked_ms) VALUES (x'01', 'app-store', x'02', 5, 0, 0, 0, 1);
		PRAGMA user_version = 2`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	subs, err := s.Subscriptions([]byte{1})
	if err != nil || len(subs) != 1 || subs[0].Sub.Renews {
		t.Fatalf("%v %v", subs, err)
	}
	if err := s.AddSubscription([]byte{1}, Subscription{Kind: "app-store", Ident: []byte{2}, Renews: true}, 2); err != nil {
		t.Fatal(err)
	}
	if subs, _ := s.Subscriptions([]byte{1}); !subs[0].Sub.Renews {
		t.Fatal("renews not kept")
	}
}
