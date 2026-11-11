package gateway

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// Apple's push servers, the test ones for development builds.
const (
	APNsProduction  = "https://api.push.apple.com"
	APNsDevelopment = "https://api.sandbox.push.apple.com"
)

// What every push says when it cannot be replaced: the app's notification
// extension writes the real one (docs/design.md, section 12, step 13).
var apnsPayload = []byte(`{"aps":{"alert":{"title":"PiRC","body":"A session needs you"},"mutable-content":1,"sound":"default"}}`)

// Outcomes of a push, other than an error: sent, or the token is no
// longer valid.
var errGone = errors.New("token no longer valid")

// APNsSender sends through Apple's push service with a token-based key
// (a .p8 file, its key ID and the team's ID).
type APNsSender struct {
	KeyID, TeamID string
	Key           *ecdsa.PrivateKey
	Client        *http.Client
	// Where each environment's pushes go; Apple's when empty.
	Production, Development string
	Now                     func() time.Time

	mu    sync.Mutex
	jwt   string
	jwtAt time.Time
}

// ParseP8 reads Apple's .p8 file: a PKCS #8 P-256 key in PEM.
func ParseP8(b []byte) (*ecdsa.PrivateKey, error) {
	blk, _ := pem.Decode(b)
	if blk == nil {
		return nil, errors.New("the APNs key is not PEM")
	}
	k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil {
		return nil, fmt.Errorf("the APNs key: %w", err)
	}
	ec, ok := k.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("the APNs key is not an EC key")
	}
	return ec, nil
}

// Apple takes a provider token for an hour, and refuses one renewed more
// often than every 20 minutes.
const apnsTokenAge = 50 * time.Minute

func (a *APNsSender) now() time.Time {
	if a.Now != nil {
		return a.Now()
	}
	return time.Now()
}

func (a *APNsSender) token() (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	if a.jwt != "" && now.Sub(a.jwtAt) < apnsTokenAge {
		return a.jwt, nil
	}
	header := map[string]string{"alg": "ES256", "kid": a.KeyID}
	claims := map[string]any{"iss": a.TeamID, "iat": now.Unix()}
	t, err := signJWT(header, claims, func(digest []byte) ([]byte, error) {
		r, s, err := ecdsa.Sign(rand.Reader, a.Key, digest)
		if err != nil {
			return nil, err
		}
		// JWS takes r and s as fixed-width big-endian halves.
		return append(fixed(r, 32), fixed(s, 32)...), nil
	})
	if err != nil {
		return "", err
	}
	a.jwt, a.jwtAt = t, now
	return t, nil
}

// forget drops a provider token Apple refused, so the next push makes one.
func (a *APNsSender) forget() {
	a.mu.Lock()
	a.jwt = ""
	a.mu.Unlock()
}

func fixed(n *big.Int, size int) []byte {
	b := make([]byte, size)
	n.FillBytes(b)
	return b
}

// signJWT returns a compact JWT signed by sign over the SHA-256 of its
// signing input.
func signJWT(header map[string]string, claims map[string]any, sign func(digest []byte) ([]byte, error)) (string, error) {
	h, _ := json.Marshal(header)
	c, _ := json.Marshal(claims)
	in := base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(c)
	d := sha256.Sum256([]byte(in))
	sig, err := sign(d[:])
	if err != nil {
		return "", err
	}
	return in + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

// Send pushes to t: nil when Apple took it, errGone when the token is no
// longer valid (410, or 400 BadDeviceToken), another error otherwise.
func (a *APNsSender) Send(ctx context.Context, t Target) error {
	base := a.Production
	if base == "" {
		base = APNsProduction
	}
	if t.Environment == Development {
		base = a.Development
		if base == "" {
			base = APNsDevelopment
		}
	}
	jwt, err := a.token()
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/3/device/"+t.Token, bytes.NewReader(apnsPayload))
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "bearer "+jwt)
	req.Header.Set("apns-push-type", "alert")
	req.Header.Set("apns-priority", "10")
	req.Header.Set("apns-topic", t.App)
	req.Header.Set("apns-expiration", strconv.FormatInt(a.now().Add(24*time.Hour).Unix(), 10))
	req.Header.Set("content-type", "application/json")
	resp, err := a.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var body struct{ Reason string }
	_ = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&body)
	switch {
	case resp.StatusCode == http.StatusOK:
		return nil
	case resp.StatusCode == http.StatusGone, resp.StatusCode == http.StatusBadRequest && body.Reason == "BadDeviceToken":
		return errGone
	case resp.StatusCode == http.StatusForbidden && (body.Reason == "ExpiredProviderToken" || body.Reason == "InvalidProviderToken"):
		a.forget()
	}
	return fmt.Errorf("APNs answered %d %s", resp.StatusCode, body.Reason)
}
