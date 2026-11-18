package hosted

// The App Store's subscription. The phone sends StoreKit's signed
// transaction (its jwsRepresentation), which the relay checks is Apple's:
// an ES256 JWS whose x5c chains to Apple Root CA - G3 through Apple's
// intermediate (OID 1.2.840.113635.100.6.2.1) to a leaf with OID
// 1.2.840.113635.100.6.11.1, for this app's product. What it says may be
// old, so the subscription's state comes from the App Store Server API,
// asked by its original transaction ID with the In-App Purchase key; a
// sandbox transaction is asked of the sandbox and taken only by a sandbox
// relay.

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	_ "embed"
	"encoding/asn1"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

//go:embed roots/AppleRootCA-G3.pem
var appleRootG3PEM []byte

var appleRoots = rootPool(appleRootG3PEM)

var (
	oidAppleIntermediate = asn1.ObjectIdentifier{1, 2, 840, 113635, 100, 6, 2, 1}
	oidAppleStoreLeaf    = asn1.ObjectIdentifier{1, 2, 840, 113635, 100, 6, 11, 1}
)

// Variables so that tests can point them elsewhere.
var (
	appStoreAPI        = "https://api.storekit.itunes.apple.com"
	appStoreSandboxAPI = "https://api.storekit-sandbox.itunes.apple.com"
)

// appleTransaction is what the relay reads of a JWSTransactionDecodedPayload.
type appleTransaction struct {
	BundleID              string `json:"bundleId"`
	ProductID             string `json:"productId"`
	OriginalTransactionID string `json:"originalTransactionId"`
	ExpiresDate           int64  `json:"expiresDate"`
	RevocationDate        int64  `json:"revocationDate"`
	OfferDiscountType     string `json:"offerDiscountType"`
	OfferType             int    `json:"offerType"`
	Environment           string `json:"environment"`
}

// verifyAppleJWS checks a JWS signed by the App Store and decodes its
// payload into out.
func verifyAppleJWS(jws string, now time.Time, out any) error {
	parts := strings.Split(jws, ".")
	if len(parts) != 3 {
		return errors.New("not a JWS")
	}
	hb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return err
	}
	var head struct {
		Alg string   `json:"alg"`
		X5c []string `json:"x5c"`
	}
	if err := json.Unmarshal(hb, &head); err != nil {
		return err
	}
	if head.Alg != "ES256" || len(head.X5c) < 2 {
		return errors.New("not an ES256 JWS with its certificates")
	}
	certs := make([]*x509.Certificate, len(head.X5c))
	for i, c := range head.X5c {
		der, err := base64.StdEncoding.DecodeString(c)
		if err != nil {
			return err
		}
		if certs[i], err = x509.ParseCertificate(der); err != nil {
			return fmt.Errorf("certificate %d: %w", i, err)
		}
	}
	if !hasExtension(certs[0], oidAppleStoreLeaf) || !hasExtension(certs[1], oidAppleIntermediate) {
		return errors.New("not signed by the App Store")
	}
	inter := x509.NewCertPool()
	inter.AddCert(certs[1])
	if _, err := certs[0].Verify(x509.VerifyOptions{Roots: appleRoots, Intermediates: inter, CurrentTime: now, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny}}); err != nil {
		return fmt.Errorf("the signing certificate: %w", err)
	}
	pub, ok := certs[0].PublicKey.(*ecdsa.PublicKey)
	if !ok {
		return errors.New("the signing key is not ECDSA")
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(sig) != 64 {
		return errors.New("a malformed signature")
	}
	h := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.Verify(pub, h[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		return errors.New("a bad signature")
	}
	pb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return err
	}
	return json.Unmarshal(pb, out)
}

func hasExtension(c *x509.Certificate, oid asn1.ObjectIdentifier) bool {
	for _, e := range c.Extensions {
		if e.Id.Equal(oid) {
			return true
		}
	}
	return false
}

// appStoreSubscription checks the phone's signed transaction, then asks
// the App Store how the subscription stands.
func (s *Stores) appStoreSubscription(ctx context.Context, jws string) (Subscription, error) {
	if s.cfg.AppleBundleID == "" {
		return Subscription{}, errors.New("this relay takes no App Store subscriptions")
	}
	var t appleTransaction
	if err := verifyAppleJWS(jws, s.cfg.Now(), &t); err != nil {
		return Subscription{}, fmt.Errorf("the signed transaction: %w", err)
	}
	if t.BundleID != s.cfg.AppleBundleID || t.ProductID != s.cfg.Product || t.OriginalTransactionID == "" {
		return Subscription{}, errors.New("a transaction for another app or product")
	}
	sandbox := t.Environment != "Production"
	if sandbox && !s.cfg.Sandbox {
		return Subscription{}, errors.New("a sandbox purchase, which this relay does not take")
	}
	return s.appStoreStatus(ctx, t.OriginalTransactionID, sandbox)
}

