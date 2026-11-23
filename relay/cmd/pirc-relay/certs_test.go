package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"log/slog"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writePair writes a self-signed certificate for name, and its key, with
// the files' modification time at.
func writePair(t *testing.T, certPath, keyPath, name string, at time.Time) {
	t.Helper()
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	kd, _ := x509.MarshalECPrivateKey(k)
	write := func(path, typ string, b []byte) {
		if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: typ, Bytes: b}), 0o600); err != nil {
			t.Fatal(err)
		}
		os.Chtimes(path, at, at)
	}
	write(certPath, "CERTIFICATE", der)
	write(keyPath, "EC PRIVATE KEY", kd)
}

func servedName(t *testing.T, c *certFiles) string {
	t.Helper()
	p, err := c.get(nil)
	if err != nil {
		t.Fatal(err)
	}
	x, err := x509.ParseCertificate(p.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	return x.Subject.CommonName
}

func TestCertFilesReload(t *testing.T) {
	dir := t.TempDir()
	cert, key := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	t0 := time.Now().Add(-time.Hour)
	writePair(t, cert, key, "first", t0)
	var logs bytes.Buffer
	c, err := newCertFiles(cert, key, slog.New(slog.NewTextHandler(&logs, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if n := servedName(t, c); n != "first" {
		t.Fatalf("served %q", n)
	}
	// Renewed: taken at the next handshake.
	writePair(t, cert, key, "renewed", t0.Add(time.Minute))
	if n := servedName(t, c); n != "renewed" {
		t.Fatalf("after renewal, served %q", n)
	}
	// Half written (a new certificate, the old key): the last good pair is
	// served, and the bad one is tried once, not at every handshake.
	other, otherKey := filepath.Join(dir, "o.pem"), filepath.Join(dir, "ok.pem")
	writePair(t, other, otherKey, "next", t0)
	b, _ := os.ReadFile(other)
	os.WriteFile(cert, b, 0o600)
	os.Chtimes(cert, t0.Add(2*time.Minute), t0.Add(2*time.Minute))
	for i := 0; i < 3; i++ {
		if n := servedName(t, c); n != "renewed" {
			t.Fatalf("with a mismatched pair, served %q", n)
		}
	}
	if n := strings.Count(logs.String(), "cannot load"); n != 1 {
		t.Errorf("the bad pair logged %d times", n)
	}
	// Its key arrives: taken.
	kb, _ := os.ReadFile(otherKey)
	os.WriteFile(key, kb, 0o600)
	os.Chtimes(key, t0.Add(2*time.Minute), t0.Add(2*time.Minute))
	if n := servedName(t, c); n != "next" {
		t.Fatalf("once both files are written, served %q", n)
	}
	// Files gone: the last good pair is kept.
	os.Remove(cert)
	if n := servedName(t, c); n != "next" {
		t.Fatalf("with the files gone, served %q", n)
	}
}
