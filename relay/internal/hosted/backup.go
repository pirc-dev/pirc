package hosted

import (
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Backup copies hosted.db in dir to out while the relay may be running:
// SQLite's VACUUM INTO, which reads one transaction, so the copy is
// consistent; then the copy is checked (integrity_check and the same
// layout version), synced, made readable by its owner alone and renamed
// over out, so out is always a whole, checked copy or the one before.
// It never makes hosted.db: a directory without one is an error.
func Backup(dir, out string) error {
	path := filepath.Join(dir, "hosted.db")
	if _, err := os.Stat(path); err != nil {
		return err
	}
	db, err := sql.Open("sqlite", "file:"+path+"?mode=rw&_pragma=busy_timeout(5000)")
	if err != nil {
		return err
	}
	defer db.Close()
	var version int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	if version != storeVersion {
		return fmt.Errorf("%s has layout version %d, and this relay writes %d: back it up with its own release", path, version, storeVersion)
	}

	tmp := filepath.Join(filepath.Dir(out), "."+filepath.Base(out)+".tmp")
	if err := os.Remove(tmp); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if _, err := db.Exec(`VACUUM INTO ?`, tmp); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("copying %s: %w", path, err)
	}
	if err := checkCopy(tmp, version); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := syncFile(tmp); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, out); err != nil {
		os.Remove(tmp)
		return err
	}
	return syncDir(filepath.Dir(out))
}

func checkCopy(path string, version int) error {
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return err
	}
	defer db.Close()
	var ok string
	if err := db.QueryRow(`PRAGMA integrity_check`).Scan(&ok); err != nil {
		return fmt.Errorf("checking the copy: %w", err)
	}
	if ok != "ok" {
		return fmt.Errorf("the copy fails its integrity check: %s", ok)
	}
	var v int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return fmt.Errorf("checking the copy: %w", err)
	}
	if v != version {
		return fmt.Errorf("the copy has layout version %d, not %d", v, version)
	}
	return nil
}

func syncFile(path string) error {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
