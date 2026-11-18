package hosted

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

var storesNow = time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)

type testCert struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
}

// issue makes a certificate for key (a new one if nil), signed by parent
// (self-signed if nil), with the given extensions.
func issue(t *testing.T, parent *testCert, key *ecdsa.PrivateKey, ca bool, exts ...pkix.Extension) *testCert {
	t.Helper()
	if key == nil {
		var err error
		if key, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader); err != nil {
			t.Fatal(err)
		}
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: fmt.Sprintf("test %d", time.Now().UnixNano())},
		NotBefore:             storesNow.Add(-time.Hour),
		NotAfter:              storesNow.Add(time.Hour),
		IsCA:                  ca,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtraExtensions:       exts,
	}
	signer, signKey := tmpl, key
	if parent != nil {
		signer, signKey = parent.cert, parent.key
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, signer, &key.PublicKey, signKey)
	if err != nil {
		t.Fatal(err)
	}
	c, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return &testCert{c, key}
}

func pool(c *testCert) *x509.CertPool {
	p := x509.NewCertPool()
	p.AddCert(c.cert)
	return p
}

// cborEncode writes the subset cborDecode reads.
func cborEncode(v any) []byte {
	head := func(major byte, n int) []byte {
		switch {
		case n < 24:
			return []byte{major<<5 | byte(n)}
		case n < 256:
			return []byte{major<<5 | 24, byte(n)}
		default:
			return binary.BigEndian.AppendUint16([]byte{major<<5 | 25}, uint16(n))
		}
	}
	switch x := v.(type) {
	case []byte:
		return append(head(2, len(x)), x...)
	case string:
		return append(head(3, len(x)), x...)
	case []any:
		out := head(4, len(x))
		for _, e := range x {
			out = append(out, cborEncode(e)...)
		}
		return out
	case map[string]any:
		out := head(5, len(x))
		for _, k := range []string{"fmt", "attStmt", "authData", "x5c", "receipt"} {
			if e, ok := x[k]; ok {
				out = append(append(out, cborEncode(k)...), cborEncode(e)...)
			}
		}
		return out
	}
	panic(fmt.Sprintf("cborEncode: %T", v))
}

type attestCase struct {
	appID  string
	aaguid []byte
	data   []byte
	keyID  []byte
}

func makeAttestation(t *testing.T, root *testCert, c attestCase) *pb.AppAttest {
	t.Helper()
	inter := issue(t, root, nil, true)
	cred, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	ek, _ := cred.PublicKey.ECDH()
	keyID := sha256.Sum256(ek.Bytes())
	rp := sha256.Sum256([]byte(c.appID))
	authData := append(rp[:], 0x40, 0, 0, 0, 0)
	authData = append(authData, c.aaguid...)
	authData = binary.BigEndian.AppendUint16(authData, 32)
	authData = append(authData, keyID[:]...)
	cdh := sha256.Sum256(c.data)
	nonce := sha256.Sum256(append(append([]byte{}, authData...), cdh[:]...))
	ext, _ := asn1.Marshal(struct {
		Nonce []byte `asn1:"tag:1,explicit"`
	}{nonce[:]})
	leaf := issue(t, inter, cred, false, pkix.Extension{Id: oidAppAttestNonce, Value: ext})
	att := cborEncode(map[string]any{
		"fmt":      "apple-appattest",
		"attStmt":  map[string]any{"x5c": []any{leaf.cert.Raw, inter.cert.Raw}, "receipt": []byte("r")},
		"authData": authData,
	})
	id := keyID[:]
	if c.keyID != nil {
		id = c.keyID
	}
	return &pb.AppAttest{KeyId: id, Attestation: att}
}

