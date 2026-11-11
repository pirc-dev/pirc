// Package gateway is PiRC's push gateway (docs/gateway.md): it holds the
// publisher's Apple and Google credentials, gives an app a handle for its
// push token, and sends an empty push to the handle a relay asks it to
// wake. It keeps nothing but counters.
package gateway

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
)

// Target is where a push goes, as a handle carries it.
type Target struct {
	Platform    string `json:"p"`
	Environment string `json:"e,omitempty"`
	App         string `json:"a"`
	Token       string `json:"t"`
}

// Platforms, and APNs's environments.
const (
	APNs        = "apns"
	FCM         = "fcm"
	Development = "development"
	Production  = "production"
)

// handleVersion is the handle's first byte, so that its form can change.
const handleVersion = 1

// MaxHandleBytes bounds a handle, as the relay does.
const MaxHandleBytes = 1024

// KeySize is the gateway key's length: AES-256.
const KeySize = 32

var errHandle = errors.New("handle not valid")

// Sealer makes and opens handles: the target, encrypted and authenticated
// with the gateway's key under a random nonce, so that each is different
// and changing the key invalidates them all.
type Sealer struct {
	aead cipher.AEAD
}

func NewSealer(key []byte) (*Sealer, error) {
	if len(key) != KeySize {
		return nil, fmt.Errorf("the gateway key must be %d bytes, not %d", KeySize, len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Sealer{aead: aead}, nil
}

// Seal returns the handle for t, base64url without padding.
func (s *Sealer) Seal(t Target) (string, error) {
	plain, err := json.Marshal(t)
	if err != nil {
		return "", err
	}
	out := make([]byte, 1+s.aead.NonceSize(), 1+s.aead.NonceSize()+len(plain)+s.aead.Overhead())
	out[0] = handleVersion
	if _, err := rand.Read(out[1:]); err != nil {
		return "", err
	}
	// The version byte is authenticated with the rest.
	out = s.aead.Seal(out, out[1:], plain, out[:1])
	h := base64.RawURLEncoding.EncodeToString(out)
	if len(h) > MaxHandleBytes {
		return "", errors.New("token too long for a handle")
	}
	return h, nil
}

// Open returns the target of a handle this key made.
func (s *Sealer) Open(h string) (Target, error) {
	var t Target
	if len(h) > MaxHandleBytes {
		return t, errHandle
	}
	b, err := base64.RawURLEncoding.DecodeString(h)
	n := s.aead.NonceSize()
	if err != nil || len(b) < 1+n+s.aead.Overhead() || b[0] != handleVersion {
		return t, errHandle
	}
	plain, err := s.aead.Open(nil, b[1:1+n], b[1+n:], b[:1])
	if err != nil || json.Unmarshal(plain, &t) != nil {
		return t, errHandle
	}
	return t, nil
}
