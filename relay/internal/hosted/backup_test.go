package hosted

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBackup(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	// A row in a table, written through the running store's connection,
	// which stays open as the relay's would.
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS backup_probe (v TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`INSERT INTO backup_probe VALUES ('kept')`); err != nil {
		t.Fatal(err)
	}

	outDir := t.TempDir()
	out := filepath.Join(outDir, "hosted.db")
	if err := os.WriteFile(out, []byte("the copy before"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Backup(dir, out); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(out)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("mode %v, want 0600", fi.Mode().Perm())
	}
	if ents, _ := os.ReadDir(outDir); len(ents) != 1 {
		t.Errorf("left %d files beside the copy", len(ents)-1)
	}
	c, err := sql.Open("sqlite", "file:"+out+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var v string
	var version int
	if err := c.QueryRow(`SELECT v FROM backup_probe`).Scan(&v); err != nil || v != "kept" {
		t.Errorf("row in the copy: %q, %v", v, err)
	}
	if err := c.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil || version != storeVersion {
		t.Errorf("copy's version %d, %v", version, err)
	}

	// A second backup replaces the first, with no file left over.
	if err := Backup(dir, out); err != nil {
		t.Fatal(err)
	}
	if ents, _ := os.ReadDir(outDir); len(ents) != 1 {
		t.Errorf("second backup left %d files beside the copy", len(ents)-1)
	}
}

func TestBackupRefuses(t *testing.T) {
	// No hosted.db: an error, and none made.
	empty := t.TempDir()
	out := filepath.Join(t.TempDir(), "hosted.db")
	if err := Backup(empty, out); err == nil {
		t.Error("backed up a directory without hosted.db")
	}
	if _, err := os.Stat(filepath.Join(empty, "hosted.db")); err == nil {
		t.Error("made a hosted.db")
	}

	// Another layout version: refused, and out left as it was.
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`PRAGMA user_version = 99`); err != nil {
		t.Fatal(err)
	}
	s.Close()
	if err := os.WriteFile(out, []byte("the copy before"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Backup(dir, out); err == nil || !strings.Contains(err.Error(), "layout version 99") {
		t.Errorf("other version: %v", err)
	}
	if b, _ := os.ReadFile(out); string(b) != "the copy before" {
		t.Error("out changed by a refused backup")
	}
}
