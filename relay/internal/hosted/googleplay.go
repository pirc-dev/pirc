package hosted

// Google Play. Play Integrity's classic request: the phone asks for a
// token with nonce base64url(SHA-256(what the attestation binds)), and the
// relay has Google decode it (decodeIntegrityToken), then requires this
// package, that nonce, a token at most ten minutes old, an app Play
// recognises and a device that meets device integrity. The subscription is
// the purchase token, asked of the Play Developer API
// (purchases.subscriptionsv2). Both with a service account's OAuth token.

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
)

// Variables so that tests can point them elsewhere.
var (
	playIntegrityAPI = "https://playintegrity.googleapis.com/v1/"
	playPublisherAPI = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/"
)

const (
	googleScopes    = "https://www.googleapis.com/auth/playintegrity https://www.googleapis.com/auth/androidpublisher"
	playTokenMaxAge = 10 * time.Minute
)

// PlayNonce is the nonce a phone gives Play Integrity for data.
func PlayNonce(data []byte) string {
	h := sha256.Sum256(data)
	return base64.RawURLEncoding.EncodeToString(h[:])
}

func (s *Stores) verifyPlayIntegrity(ctx context.Context, token string, data []byte) (Attested, error) {
	body, _ := json.Marshal(map[string]string{"integrityToken": token})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, playIntegrityAPI+url.PathEscape(s.cfg.AndroidPackage)+":decodeIntegrityToken", bytes.NewReader(body))
	if err != nil {
		return Attested{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if err := s.google.authorize(ctx, req); err != nil {
		return Attested{}, err
	}
	var res struct {
		TokenPayloadExternal struct {
			RequestDetails struct {
				RequestPackageName string `json:"requestPackageName"`
				Nonce              string `json:"nonce"`
				TimestampMillis    string `json:"timestampMillis"`
			} `json:"requestDetails"`
			AppIntegrity struct {
				AppRecognitionVerdict string `json:"appRecognitionVerdict"`
				PackageName           string `json:"packageName"`
			} `json:"appIntegrity"`
			DeviceIntegrity struct {
				DeviceRecognitionVerdict []string `json:"deviceRecognitionVerdict"`
			} `json:"deviceIntegrity"`
		} `json:"tokenPayloadExternal"`
	}
	if err := getJSON(s.cfg.HTTP, req, &res); err != nil {
		return Attested{}, fmt.Errorf("decoding the integrity token: %w", err)
	}
	p := res.TokenPayloadExternal
	if p.RequestDetails.RequestPackageName != s.cfg.AndroidPackage {
		return Attested{}, errors.New("the integrity token is for another app")
	}
	// Play gives back the nonce as the phone sent it, padded or not.
	if strings.TrimRight(p.RequestDetails.Nonce, "=") != PlayNonce(data) {
		return Attested{}, errors.New("the integrity token is for another login or key")
	}
	var ms int64
	if _, err := fmt.Sscan(p.RequestDetails.TimestampMillis, &ms); err != nil {
		return Attested{}, errors.New("the integrity token has no time")
	}
	if age := s.cfg.Now().Sub(time.UnixMilli(ms)); age > playTokenMaxAge || age < -playTokenMaxAge {
		return Attested{}, fmt.Errorf("the integrity token is %s old", age.Round(time.Second))
	}
	if p.AppIntegrity.AppRecognitionVerdict != "PLAY_RECOGNIZED" || p.AppIntegrity.PackageName != s.cfg.AndroidPackage {
		return Attested{}, fmt.Errorf("Play does not recognise this app (%s)", p.AppIntegrity.AppRecognitionVerdict)
	}
	if !slices.Contains(p.DeviceIntegrity.DeviceRecognitionVerdict, "MEETS_DEVICE_INTEGRITY") {
		return Attested{}, fmt.Errorf("the device does not meet Play's device integrity (%v)", p.DeviceIntegrity.DeviceRecognitionVerdict)
	}
	// A Play Integrity verdict names nothing that lasts: nothing to keep.
	return Attested{Kind: "play-integrity", Ident: []byte{0}}, nil
}

// playSubscription asks the Play Developer API how the subscription of a
// purchase token stands.
func (s *Stores) playSubscription(ctx context.Context, purchaseToken string) (Subscription, error) {
	if s.google == nil || s.cfg.AndroidPackage == "" {
		return Subscription{}, errors.New("this relay takes no Google Play subscriptions")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, playPublisherAPI+url.PathEscape(s.cfg.AndroidPackage)+"/purchases/subscriptionsv2/tokens/"+url.PathEscape(purchaseToken), nil)
	if err != nil {
		return Subscription{}, err
	}
	if err := s.google.authorize(ctx, req); err != nil {
		return Subscription{}, err
	}
	var res struct {
		SubscriptionState string           `json:"subscriptionState"`
		TestPurchase      *json.RawMessage `json:"testPurchase"`
		LineItems         []struct {
			ProductID    string `json:"productId"`
			ExpiryTime   string `json:"expiryTime"`
			OfferDetails struct {
				OfferID string `json:"offerId"`
			} `json:"offerDetails"`
		} `json:"lineItems"`
	}
	if err := getJSON(s.cfg.HTTP, req, &res); err != nil {
		return Subscription{}, fmt.Errorf("the Play Developer API: %w", err)
	}
	sub := Subscription{Kind: "google-play", Ident: []byte(purchaseToken), Sandbox: res.TestPurchase != nil}
	found := false
	for _, li := range res.LineItems {
		if li.ProductID != s.cfg.Product {
			continue
		}
		found = true
		if t, err := time.Parse(time.RFC3339Nano, li.ExpiryTime); err == nil && t.After(sub.Expires) {
			sub.Expires = t
			// The base plan's own price has no offer; the free trial is one.
			sub.Trial = li.OfferDetails.OfferID != ""
		}
	}
	if !found {
		return Subscription{}, errors.New("a purchase of another product")
	}
	if sub.Sandbox && !s.cfg.Sandbox {
		return sub, errors.New("a test purchase, which this relay does not take")
	}
	switch res.SubscriptionState {
	case "SUBSCRIPTION_STATE_ACTIVE":
		return sub, nil
	case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD":
		sub.Grace = true
		return sub, nil
	case "SUBSCRIPTION_STATE_CANCELED":
		// Cancelled is not ended: it runs to the end of what was paid.
		if sub.Expires.After(s.cfg.Now()) {
			return sub, nil
		}
	}
	return sub, fmt.Errorf("the subscription is not live (%s)", res.SubscriptionState)
}

// googleToken is a service account's OAuth access token (RFC 7523's JWT
// bearer grant), kept until a minute before it expires.
type googleToken struct {
	email, tokenURI string
	key             *rsa.PrivateKey
	http            *http.Client
	now             func() time.Time

	mu      sync.Mutex
	tok     string
	expires time.Time
}

func newGoogleToken(credentials []byte, c *http.Client, now func() time.Time) (*googleToken, error) {
	var sa struct {
		ClientEmail string `json:"client_email"`
		PrivateKey  string `json:"private_key"`
		TokenURI    string `json:"token_uri"`
	}
	if err := json.Unmarshal(credentials, &sa); err != nil {
		return nil, err
	}
	b, _ := pem.Decode([]byte(sa.PrivateKey))
	if b == nil || sa.ClientEmail == "" || sa.TokenURI == "" {
		return nil, errors.New("not a service account's key")
	}
	k, err := x509.ParsePKCS8PrivateKey(b.Bytes)
	if err != nil {
		return nil, err
	}
	rk, ok := k.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("not an RSA key")
	}
	return &googleToken{email: sa.ClientEmail, tokenURI: sa.TokenURI, key: rk, http: c, now: now}, nil
}