func TestAppAttest(t *testing.T) {
	root := issue(t, nil, nil, true)
	defer func(p *x509.CertPool) { appAttestRoots = p }(appAttestRoots)
	appAttestRoots = pool(root)
	const app = "4PC6T9727Y.dev.pirc.app"
	data := []byte("login data")

	good := makeAttestation(t, root, attestCase{appID: app, aaguid: aaguidProduction, data: data})
	got, err := verifyAppAttest(good, data, app, false, storesNow)
	if err != nil {
		t.Fatalf("a good attestation: %v", err)
	}
	if got.Kind != "app-attest" || string(got.Ident) != string(good.KeyId) {
		t.Fatalf("attested %+v", got)
	}

	dev := makeAttestation(t, root, attestCase{appID: app, aaguid: aaguidDevelopment, data: data})
	for _, tc := range []struct {
		name    string
		a       *pb.AppAttest
		data    []byte
		sandbox bool
		now     time.Time
		want    string
	}{
		{"another login", good, []byte("other"), false, storesNow, "another login"},
		{"development, not sandbox", dev, data, false, storesNow, "development"},
		{"another app", makeAttestation(t, root, attestCase{appID: "X.other", aaguid: aaguidProduction, data: data}), data, false, storesNow, "another app"},
		{"another key ID", makeAttestation(t, root, attestCase{appID: app, aaguid: aaguidProduction, data: data, keyID: make([]byte, 32)}), data, false, storesNow, "key ID"},
		{"expired", good, data, false, storesNow.Add(2 * time.Hour), "certificate"},
		{"another root", makeAttestation(t, issue(t, nil, nil, true), attestCase{appID: app, aaguid: aaguidProduction, data: data}), data, false, storesNow, "certificate"},
	} {
		if _, err := verifyAppAttest(tc.a, tc.data, app, tc.sandbox, tc.now); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: got %v, want an error with %q", tc.name, err, tc.want)
		}
	}
	if _, err := verifyAppAttest(dev, data, app, true, storesNow); err != nil {
		t.Errorf("development on a sandbox relay: %v", err)
	}
	if _, err := verifyAppAttest(&pb.AppAttest{Attestation: []byte{0xff}}, data, app, false, storesNow); err == nil {
		t.Error("malformed CBOR taken")
	}
}

// appleChain is a stand-in for Apple's: a root, an intermediate and a
// leaf with Apple's OIDs, signing JWSs.
type appleChain struct{ root, inter, leaf *testCert }

func newAppleChain(t *testing.T) appleChain {
	root := issue(t, nil, nil, true)
	inter := issue(t, root, nil, true, pkix.Extension{Id: oidAppleIntermediate, Value: []byte{5, 0}})
	leaf := issue(t, inter, nil, false, pkix.Extension{Id: oidAppleStoreLeaf, Value: []byte{5, 0}})
	return appleChain{root, inter, leaf}
}

