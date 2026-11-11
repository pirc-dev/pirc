//go:build unix

package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/user"
	"strconv"
	"syscall"
)

// checkOwner refuses a data directory owned by another user: the registry
// and its lock file are created 0600, so a command run as root against the
// service's directory would leave files the service cannot open.
func checkOwner(dir string) error {
	fi, err := os.Stat(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || int(st.Uid) == os.Geteuid() {
		return nil
	}
	owner := strconv.Itoa(int(st.Uid))
	if u, err := user.LookupId(owner); err == nil {
		owner = u.Username
	}
	return fmt.Errorf("%s belongs to user %s; run this command as that user (for example sudo -u %s pirc-relay ...)", dir, owner, owner)
}
