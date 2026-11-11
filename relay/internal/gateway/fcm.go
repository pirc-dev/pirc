package gateway

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Google's endpoints, and the scope a send needs.
const (
	FCMSend    = "https://fcm.googleapis.com"
	fcmScope   = "https://www.googleapis.com/auth/firebase.messaging"
	googleAuth = "https://oauth2.googleapis.com/token"
)

// FCMSender sends through Firebase Cloud Messaging's HTTP v1 API, as the
// Firebase project's service account.
type FCMSender struct {
	ProjectID, Email string
	Key              *rsa.PrivateKey
	// Where access tokens come from, as the credentials say.
	TokenURL string
	Client   *http.Client
	// Where sends go; Google's when empty.
	SendURL string
	Now     func() time.Time

	mu          sync.Mutex
	access      string
	accessUntil time.Time
}

// ParseServiceAccount reads a Firebase service account's JSON key file.
func ParseServiceAccount(b []byte) (*FCMSender, error) {
	var f struct {
		Type        string `json:"type"`
		ProjectID   string `json:"project_id"`
		ClientEmail string `json:"client_email"`
		PrivateKey  string `json:"private_key"`
		TokenURI    string `json:"token_uri"`
	}
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("the FCM credentials: %w", err)
	}
	if f.Type != "service_account" || f.ProjectID == "" || f.ClientEmail == "" {
		return nil, errors.New("the FCM credentials are not a service account's key")
	}
	blk, _ := pem.Decode([]byte(f.PrivateKey))
	if blk == nil {
		return nil, errors.New("the FCM credentials' private key is not PEM")
	}
	k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil {
		return nil, fmt.Errorf("the FCM credentials' private key: %w", err)
	}
	rk, ok := k.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("the FCM credentials' private key is not RSA")
	}
	if f.TokenURI == "" {
		f.TokenURI = googleAuth
	}
	return &FCMSender{ProjectID: f.ProjectID, Email: f.ClientEmail, Key: rk, TokenURL: f.TokenURI}, nil
}

func (f *FCMSender) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}

// token returns an access token, asking Google for one when the last is
// within five minutes of lapsing.
func (f *FCMSender) token(ctx context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := f.now()
	if f.access != "" && now.Before(f.accessUntil.Add(-5*time.Minute)) {
		return f.access, nil
	}
	assertion, err := signJWT(map[string]string{"alg": "RS256", "typ": "JWT"}, map[string]any{
		"iss": f.Email, "scope": fcmScope, "aud": f.TokenURL, "iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
	}, func(digest []byte) ([]byte, error) {
		return rsa.SignPKCS1v15(rand.Reader, f.Key, crypto.SHA256, digest)
	})
	if err != nil {
		return "", err
	}
	form := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"}, "assertion": {assertion}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("content-type", "application/x-www-form-urlencoded")
	resp, err := f.Client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var t struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&t); err != nil || resp.StatusCode != http.StatusOK || t.AccessToken == "" {
		return "", fmt.Errorf("Google's token endpoint answered %d", resp.StatusCode)
	}
	f.access, f.accessUntil = t.AccessToken, now.Add(time.Duration(t.ExpiresIn)*time.Second)
	return f.access, nil
}

// fcmError is the body of a refused send.
type fcmError struct {
	Error struct {
		Code    int
		Status  string
		Details []struct {
			Type            string `json:"@type"`
			ErrorCode       string `json:"errorCode"`
			FieldViolations []struct {
				Field string `json:"field"`
			} `json:"fieldViolations"`
		}
	}
}

// gone says whether the refusal is of the token itself: UNREGISTERED, or
// INVALID_ARGUMENT that names the token. INVALID_ARGUMENT about anything
// else is a fault in the message, which every token would meet.
func (e fcmError) gone() bool {
	invalid := e.Error.Status == "INVALID_ARGUMENT"
	aboutToken := false
	for _, d := range e.Error.Details {
		if d.ErrorCode == "UNREGISTERED" {
			return true
		}
		if d.ErrorCode == "INVALID_ARGUMENT" {
			invalid = true
		}
		for _, v := range d.FieldViolations {
			aboutToken = aboutToken || v.Field == "message.token"
		}
	}
	return invalid && aboutToken
}

// Send pushes a data message that wakes the app: nil when Google took it,
// errGone when the token is no longer valid, another error otherwise.
func (f *FCMSender) Send(ctx context.Context, t Target) error {
	access, err := f.token(ctx)
	if err != nil {
		return err
	}
	msg := map[string]any{"message": map[string]any{
		"token":   t.Token,
		"data":    map[string]string{"wake": "1"},
		"android": map[string]any{"priority": "HIGH", "ttl": "86400s"},
	}}
	body, _ := json.Marshal(msg)
	base := f.SendURL
	if base == "" {
		base = FCMSend
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/projects/"+url.PathEscape(f.ProjectID)+"/messages:send", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "Bearer "+access)
	req.Header.Set("content-type", "application/json")
	resp, err := f.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil
	}
	var e fcmError
	_ = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&e)
	if e.gone() {
		return errGone
	}
	if resp.StatusCode == http.StatusUnauthorized {
		f.mu.Lock()
		f.access = ""
		f.mu.Unlock()
	}
	return fmt.Errorf("FCM answered %d %s", resp.StatusCode, e.Error.Status)
}