func (c appleChain) sign(t *testing.T, payload any) string {
	t.Helper()
	head, _ := json.Marshal(map[string]any{"alg": "ES256", "x5c": []string{
		base64.StdEncoding.EncodeToString(c.leaf.cert.Raw), base64.StdEncoding.EncodeToString(c.inter.cert.Raw), base64.StdEncoding.EncodeToString(c.root.cert.Raw),
	}})
	body, _ := json.Marshal(payload)
	in := base64.RawURLEncoding.EncodeToString(head) + "." + base64.RawURLEncoding.EncodeToString(body)
	h := sha256.Sum256([]byte(in))
	r, s, err := ecdsa.Sign(rand.Reader, c.leaf.key, h[:])
	if err != nil {
		t.Fatal(err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return in + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func iapKey(t *testing.T) []byte {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, err := x509.MarshalPKCS8PrivateKey(k)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
}

func TestAppStoreSubscription(t *testing.T) {
	chain := newAppleChain(t)
	defer func(p *x509.CertPool, a, b string) { appleRoots, appStoreAPI, appStoreSandboxAPI = p, a, b }(appleRoots, appStoreAPI, appStoreSandboxAPI)
	appleRoots = pool(chain.root)

	tx := func(env string, expires time.Time) map[string]any {
		return map[string]any{"bundleId": "dev.pirc.app", "productId": "dev.pirc.app.yearly", "originalTransactionId": "1000", "expiresDate": expires.UnixMilli(), "offerType": 1, "environment": env}
	}
	status := 1
	var asked []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.Host+r.URL.Path)
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			http.Error(w, "no token", http.StatusUnauthorized)
			return
		}
		env := "Production"
		if strings.HasPrefix(r.URL.Path, "/sandbox") {
			env = "Sandbox"
		}
		json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"lastTransactions": []any{map[string]any{
			"status": status, "originalTransactionId": "1000", "signedTransactionInfo": chain.sign(t, tx(env, storesNow.Add(72*time.Hour))),
		}}}}})
	}))
	defer srv.Close()
	appStoreAPI, appStoreSandboxAPI = srv.URL, srv.URL+"/sandbox"

	newStores := func(sandbox bool) *Stores {
		s, err := NewStores(StoresConfig{AppleAppID: "4PC6T9727Y.dev.pirc.app", AppleBundleID: "dev.pirc.app", AppleKeyID: "K", AppleIssuerID: "I", AppleKey: iapKey(t), Product: "dev.pirc.app.yearly", Sandbox: sandbox, Now: func() time.Time { return storesNow }})
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	att := func(jws string) *pb.Attestation {
		return &pb.Attestation{Kind: &pb.Attestation_AppAttest{AppAttest: &pb.AppAttest{}}, Subscription: jws}
	}
	ctx := context.Background()

	sub, err := newStores(false).Subscribed(ctx, nil, att(chain.sign(t, tx("Production", storesNow.Add(time.Hour)))))
	if err != nil {
		t.Fatalf("a live subscription: %v", err)
	}
	if sub.Kind != "app-store" || string(sub.Ident) != "1000" || !sub.Expires.Equal(storesNow.Add(72*time.Hour).Truncate(time.Millisecond)) || !sub.Trial || sub.Sandbox {
		t.Fatalf("subscription %+v", sub)
	}
	if _, err := newStores(false).Subscribed(ctx, nil, att(chain.sign(t, tx("Sandbox", storesNow)))); err == nil || !strings.Contains(err.Error(), "sandbox") {
		t.Errorf("a sandbox purchase on a production relay: %v", err)
	}
	if sub, err := newStores(true).Subscribed(ctx, nil, att(chain.sign(t, tx("Sandbox", storesNow)))); err != nil || !sub.Sandbox || !strings.HasSuffix(asked[len(asked)-1], "/sandbox/inApps/v1/subscriptions/1000") {
		t.Errorf("a sandbox purchase on a sandbox relay: %+v %v %v", sub, err, asked)
	}
	other := tx("Production", storesNow)
	other["bundleId"] = "dev.other"
	if _, err := newStores(false).Subscribed(ctx, nil, att(chain.sign(t, other))); err == nil {
		t.Error("another app's transaction taken")
	}
	forged := newAppleChain(t).sign(t, tx("Production", storesNow))
	if _, err := newStores(false).Subscribed(ctx, nil, att(forged)); err == nil {
		t.Error("a transaction under another root taken")
	}
	for st, want := range map[int]string{2: "expired", 3: "payment", 5: "revoked"} {
		status = st
		if _, err := newStores(false).Subscribed(ctx, nil, att(chain.sign(t, tx("Production", storesNow)))); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("status %d: %v", st, err)
		}
	}
	status = 4
	if sub, err := newStores(false).Recheck(ctx, Subscription{Kind: "app-store", Ident: []byte("1000")}); err != nil || !sub.Grace {
		t.Errorf("grace: %+v %v", sub, err)
	}
}

