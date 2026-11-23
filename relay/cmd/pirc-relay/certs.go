package main

import (
	"crypto/tls"
	"log/slog"
	"os"
	"sync"
	"time"
)

// certFiles serves the TLS certificate in a pair of files and takes a
// renewed one, written over them, at the next handshake: no restart, so
// no connection is dropped. A pair that does not load (one file written,
// the other not yet) is logged, and the last good one kept until it does.
type certFiles struct {
	cert, key string
	log       *slog.Logger

	mu sync.Mutex
	// The pair served, and the files' modification times it was loaded
	// at.
	pair            *tls.Certificate
	certMod, keyMod time.Time
	// The times of a pair that did not load, not tried again until a
	// file changes again.
	badCert, badKey time.Time
}

func newCertFiles(cert, key string, log *slog.Logger) (*certFiles, error) {
	c := &certFiles{cert: cert, key: key, log: log}
	cm, km, err := c.mods()
	if err != nil {
		return nil, err
	}
	pair, err := tls.LoadX509KeyPair(cert, key)
	if err != nil {
		return nil, err
	}
	c.pair, c.certMod, c.keyMod = &pair, cm, km
	return c, nil
}

func (c *certFiles) mods() (cert, key time.Time, err error) {
	ci, err := os.Stat(c.cert)
	if err != nil {
		return
	}
	ki, err := os.Stat(c.key)
	if err != nil {
		return
	}
	return ci.ModTime(), ki.ModTime(), nil
}

// get is tls.Config.GetCertificate.
func (c *certFiles) get(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cm, km, err := c.mods()
	if err != nil || (cm.Equal(c.certMod) && km.Equal(c.keyMod)) || (cm.Equal(c.badCert) && km.Equal(c.badKey)) {
		return c.pair, nil
	}
	pair, err := tls.LoadX509KeyPair(c.cert, c.key)
	if err != nil {
		c.badCert, c.badKey = cm, km
		c.log.Warn("cannot load the renewed TLS certificate; serving the last one", "err", err)
		return c.pair, nil
	}
	c.pair, c.certMod, c.keyMod = &pair, cm, km
	c.log.Info("TLS certificate reloaded", "cert", c.cert)
	return c.pair, nil
}