func (g *googleToken) authorize(ctx context.Context, req *http.Request) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	if g.tok == "" || !now.Before(g.expires) {
		head, _ := json.Marshal(map[string]string{"alg": "RS256", "typ": "JWT"})
		claims, _ := json.Marshal(map[string]any{"iss": g.email, "scope": googleScopes, "aud": g.tokenURI, "iat": now.Unix(), "exp": now.Add(time.Hour).Unix()})
		in := base64.RawURLEncoding.EncodeToString(head) + "." + base64.RawURLEncoding.EncodeToString(claims)
		h := sha256.Sum256([]byte(in))
		sig, err := rsa.SignPKCS1v15(rand.Reader, g.key, crypto.SHA256, h[:])
		if err != nil {
			return err
		}
		form := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"}, "assertion": {in + "." + base64.RawURLEncoding.EncodeToString(sig)}}
		treq, err := http.NewRequestWithContext(ctx, http.MethodPost, g.tokenURI, strings.NewReader(form.Encode()))
		if err != nil {
			return err
		}
		treq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		var res struct {
			AccessToken string `json:"access_token"`
			ExpiresIn   int    `json:"expires_in"`
		}
		if err := getJSON(g.http, treq, &res); err != nil {
			return fmt.Errorf("Google's OAuth token: %w", err)
		}
		g.tok, g.expires = res.AccessToken, now.Add(time.Duration(res.ExpiresIn)*time.Second-time.Minute)
	}
	req.Header.Set("Authorization", "Bearer "+g.tok)
	return nil
}
