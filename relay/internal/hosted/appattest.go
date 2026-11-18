package hosted

// App Attest (iOS), checked as Apple's "Validating apps that connect to
// your server" says: the credential certificate chains to Apple's App
// Attestation Root CA; its nonce extension is SHA-256(authData ‖
// clientDataHash), clientDataHash being SHA-256 of what the attestation
// binds (AttestContext); the key ID is SHA-256 of the certificate's
// public key; and authData names this app, counts 0, is from the
// production environment (development's only on a sandbox relay), and
// carries that key ID as its credential.

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	_ "embed"
	"encoding/asn1"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"fmt"
	"time"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

//go:embed roots/Apple_App_Attestation_Root_CA.pem
var appAttestRootPEM []byte

var appAttestRoots = rootPool(appAttestRootPEM)

func rootPool(p []byte) *x509.CertPool {
	pool := x509.NewCertPool()
	b, _ := pem.Decode(p)
	c, err := x509.ParseCertificate(b.Bytes)
	if err != nil {
		panic(err)
	}
	pool.AddCert(c)
	return pool
}

var oidAppAttestNonce = asn1.ObjectIdentifier{1, 2, 840, 113635, 100, 8, 2}

var (
	aaguidProduction  = []byte("appattest\x00\x00\x00\x00\x00\x00\x00")
	aaguidDevelopment = []byte("appattestdevelop")
)

func verifyAppAttest(a *pb.AppAttest, data []byte, appID string, sandbox bool, now time.Time) (Attested, error) {
	v, err := cborDecode(a.GetAttestation())
	if err != nil {
		return Attested{}, err
	}
	obj, _ := v.(map[string]any)
	if f, _ := obj["fmt"].(string); f != "apple-appattest" {
		return Attested{}, errors.New("not an apple-appattest attestation")
	}
	stmt, _ := obj["attStmt"].(map[string]any)
	authData, _ := obj["authData"].([]byte)
	x5c, _ := stmt["x5c"].([]any)
	if len(x5c) < 2 || len(authData) < 55 {
		return Attested{}, errors.New("an attestation without its certificates or authenticator data")
	}
	certs := make([]*x509.Certificate, len(x5c))
	for i, c := range x5c {
		der, _ := c.([]byte)
		if certs[i], err = x509.ParseCertificate(der); err != nil {
			return Attested{}, fmt.Errorf("certificate %d: %w", i, err)
		}
	}
	inter := x509.NewCertPool()
	for _, c := range certs[1:] {
		inter.AddCert(c)
	}
	if _, err := certs[0].Verify(x509.VerifyOptions{Roots: appAttestRoots, Intermediates: inter, CurrentTime: now, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny}}); err != nil {
		return Attested{}, fmt.Errorf("the credential certificate: %w", err)
	}

	clientDataHash := sha256.Sum256(data)
	want := sha256.Sum256(append(append([]byte{}, authData...), clientDataHash[:]...))
	got, err := appAttestNonce(certs[0])
	if err != nil {
		return Attested{}, err
	}
	if !bytes.Equal(got, want[:]) {
		return Attested{}, errors.New("the attestation is for another login or key")
	}

	pub, ok := certs[0].PublicKey.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		return Attested{}, errors.New("the credential key is not P-256")
	}
	ek, err := pub.ECDH()
	if err != nil {
		return Attested{}, err
	}
	keyID := sha256.Sum256(ek.Bytes())
	if !bytes.Equal(keyID[:], a.GetKeyId()) {
		return Attested{}, errors.New("the key ID is not the credential key's")
	}

	rpID := sha256.Sum256([]byte(appID))
	if !bytes.Equal(authData[:32], rpID[:]) {
		return Attested{}, errors.New("the attestation is for another app")
	}
	if binary.BigEndian.Uint32(authData[33:37]) != 0 {
		return Attested{}, errors.New("the attestation's counter is not 0")
	}
	switch aaguid := authData[37:53]; {
	case bytes.Equal(aaguid, aaguidProduction):
	case bytes.Equal(aaguid, aaguidDevelopment) && sandbox:
	case bytes.Equal(aaguid, aaguidDevelopment):
		return Attested{}, errors.New("App Attest's development environment, which this relay does not take")
	default:
		return Attested{}, errors.New("not App Attest's environment")
	}
	n := int(binary.BigEndian.Uint16(authData[53:55]))
	if len(authData) < 55+n || !bytes.Equal(authData[55:55+n], keyID[:]) {
		return Attested{}, errors.New("the credential ID is not the key ID")
	}
	return Attested{Kind: "app-attest", Ident: keyID[:]}, nil
}

// appAttestNonce reads the credential certificate's nonce: a SEQUENCE
// holding [1] EXPLICIT OCTET STRING.
func appAttestNonce(c *x509.Certificate) ([]byte, error) {
	for _, e := range c.Extensions {
		if !e.Id.Equal(oidAppAttestNonce) {
			continue
		}
		var seq struct {
			Nonce []byte `asn1:"tag:1,explicit"`
		}
		if rest, err := asn1.Unmarshal(e.Value, &seq); err != nil || len(rest) != 0 {
			return nil, errors.New("a malformed nonce extension")
		}
		return seq.Nonce, nil
	}
	return nil, errors.New("no nonce extension")
}