// appStoreStatus asks the App Store Server API for the subscription's
// state (Get All Subscription Statuses) and takes the newest transaction
// of this product.
func (s *Stores) appStoreStatus(ctx context.Context, original string, sandbox bool) (Subscription, error) {
	if s.apple == nil {
		return Subscription{}, errors.New("no In-App Purchase key to ask the App Store with")
	}
	base := appStoreAPI
	if sandbox {
		base = appStoreSandboxAPI
	}
	tok, err := s.apple.token()
	if err != nil {
		return Subscription{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/inApps/v1/subscriptions/"+url.PathEscape(original), nil)
	if err != nil {
		return Subscription{}, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	var res struct {
		Environment string `json:"environment"`
		Data        []struct {
			LastTransactions []struct {
				Status                int    `json:"status"`
				OriginalTransactionID string `json:"originalTransactionId"`
				SignedTransactionInfo string `json:"signedTransactionInfo"`
				SignedRenewalInfo     string `json:"signedRenewalInfo"`
			} `json:"lastTransactions"`
		} `json:"data"`
	}
	if err := getJSON(s.cfg.HTTP, req, &res); err != nil {
		return Subscription{}, fmt.Errorf("the App Store Server API: %w", err)
	}
	for _, g := range res.Data {
		for _, l := range g.LastTransactions {
			if l.OriginalTransactionID != original {
				continue
			}
			var t appleTransaction
			if err := verifyAppleJWS(l.SignedTransactionInfo, s.cfg.Now(), &t); err != nil {
				return Subscription{}, fmt.Errorf("the App Store's transaction: %w", err)
			}
			if t.BundleID != s.cfg.AppleBundleID || t.ProductID != s.cfg.Product {
				continue
			}
			var renewal struct {
				GracePeriodExpiresDate int64 `json:"gracePeriodExpiresDate"`
			}
			if l.SignedRenewalInfo != "" {
				if err := verifyAppleJWS(l.SignedRenewalInfo, s.cfg.Now(), &renewal); err != nil {
					return Subscription{}, fmt.Errorf("the App Store's renewal info: %w", err)
				}
			}
			sub := Subscription{
				Kind:    "app-store",
				Ident:   []byte(original),
				Expires: time.UnixMilli(t.ExpiresDate),
				// offerType 1 is an introductory offer, which for this
				// product is the free trial.
				Trial:   t.OfferType == 1,
				Sandbox: t.Environment != "Production",
			}
			// 1 active, 2 expired, 3 billing retry, 4 grace, 5 revoked.
			switch l.Status {
			case 1:
				return sub, nil
			case 4:
				sub.Grace = true
				if renewal.GracePeriodExpiresDate > 0 {
					sub.Expires = time.UnixMilli(renewal.GracePeriodExpiresDate)
				}
				return sub, nil
			case 2:
				return sub, errors.New("the subscription has expired")
			case 3:
				return sub, errors.New("the subscription's payment has failed")
			case 5:
				return sub, errors.New("the subscription was refunded or revoked")
			}
			return sub, fmt.Errorf("the subscription's status is %d", l.Status)
		}
	}
	return Subscription{}, errors.New("the App Store has no such subscription")
}

// appleSigner makes the App Store Server API's bearer tokens, ES256 JWTs
// of the In-App Purchase key, each kept for most of its hour.
type appleSigner struct {
	keyID, issuer, bundle string
	key                   *ecdsa.PrivateKey
	now                   func() time.Time

	mu      sync.Mutex
	tok     string
	expires time.Time
}

func newAppleSigner(keyID, issuer, bundle string, keyPEM []byte, now func() time.Time) (*appleSigner, error) {
	if keyID == "" || issuer == "" || bundle == "" {
		return nil, errors.New("the key ID, issuer ID and bundle ID are all needed")
	}
	b, _ := pem.Decode(keyPEM)
	if b == nil {
		return nil, errors.New("not PEM")
	}
	k, err := x509.ParsePKCS8PrivateKey(b.Bytes)
	if err != nil {
		return nil, err
	}
	ek, ok := k.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("not an ECDSA key")
	}
	return &appleSigner{keyID: keyID, issuer: issuer, bundle: bundle, key: ek, now: now}, nil
}

func (a *appleSigner) token() (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	if a.tok != "" && now.Before(a.expires) {
		return a.tok, nil
	}
	head, _ := json.Marshal(map[string]string{"alg": "ES256", "kid": a.keyID, "typ": "JWT"})
	claims, _ := json.Marshal(map[string]any{"iss": a.issuer, "iat": now.Unix(), "exp": now.Add(time.Hour).Unix(), "aud": "appstoreconnect-v1", "bid": a.bundle})
	in := base64.RawURLEncoding.EncodeToString(head) + "." + base64.RawURLEncoding.EncodeToString(claims)
	h := sha256.Sum256([]byte(in))
	r, s, err := ecdsa.Sign(rand.Reader, a.key, h[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	a.tok, a.expires = in+"."+base64.RawURLEncoding.EncodeToString(sig), now.Add(50*time.Minute)
	return a.tok, nil
}

// getJSON sends req and decodes a 200's JSON body into out; anything else
// is an error with the start of the body.
func getJSON(c *http.Client, req *http.Request, out any) error {
	res, err := c.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusOK {
		if len(body) > 300 {
			body = body[:300]
		}
		return fmt.Errorf("%s: %s", res.Status, body)
	}
	return json.Unmarshal(body, out)
}
