package gateway

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func sealer(t *testing.T) *Sealer {
	k := make([]byte, KeySize)
	rand.Read(k)
	s, err := NewSealer(k)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

var apnsTarget = Target{Platform: APNs, Environment: Production, App: "dev.pirc.app", Token: strings.Repeat("ab", 32)}

func TestHandles(t *testing.T) {
	s := sealer(t)
	a, err := s.Seal(apnsTarget)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := s.Seal(apnsTarget)
	if a == b {
		t.Fatal("the same handle twice")
	}
	for _, h := range []string{a, b} {
		if got, err := s.Open(h); err != nil || got != apnsTarget {
			t.Fatalf("opened %+v %v", got, err)
		}
	}
	if _, err := sealer(t).Open(a); err == nil {
		t.Fatal("another key opens it")
	}
	raw, _ := base64.RawURLEncoding.DecodeString(a)
	for i := range raw {
		c := append([]byte(nil), raw...)
		c[i] ^= 1
		if _, err := s.Open(base64.RawURLEncoding.EncodeToString(c)); err == nil {
			t.Fatalf("opened with byte %d changed", i)
		}
	}
	for _, h := range []string{"", "!!", strings.Repeat("A", MaxHandleBytes+1)} {
		if _, err := s.Open(h); err == nil {
			t.Fatalf("opened %q", h)
		}
	}
	long := apnsTarget
	long.Token = strings.Repeat("a", 800)
	if _, err := s.Seal(long); err == nil {
		t.Fatal("sealed a handle over 1 KiB")
	}
	fcm := Target{Platform: FCM, App: "dev.pirc.app", Token: strings.Repeat("x", 163) + ":APA91b" + strings.Repeat("y", 140)}
	if h, err := s.Seal(fcm); err != nil || len(h) > MaxHandleBytes {
		t.Fatalf("an FCM token's handle: %d bytes, %v", len(h), err)
	}
}

// --- APNs -------------------------------------------------------------

type apnsCall struct {
	path    string
	header  http.Header
	payload string
}

func p8(t *testing.T) (*ecdsa.PrivateKey, []byte) {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(k)
	return k, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
}

func verifyES256(t *testing.T, jwt string, pub *ecdsa.PublicKey) map[string]any {
	t.Helper()
	parts := strings.Split(jwt, ".")
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	d := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if len(sig) != 64 || !ecdsa.Verify(pub, d[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		t.Fatal("provider token not signed by the key")
	}
	var h, c map[string]any
	hb, _ := base64.RawURLEncoding.DecodeString(parts[0])
	cb, _ := base64.RawURLEncoding.DecodeString(parts[1])
	json.Unmarshal(hb, &h)
	json.Unmarshal(cb, &c)
	if h["alg"] != "ES256" || h["kid"] != "KEY123" {
		t.Fatalf("header %v", h)
	}
	return c
}

func TestAPNs(t *testing.T) {
	var mu sync.Mutex
	var calls []apnsCall
	status, reason := http.StatusOK, ""
	stub := func(name string) *httptest.Server {
		return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			b, _ := io.ReadAll(r.Body)
			mu.Lock()
			calls = append(calls, apnsCall{path: name + r.URL.Path, header: r.Header, payload: string(b)})
			st, re := status, reason
			mu.Unlock()
			w.WriteHeader(st)
			if re != "" {
				fmt.Fprintf(w, `{"reason":%q}`, re)
			}
		}))
	}
	prod, dev := stub("prod"), stub("dev")
	defer prod.Close()
	defer dev.Close()
	k, pemKey := p8(t)
	parsed, err := ParseP8(pemKey)
	if err != nil || !parsed.Equal(k) {
		t.Fatalf("parse: %v", err)
	}
	now := time.Unix(1_800_000_000, 0)
	a := &APNsSender{KeyID: "KEY123", TeamID: "TEAM45", Key: parsed, Client: prod.Client(), Production: prod.URL, Development: dev.URL, Now: func() time.Time { return now }}

	if err := a.Send(context.Background(), apnsTarget); err != nil {
		t.Fatal(err)
	}
	c := calls[0]
	if c.path != "prod/3/device/"+apnsTarget.Token {
		t.Fatalf("path %s", c.path)
	}
	for h, want := range map[string]string{"apns-push-type": "alert", "apns-priority": "10", "apns-topic": "dev.pirc.app", "apns-expiration": fmt.Sprint(now.Add(24 * time.Hour).Unix())} {
		if got := c.header.Get(h); got != want {
			t.Errorf("%s: %q, not %q", h, got, want)
		}
	}
	var p map[string]any
	json.Unmarshal([]byte(c.payload), &p)
	aps := p["aps"].(map[string]any)
	if alert := aps["alert"].(map[string]any); alert["body"] != "A session needs you" || alert["title"] != "PiRC" || aps["mutable-content"] != 1.0 || aps["sound"] != "default" || len(p) != 1 {
		t.Fatalf("payload %s", c.payload)
	}
	claims := verifyES256(t, strings.TrimPrefix(c.header.Get("authorization"), "bearer "), &k.PublicKey)
	if claims["iss"] != "TEAM45" || claims["iat"] != float64(now.Unix()) {
		t.Fatalf("claims %v", claims)
	}

	// A development build's goes to the test servers; the token is reused
	// within 50 minutes, then made again.
	devTarget := apnsTarget
	devTarget.Environment = Development
	a.Client = dev.Client()
	if err := a.Send(context.Background(), devTarget); err != nil {
		t.Fatal(err)
	}
	if calls[1].path != "dev/3/device/"+apnsTarget.Token || calls[1].header.Get("authorization") != c.header.Get("authorization") {
		t.Fatalf("second push %v", calls[1].path)
	}
	now = now.Add(51 * time.Minute)
	a.Client = prod.Client()
	a.Send(context.Background(), apnsTarget)
	if calls[2].header.Get("authorization") == c.header.Get("authorization") {
		t.Fatal("the provider token was not renewed")
	}

	// Gone: 410, or 400 BadDeviceToken. Any other 400 is a fault, not the
	// token's.
	for _, tc := range []struct {
		status int
		reason string
		gone   bool
	}{
		{http.StatusGone, "Unregistered", true},
		{http.StatusBadRequest, "BadDeviceToken", true},
		{http.StatusBadRequest, "BadTopic", false},
		{http.StatusBadRequest, "PayloadEmpty", false},
		{http.StatusTooManyRequests, "TooManyRequests", false},
	} {
		mu.Lock()
		status, reason = tc.status, tc.reason
		mu.Unlock()
		err := a.Send(context.Background(), apnsTarget)
		if errors.Is(err, errGone) != tc.gone || err == nil {
			t.Errorf("%d %s: %v", tc.status, tc.reason, err)
		}
	}
	// A refused provider token is made again for the next push.
	mu.Lock()
	status, reason = http.StatusForbidden, "ExpiredProviderToken"
	mu.Unlock()
	before := len(calls)
	a.Send(context.Background(), apnsTarget)
	a.Send(context.Background(), apnsTarget)
	if calls[before].header.Get("authorization") == calls[before+1].header.Get("authorization") {
		t.Fatal("a refused provider token was used again")
	}
}

