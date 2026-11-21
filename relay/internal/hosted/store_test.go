package hosted

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// A database made before subscriptions had renews gets the column.
func TestStoreAddsColumns(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "hosted.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE subscriptions (account BLOB NOT NULL, kind TEXT NOT NULL, ident BLOB NOT NULL, expires_ms INTEGER NOT NULL,
		trial INTEGER NOT NULL, grace INTEGER NOT NULL, sandbox INTEGER NOT NULL, checked_ms INTEGER NOT NULL, lapsed INTEGER NOT NULL DEFAULT 0,
		reason TEXT NOT NULL DEFAULT '', lapsed_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account, kind, ident));
		INSERT INTO subscriptions (account, kind, ident, expires_ms, trial, grace, sandbox, checked_ms) VALUES (x'01', 'app-store', x'02', 5, 0, 0, 0, 1)`); err != nil {
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