func TestGooglePlay(t *testing.T) {
	rk, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.MarshalPKCS8PrivateKey(rk)
	data := []byte("login data")
	verdict := map[string]any{
		"requestDetails":  map[string]any{"requestPackageName": "dev.pirc.app", "nonce": PlayNonce(data) + "==", "timestampMillis": fmt.Sprint(storesNow.Add(-time.Minute).UnixMilli())},
		"appIntegrity":    map[string]any{"appRecognitionVerdict": "PLAY_RECOGNIZED", "packageName": "dev.pirc.app"},
		"deviceIntegrity": map[string]any{"deviceRecognitionVerdict": []string{"MEETS_DEVICE_INTEGRITY"}},
	}
	purchase := map[string]any{"subscriptionState": "SUBSCRIPTION_STATE_ACTIVE", "testPurchase": map[string]any{}, "lineItems": []any{map[string]any{"productId": "dev.pirc.app.yearly", "expiryTime": storesNow.Add(time.Hour).Format(time.RFC3339Nano), "offerDetails": map[string]any{"offerId": "trial"}}}}
	tokens := 0
	mux := http.NewServeMux()
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		parts := strings.Split(r.Form.Get("assertion"), ".")
		if r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" || len(parts) != 3 {
			http.Error(w, "bad grant", http.StatusBadRequest)
			return
		}
		tokens++
		json.NewEncoder(w).Encode(map[string]any{"access_token": "tok", "expires_in": 3600})
	})
	mux.HandleFunc("POST /v1/{pkg}", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" || r.PathValue("pkg") != "dev.pirc.app:decodeIntegrityToken" {
			http.Error(w, "no", http.StatusForbidden)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"tokenPayloadExternal": verdict})
	})
	mux.HandleFunc("GET /apps/dev.pirc.app/purchases/subscriptionsv2/tokens/{tok}", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(purchase)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	defer func(a, b string) { playIntegrityAPI, playPublisherAPI = a, b }(playIntegrityAPI, playPublisherAPI)
	playIntegrityAPI, playPublisherAPI = srv.URL+"/v1/", srv.URL+"/apps/"
	creds, _ := json.Marshal(map[string]string{"client_email": "sa@example.iam", "token_uri": srv.URL + "/token", "private_key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))})
	newStores := func(sandbox bool) *Stores {
		s, err := NewStores(StoresConfig{AndroidPackage: "dev.pirc.app", GoogleCredentials: creds, Product: "dev.pirc.app.yearly", Sandbox: sandbox, Now: func() time.Time { return storesNow }})
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	ctx := context.Background()
	att := &pb.Attestation{Kind: &pb.Attestation_PlayIntegrity{PlayIntegrity: &pb.PlayIntegrity{Token: "t"}}, Subscription: "purchase-token"}

	s := newStores(true)
	if _, err := s.Attest(ctx, att, data); err != nil {
		t.Fatalf("a good verdict: %v", err)
	}
	if _, err := s.Attest(ctx, att, []byte("other")); err == nil || !strings.Contains(err.Error(), "another login") {
		t.Errorf("another login: %v", err)
	}
	sub, err := s.Subscribed(ctx, nil, att)
	if err != nil || sub.Kind != "google-play" || !sub.Sandbox || !sub.Trial || string(sub.Ident) != "purchase-token" {
		t.Fatalf("a test purchase on a sandbox relay: %+v %v", sub, err)
	}
	if tokens != 1 {
		t.Errorf("%d OAuth tokens asked for, want 1, kept", tokens)
	}
	if _, err := newStores(false).Subscribed(ctx, nil, att); err == nil || !strings.Contains(err.Error(), "test purchase") {
		t.Errorf("a test purchase on a production relay: %v", err)
	}

	verdict["deviceIntegrity"] = map[string]any{"deviceRecognitionVerdict": []string{}}
	if _, err := s.Attest(ctx, att, data); err == nil || !strings.Contains(err.Error(), "device integrity") {
		t.Errorf("no device integrity: %v", err)
	}
	verdict["deviceIntegrity"] = map[string]any{"deviceRecognitionVerdict": []string{"MEETS_DEVICE_INTEGRITY"}}
	verdict["appIntegrity"] = map[string]any{"appRecognitionVerdict": "UNRECOGNIZED_VERSION", "packageName": "dev.pirc.app"}
	if _, err := s.Attest(ctx, att, data); err == nil || !strings.Contains(err.Error(), "recognise") {
		t.Errorf("an unrecognised app: %v", err)
	}
	verdict["appIntegrity"] = map[string]any{"appRecognitionVerdict": "PLAY_RECOGNIZED", "packageName": "dev.pirc.app"}
	verdict["requestDetails"].(map[string]any)["timestampMillis"] = fmt.Sprint(storesNow.Add(-time.Hour).UnixMilli())
	if _, err := s.Attest(ctx, att, data); err == nil || !strings.Contains(err.Error(), "old") {
		t.Errorf("an old token: %v", err)
	}

	purchase["subscriptionState"] = "SUBSCRIPTION_STATE_CANCELED"
	if _, err := s.Subscribed(ctx, nil, att); err != nil {
		t.Errorf("cancelled, paid until later: %v", err)
	}
	purchase["lineItems"] = []any{map[string]any{"productId": "dev.pirc.app.yearly", "expiryTime": storesNow.Add(-time.Hour).Format(time.RFC3339Nano)}}
	if _, err := s.Subscribed(ctx, nil, att); err == nil {
		t.Error("cancelled and ended, taken")
	}
	purchase["subscriptionState"] = "SUBSCRIPTION_STATE_EXPIRED"
	if _, err := s.Recheck(ctx, sub); err == nil || !strings.Contains(err.Error(), "EXPIRED") {
		t.Errorf("expired: %v", err)
	}
}