// --- FCM --------------------------------------------------------------

type fcmStub struct {
	t       *testing.T
	key     *rsa.PublicKey
	srv     *httptest.Server
	mu      sync.Mutex
	tokens  int
	sends   []map[string]any
	status  int
	refusal string
}

func startFCM(t *testing.T, key *rsa.PublicKey) *fcmStub {
	f := &fcmStub{t: t, key: key, status: http.StatusOK}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.URL.Path {
		case "/token":
			r.ParseForm()
			if r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" {
				t.Errorf("grant %v", r.Form)
			}
			parts := strings.Split(r.Form.Get("assertion"), ".")
			sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
			d := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
			if rsa.VerifyPKCS1v15(f.key, crypto.SHA256, d[:], sig) != nil {
				t.Error("assertion not signed by the service account")
			}
			var c map[string]any
			cb, _ := base64.RawURLEncoding.DecodeString(parts[1])
			json.Unmarshal(cb, &c)
			if c["iss"] != "push@project.iam.gserviceaccount.com" || c["scope"] != fcmScope || c["aud"] != f.srv.URL+"/token" {
				t.Errorf("claims %v", c)
			}
			f.tokens++
			fmt.Fprintf(w, `{"access_token":"at-%d","expires_in":3600,"token_type":"Bearer"}`, f.tokens)
		case "/v1/projects/project-1/messages:send":
			if r.Header.Get("authorization") != fmt.Sprintf("Bearer at-%d", f.tokens) {
				t.Errorf("authorization %q", r.Header.Get("authorization"))
			}
			var m map[string]any
			json.NewDecoder(r.Body).Decode(&m)
			f.sends = append(f.sends, m)
			w.WriteHeader(f.status)
			io.WriteString(w, f.refusal)
		default:
			t.Errorf("path %s", r.URL.Path)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func serviceAccount(t *testing.T, tokenURI string) (*rsa.PrivateKey, []byte) {
	k, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.MarshalPKCS8PrivateKey(k)
	b, _ := json.Marshal(map[string]string{
		"type": "service_account", "project_id": "project-1", "client_email": "push@project.iam.gserviceaccount.com",
		"private_key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), "token_uri": tokenURI,
	})
	return k, b
}

func TestFCM(t *testing.T) {
	stub := startFCM(t, nil)
	k, creds := serviceAccount(t, stub.srv.URL+"/token")
	stub.key = &k.PublicKey
	f, err := ParseServiceAccount(creds)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_800_000_000, 0)
	f.Client, f.SendURL, f.Now = stub.srv.Client(), stub.srv.URL, func() time.Time { return now }
	target := Target{Platform: FCM, App: "dev.pirc.app", Token: "tok:en"}

	if err := f.Send(context.Background(), target); err != nil {
		t.Fatal(err)
	}
	msg, _ := json.Marshal(stub.sends[0])
	if string(msg) != `{"message":{"android":{"priority":"HIGH","ttl":"86400s"},"data":{"wake":"1"},"token":"tok:en"}}` {
		t.Fatalf("message %s", msg)
	}
	// The access token is reused until five minutes before it lapses.
	now = now.Add(50 * time.Minute)
	f.Send(context.Background(), target)
	now = now.Add(6 * time.Minute)
	f.Send(context.Background(), target)
	if stub.tokens != 2 {
		t.Fatalf("%d access tokens", stub.tokens)
	}

	detail := func(code, field string) string {
		d := fmt.Sprintf(`{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":%q}`, code)
		if field != "" {
			d += fmt.Sprintf(`,{"@type":"type.googleapis.com/google.rpc.BadRequest","fieldViolations":[{"field":%q,"description":"x"}]}`, field)
		}
		return d
	}
	for _, tc := range []struct {
		name    string
		status  int
		refusal string
		gone    bool
	}{
		{"unregistered", 404, `{"error":{"code":404,"status":"NOT_FOUND","details":[` + detail("UNREGISTERED", "") + `]}}`, true},
		{"a bad token", 400, `{"error":{"code":400,"status":"INVALID_ARGUMENT","details":[` + detail("INVALID_ARGUMENT", "message.token") + `]}}`, true},
		{"a bad message", 400, `{"error":{"code":400,"status":"INVALID_ARGUMENT","details":[` + detail("INVALID_ARGUMENT", "message.android.ttl") + `]}}`, false},
		{"invalid, no field", 400, `{"error":{"code":400,"status":"INVALID_ARGUMENT","details":[` + detail("INVALID_ARGUMENT", "") + `]}}`, false},
		{"quota", 429, `{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[` + detail("QUOTA_EXCEEDED", "") + `]}}`, false},
		{"unavailable", 503, `not json`, false},
	} {
		stub.mu.Lock()
		stub.status, stub.refusal = tc.status, tc.refusal
		stub.mu.Unlock()
		err := f.Send(context.Background(), target)
		if err == nil || errors.Is(err, errGone) != tc.gone {
			t.Errorf("%s: %v", tc.name, err)
		}
	}
}

func TestParseServiceAccountRefuses(t *testing.T) {
	for _, b := range []string{`nope`, `{"type":"authorized_user"}`, `{"type":"service_account","project_id":"p","client_email":"e","private_key":"x"}`} {
		if _, err := ParseServiceAccount([]byte(b)); err == nil {
			t.Errorf("accepted %s", b)
		}
	}
}

// --- The gateway's own API -------------------------------------------

type fakeSender struct {
	mu   sync.Mutex
	sent []Target
	err  error
}

func (f *fakeSender) Send(_ context.Context, t Target) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, t)
	return f.err
}

type api struct {
	t           *testing.T
	srv         *httptest.Server
	apns        *fakeSender
	apnsSandbox *fakeSender
	fcm         *fakeSender
	now         time.Time
}

func startAPI(t *testing.T, apnsOnly bool) *api {
	a := &api{t: t, apns: &fakeSender{}, apnsSandbox: &fakeSender{}, fcm: &fakeSender{}, now: time.Unix(1_800_000_000, 0)}
	cfg := Config{Sealer: sealer(t), APNs: a.apns, APNsSandbox: a.apnsSandbox, FCM: a.fcm, Apps: []string{"dev.pirc.app"}, Now: func() time.Time { return a.now }, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if apnsOnly {
		cfg.FCM = nil
	}
	g, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	a.srv = httptest.NewServer(g.Handler())
	t.Cleanup(a.srv.Close)
	return a
}

func (a *api) post(path string, body any) (int, map[string]string, http.Header) {
	a.t.Helper()
	b, _ := json.Marshal(body)
	resp, err := http.Post(a.srv.URL+path, "application/json", bytes.NewReader(b))
	if err != nil {
		a.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]string
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out, resp.Header
}

func (a *api) register(body map[string]string) string {
	a.t.Helper()
	status, out, _ := a.post("/v1/register", body)
	if status != http.StatusOK || out["handle"] == "" {
		a.t.Fatalf("register %v: %d %v", body, status, out)
	}
	return out["handle"]
}

func TestRegisterAndWake(t *testing.T) {
	a := startAPI(t, false)
	apns := map[string]string{"platform": "apns", "token": apnsTarget.Token, "environment": "development", "app": "dev.pirc.app", "version": "0.1.0"}
	h := a.register(apns)
	if status, _, _ := a.post("/v1/wake", map[string]string{"handle": h}); status != http.StatusOK {
		t.Fatalf("wake %d", status)
	}
	want := Target{Platform: APNs, Environment: Development, App: "dev.pirc.app", Token: apnsTarget.Token}
	if len(a.apnsSandbox.sent) != 1 || a.apnsSandbox.sent[0] != want || len(a.apns.sent) != 0 {
		t.Fatalf("sent %+v, %+v", a.apnsSandbox.sent, a.apns.sent)
	}
	fh := a.register(map[string]string{"platform": "fcm", "token": "abc:DEF-123_x", "app": "dev.pirc.app"})
	a.post("/v1/wake", map[string]string{"handle": fh})
	if len(a.fcm.sent) != 1 || a.fcm.sent[0].Token != "abc:DEF-123_x" {
		t.Fatalf("sent %+v", a.fcm.sent)
	}

	// Refused registrations.
	with := func(k, v string) map[string]string {
		m := map[string]string{}
		for kk, vv := range apns {
			m[kk] = vv
		}
		m[k] = v
		return m
	}
	for name, body := range map[string]map[string]string{
		"another app":               with("app", "com.example.other"),
		"no platform":               with("platform", ""),
		"a token not hex":           with("token", strings.Repeat("zz", 32)),
		"a short token":             with("token", "abcd"),
		"no environment":            with("environment", ""),
		"another environment":       with("environment", "staging"),
		"an odd version":            with("version", "1 2"),
		"FCM with an environment":   {"platform": "fcm", "token": "abc", "environment": "production", "app": "dev.pirc.app"},
		"FCM, a token with a slash": {"platform": "fcm", "token": "a/b", "app": "dev.pirc.app"},
	} {
		// Each counts against the address's limit.
		a.now = a.now.Add(time.Minute)
		if status, out, _ := a.post("/v1/register", body); status != http.StatusBadRequest || out["error"] == "" {
			t.Errorf("%s: %d %v", name, status, out)
		}
	}
	a.now = a.now.Add(time.Minute)
	resp, _ := http.Post(a.srv.URL+"/v1/register", "application/json", strings.NewReader("{"))
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("malformed JSON: %d", resp.StatusCode)
	}

	// Wakes: a handle not this key's is gone; so is a token the push
	// service no longer knows. A push service's other refusal is a 502.
	if status, _, _ := a.post("/v1/wake", map[string]string{"handle": "nonsense"}); status != http.StatusGone {
		t.Fatalf("unknown handle: %d", status)
	}
	a.apnsSandbox.err = errGone
	if status, _, _ := a.post("/v1/wake", map[string]string{"handle": h}); status != http.StatusGone {
		t.Fatalf("gone: %d", status)
	}
	a.apnsSandbox.err = errors.New("APNs answered 500")
	if status, _, _ := a.post("/v1/wake", map[string]string{"handle": h}); status != http.StatusBadGateway {
		t.Fatalf("failed: %d", status)
	}
}

// A platform without credentials answers 503, never 410: a relay keeps its
// registrations through a gateway started without them.
func TestPlatformNotServed(t *testing.T) {
	a := startAPI(t, true)
	if status, _, hdr := a.post("/v1/register", map[string]string{"platform": "fcm", "token": "abc", "app": "dev.pirc.app"}); status != http.StatusServiceUnavailable || hdr.Get("Retry-After") == "" {
		t.Fatalf("register: %d", status)
	}
	// Malformed is still 400.
	a.now = a.now.Add(time.Minute)
	if status, _, _ := a.post("/v1/register", map[string]string{"platform": "fcm", "token": "a/b", "app": "dev.pirc.app"}); status != http.StatusBadRequest {
		t.Fatalf("malformed: %d", status)
	}
}

// Each APNs environment has its own key: a production token's wake goes
// through APNs, a development one's through APNsSandbox, and an
// environment without a key answers 503.
func TestAPNsEnvironments(t *testing.T) {
	a := startAPI(t, false)
	body := func(env string) map[string]string {
		return map[string]string{"platform": "apns", "token": apnsTarget.Token, "environment": env, "app": "dev.pirc.app"}
	}
	h := a.register(body("production"))
	if status, _, _ := a.post("/v1/wake", map[string]string{"handle": h}); status != http.StatusOK {
		t.Fatalf("wake %d", status)
	}
	if len(a.apns.sent) != 1 || a.apns.sent[0].Environment != Production || len(a.apnsSandbox.sent) != 0 {
		t.Fatalf("sent %+v, %+v", a.apns.sent, a.apnsSandbox.sent)
	}

	s := sealer(t)
	g, err := New(Config{Sealer: s, APNs: &fakeSender{}, Apps: []string{"dev.pirc.app"}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(g.Handler())
	defer srv.Close()
	only := &api{t: t, srv: srv}
	if status, _, _ := only.post("/v1/register", body("development")); status != http.StatusServiceUnavailable {
		t.Fatalf("register development: %d", status)
	}
	only.register(body("production"))
	dh, _ := s.Seal(Target{Platform: APNs, Environment: Development, App: "dev.pirc.app", Token: apnsTarget.Token})
	if status, _, _ := only.post("/v1/wake", map[string]string{"handle": dh}); status != http.StatusServiceUnavailable {
		t.Fatalf("wake development: %d", status)
	}
}

// With neither platform the gateway still starts. A handle made while a
// platform was served, woken once it is not, answers 503 too.
func TestNoPlatform(t *testing.T) {
	s := sealer(t)
	g, err := New(Config{Sealer: s, Apps: []string{"dev.pirc.app"}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(g.Handler())
	defer srv.Close()
	a := &api{t: t, srv: srv}
	for _, target := range []Target{apnsTarget, {Platform: FCM, App: "dev.pirc.app", Token: "abc"}} {
		h, _ := s.Seal(target)
		if status, _, _ := a.post("/v1/wake", map[string]string{"handle": h}); status != http.StatusServiceUnavailable {
			t.Fatalf("wake %s: %d", target.Platform, status)
		}
	}
	// An app no longer served is still gone.
	h, _ := s.Seal(Target{Platform: FCM, App: "com.example.other", Token: "abc"})
	if status, _, _ := a.post("/v1/wake", map[string]string{"handle": h}); status != http.StatusGone {
		t.Fatalf("another app: %d", status)
	}
}

func TestLimits(t *testing.T) {
	a := startAPI(t, false)
	reg := map[string]string{"platform": "fcm", "token": "t0", "app": "dev.pirc.app"}
	var handles []string
	for i := 0; i < 10; i++ {
		reg["token"] = fmt.Sprintf("t%d", i)
		handles = append(handles, a.register(reg))
	}
	// Registrations, by address.
	status, _, header := a.post("/v1/register", reg)
	if status != http.StatusTooManyRequests || header.Get("Retry-After") == "" {
		t.Fatalf("eleventh registration: %d %v", status, header)
	}
	// Wakes, by token, not by address: one relay wakes every phone from
	// one.
	for _, h := range handles {
		if status, _, _ := a.post("/v1/wake", map[string]string{"handle": h}); status != http.StatusOK {
			t.Fatalf("wake: %d", status)
		}
	}
	for i := 1; i < 6; i++ {
		a.post("/v1/wake", map[string]string{"handle": handles[0]})
	}
	status, _, header = a.post("/v1/wake", map[string]string{"handle": handles[0]})
	if status != http.StatusTooManyRequests || header.Get("Retry-After") == "" {
		t.Fatalf("seventh wake: %d %v", status, header)
	}
	// Another handle for the same token shares its limit.
	reg["token"] = "t0"
	a.now = a.now.Add(time.Minute)
	other := a.register(reg)
	for i := 0; i < 6; i++ {
		a.post("/v1/wake", map[string]string{"handle": handles[0]})
	}
	if status, _, _ := a.post("/v1/wake", map[string]string{"handle": other}); status != http.StatusTooManyRequests {
		t.Fatalf("the same token through another handle: %d", status)
	}
}
