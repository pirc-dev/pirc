package registry

import (
	"crypto/ed25519"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

func key(t *testing.T) []byte {
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	return pub
}

func TestTokenLifecycle(t *testing.T) {
	r := New(t.TempDir())
	now := time.Now()
	tok, err := r.IssueToken(RoleHost, "desk", time.Minute, now)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.CheckToken(tok, RoleClient, now); !errors.Is(err, ErrRoleMismatch) {
		t.Fatalf("other role: %v", err)
	}
	if _, err := r.Redeem(tok, key(t), RoleClient, "", now); !errors.Is(err, ErrRoleMismatch) {
		t.Fatalf("redeem for other role: %v", err)
	}
	// A refused redemption leaves the token.
	if err := r.CheckToken(tok, RoleHost, now); err != nil {
		t.Fatal(err)
	}
	pub := key(t)
	k, err := r.Redeem(tok, pub, RoleHost, "fallback", now)
	if err != nil || k.Label != "desk" || k.Role != RoleHost {
		t.Fatalf("redeem: %+v %v", k, err)
	}
	if _, err := r.Redeem(tok, key(t), RoleHost, "", now); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("second redemption: %v", err)
	}
	d, _ := r.Load()
	if _, ok := d.Lookup(pub); !ok || len(d.Tokens) != 0 {
		t.Fatalf("registry %+v", d)
	}
}

func TestFallbackLabelAndExistingKey(t *testing.T) {
	r := New(t.TempDir())
	now := time.Now()
	pub := key(t)
	tok, _ := r.IssueToken(RoleClient, "", time.Minute, now)
	if k, err := r.Redeem(tok, pub, RoleClient, "phone", now); err != nil || k.Label != "phone" {
		t.Fatalf("redeem: %+v %v", k, err)
	}
	// Redeeming for a key already registered keeps the first entry.
	tok2, _ := r.IssueToken(RoleClient, "other", time.Minute, now)
	if k, err := r.Redeem(tok2, pub, RoleClient, "", now); err != nil || k.Label != "phone" {
		t.Fatalf("again: %+v %v", k, err)
	}
	if d, _ := r.Load(); len(d.Keys) != 1 {
		t.Fatalf("keys %+v", d.Keys)
	}
}

func TestExpiry(t *testing.T) {
	r := New(t.TempDir())
	now := time.Now()
	old, _ := r.IssueToken(RoleClient, "", time.Minute, now)
	later := now.Add(2 * time.Minute)
	if err := r.CheckToken(old, RoleClient, later); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("expired: %v", err)
	}
	// Issuing and redeeming both drop expired tokens.
	fresh, _ := r.IssueToken(RoleClient, "", time.Minute, later)
	if d, _ := r.Load(); len(d.Tokens) != 1 {
		t.Fatalf("tokens after issue: %d", len(d.Tokens))
	}
	r.IssueToken(RoleClient, "", time.Second, later)
	if _, err := r.Redeem(fresh, key(t), RoleClient, "", later.Add(30*time.Second)); err != nil {
		t.Fatal(err)
	}
	if d, _ := r.Load(); len(d.Tokens) != 0 {
		t.Fatalf("tokens after redeem: %d", len(d.Tokens))
	}
}

func TestConcurrentRedemption(t *testing.T) {
	r := New(t.TempDir())
	tok, _ := r.IssueToken(RoleClient, "", time.Minute, time.Now())
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins := 0
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := r.Redeem(tok, key(t), RoleClient, "", time.Now()); err == nil {
				mu.Lock()
				wins++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	d, _ := r.Load()
	if wins != 1 || len(d.Keys) != 1 {
		t.Fatalf("%d redemptions won, %d keys", wins, len(d.Keys))
	}
}

func TestRemove(t *testing.T) {
	r := New(t.TempDir())
	now := time.Now()
	var keys []string
	for range 2 {
		tok, _ := r.IssueToken(RoleClient, "", time.Minute, now)
		k, err := r.Redeem(tok, key(t), RoleClient, "", now)
		if err != nil {
			t.Fatal(err)
		}
		keys = append(keys, k.PublicKey)
	}
	if _, err := r.Remove(""); !errors.Is(err, ErrShortPrefix) {
		t.Fatalf("empty prefix: %v", err)
	}
	if _, err := r.Remove(keys[0][:MinKeyPrefix-1]); !errors.Is(err, ErrShortPrefix) {
		t.Fatalf("short prefix: %v", err)
	}
	if _, err := r.Remove("not-a-key-prefix!"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("no match: %v", err)
	}
	if k, err := r.Remove(keys[0][:MinKeyPrefix]); err != nil || k.PublicKey != keys[0] {
		t.Fatalf("remove: %+v %v", k, err)
	}
	if d, _ := r.Load(); len(d.Keys) != 1 || d.Keys[0].PublicKey != keys[1] {
		t.Fatalf("keys %+v", d.Keys)
	}
}

func TestLimitsAndPermissions(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	r := New(dir)
	long := strings.Repeat("l", MaxLabelBytes+1)
	if _, err := r.IssueToken(RoleHost, long, time.Minute, time.Now()); !errors.Is(err, ErrLabelTooLong) {
		t.Fatalf("long label: %v", err)
	}
	if _, err := r.IssueToken(RoleHost, "", time.Minute, time.Now()); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]os.FileMode{dir: 0o700, r.Path: 0o600} {
		fi, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != want {
			t.Errorf("%s: mode %v, want %v", path, fi.Mode().Perm(), want)
		}
	}
	before := r.Stamp()
	r.IssueToken(RoleHost, "", time.Minute, time.Now())
	if r.Stamp().Same(before) {
		t.Error("stamp unchanged after a write")
	}
}

func TestRequestApproveReject(t *testing.T) {
	r := New(t.TempDir())
	now := time.Now()
	pub := key(t)
	enc := EncodeKey(pub)

	created, err := r.Request(pub, "laptop", "pirc-extension/1", "10.0.0.2:5000", now, 0)
	if err != nil || !created {
		t.Fatalf("first request: created %v, %v", created, err)
	}
	created, err = r.Request(pub, "laptop", "pirc-extension/2", "10.0.0.2:5001", now.Add(time.Minute), 0)
	if err != nil || created {
		t.Fatalf("second request: created %v, %v", created, err)
	}
	d, _ := r.Load()
	p := d.Pending(now.Add(time.Minute))
	if len(p) != 1 || p[0].Software != "pirc-extension/2" || !p[0].FirstSeen.Equal(now) || !p[0].LastSeen.Equal(now.Add(time.Minute)) {
		t.Fatalf("pending %+v", p)
	}

	if _, err := r.Approve(enc[:MinKeyPrefix-1], "", now); !errors.Is(err, ErrShortPrefix) {
		t.Fatalf("short prefix: %v", err)
	}
	if _, err := r.Approve(EncodeKey(key(t)), "", now); !errors.Is(err, ErrNoRequest) {
		t.Fatalf("unknown key: %v", err)
	}
	k, err := r.Approve(enc[:MinKeyPrefix], "", now)
	if err != nil || k.Label != "laptop" || k.Role != RoleHost || k.PublicKey != enc {
		t.Fatalf("approve: %+v, %v", k, err)
	}
	d, _ = r.Load()
	if _, ok := d.Lookup(pub); !ok || len(d.Requests) != 0 {
		t.Fatalf("after approval %+v", d)
	}
	// A registered key makes no request.
	if created, err := r.Request(pub, "laptop", "", "", now, 0); err != nil || created {
		t.Fatalf("registered key: created %v, %v", created, err)
	}

	other := key(t)
	r.Request(other, "stranger", "", "", now, 0)
	if _, err := r.Reject(EncodeKey(other)[:MinKeyPrefix-1], now); !errors.Is(err, ErrShortPrefix) {
		t.Fatalf("short reject prefix: %v", err)
	}
	q, err := r.Reject(EncodeKey(other)[:MinKeyPrefix], now)
	if err != nil || q.Label != "stranger" {
		t.Fatalf("reject: %+v, %v", q, err)
	}
	d, _ = r.Load()
	if len(d.Requests) != 0 {
		t.Fatal("rejected request kept")
	}
}

func TestApproveWithLabel(t *testing.T) {
	r := New(t.TempDir())
	pub := key(t)
	r.Request(pub, "claimed", "", "", time.Now(), 0)
	k, err := r.Approve(EncodeKey(pub), "chosen", time.Now())
	if err != nil || k.Label != "chosen" {
		t.Fatalf("%+v, %v", k, err)
	}
}

func TestRequestLimits(t *testing.T) {
	r := New(t.TempDir())
	now := time.Now()
	for i := 0; i < MaxRequests; i++ {
		if _, err := r.Request(key(t), "h", "", "", now, 0); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := r.Request(key(t), "h", "", "", now, 0); !errors.Is(err, ErrTooMany) {
		t.Fatalf("over the limit: %v", err)
	}
	// A day after they last asked, requests are gone and make room.
	later := now.Add(RequestTTL)
	if _, err := r.Request(key(t), strings.Repeat("é", 100), "", "", later, 0); err != nil {
		t.Fatal(err)
	}
	d, _ := r.Load()
	p := d.Pending(later)
	if len(p) != 1 || len(p[0].Label) > maxRequestString || !utf8.ValidString(p[0].Label) {
		t.Fatalf("pending %+v", p)
	}
}

func TestRedeemDropsRequest(t *testing.T) {
	r := New(t.TempDir())
	now := time.Now()
	pub := key(t)
	r.Request(pub, "h", "", "", now, 0)
	tok, _ := r.IssueToken(RoleHost, "h", time.Minute, now)
	if _, err := r.Redeem(tok, pub, RoleHost, "", now); err != nil {
		t.Fatal(err)
	}
	d, _ := r.Load()
	if len(d.Requests) != 0 {
		t.Fatal("request kept after the key was registered with a token")
	}
}

func TestRemoveAmbiguousPrefix(t *testing.T) {
	r := New(t.TempDir())
	shared := strings.Repeat("A", MinKeyPrefix)
	r.update(func(d *Data) error {
		d.Keys = append(d.Keys, Key{PublicKey: shared + "x", Role: RoleHost}, Key{PublicKey: shared + "y", Role: RoleHost})
		return nil
	})
	if _, err := r.Remove(shared); !errors.Is(err, ErrAmbiguous) {
		t.Fatalf("shared prefix: %v", err)
	}
	if k, err := r.Remove(shared + "x"); err != nil || k.PublicKey != shared+"x" {
		t.Fatalf("remove: %+v %v", k, err)
	}
}

func TestRequestRefresh(t *testing.T) {
	r := New(t.TempDir())
	pub := key(t)
	now := time.Now()
	if _, err := r.Request(pub, "h", "", "", now, time.Minute); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(r.Path)
	// Within the refresh, nothing is written, whatever the host says.
	if created, err := r.Request(pub, "renamed", "", "", now.Add(30*time.Second), time.Minute); err != nil || created {
		t.Fatalf("created %v, %v", created, err)
	}
	if st2, _ := os.Stat(r.Path); !st2.ModTime().Equal(st.ModTime()) || st2.Size() != st.Size() {
		t.Fatal("registry rewritten within the refresh")
	}
	if _, err := r.Request(pub, "renamed", "", "", now.Add(time.Minute), time.Minute); err != nil {
		t.Fatal(err)
	}
	d, _ := r.Load()
	if q, _ := d.Requested(pub); q.Label != "renamed" || !q.LastSeen.Equal(now.Add(time.Minute)) {
		t.Fatalf("request %+v", q)
	}
}

func TestApproveRegisteredKey(t *testing.T) {
	r := New(t.TempDir())
	pub := key(t)
	now := time.Now()
	r.Request(pub, "h", "", "", now, 0)
	// As if a registry restored from before a token enrolled the key.
	r.update(func(d *Data) error {
		d.Keys = append(d.Keys, Key{PublicKey: EncodeKey(pub), Role: RoleHost})
		return nil
	})
	if _, err := r.Approve(EncodeKey(pub), "", now); !errors.Is(err, ErrRegistered) {
		t.Fatalf("approve: %v", err)
	}
	if d, _ := r.Load(); len(d.Keys) != 1 {
		t.Fatalf("keys %+v", d.Keys)
	}
}

func TestRename(t *testing.T) {
	r := New(t.TempDir())
	now := time.Now()
	tok, _ := r.IssueToken(RoleHost, "old", time.Minute, now)
	k, err := r.Redeem(tok, key(t), RoleHost, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Rename(k.PublicKey[:MinKeyPrefix-1], "new"); !errors.Is(err, ErrShortPrefix) {
		t.Fatalf("short prefix: %v", err)
	}
	if _, err := r.Rename(k.PublicKey, ""); !errors.Is(err, ErrLabelEmpty) {
		t.Fatalf("empty label: %v", err)
	}
	if _, err := r.Rename(k.PublicKey, strings.Repeat("x", MaxLabelBytes+1)); !errors.Is(err, ErrLabelTooLong) {
		t.Fatalf("long label: %v", err)
	}
	if _, err := r.Rename("not-a-key-prefix!", "new"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("no match: %v", err)
	}
	got, err := r.Rename(k.PublicKey[:MinKeyPrefix], "new")
	if err != nil || got.Label != "new" || got.PublicKey != k.PublicKey || !got.AddedAt.Equal(k.AddedAt) {
		t.Fatalf("rename: %+v %v", got, err)
	}
	if d, _ := r.Load(); len(d.Keys) != 1 || d.Keys[0].Label != "new" {
		t.Fatalf("keys %+v", d.Keys)
	}
}

func TestSetPush(t *testing.T) {
	r := New(t.TempDir())
	now := time.Now()
	tok, _ := r.IssueToken(RoleClient, "phone", time.Minute, now)
	pub := key(t)
	if _, err := r.Redeem(tok, pub, RoleClient, "", now); err != nil {
		t.Fatal(err)
	}
	if _, err := r.SetPush(key(t), "h"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown key: %v", err)
	}
	if _, err := r.SetPush(pub, strings.Repeat("h", MaxPushHandleBytes+1)); !errors.Is(err, ErrHandleSize) {
		t.Fatalf("long handle: %v", err)
	}
	if k, err := r.SetPush(pub, "h"); err != nil || k.PushHandle != "h" {
		t.Fatalf("set: %+v %v", k, err)
	}
	d, _ := r.Load()
	if k, _ := d.Lookup(pub); k.PushHandle != "h" {
		t.Fatalf("stored %+v", k)
	}
	if k, err := r.SetPush(pub, ""); err != nil || k.PushHandle != "" {
		t.Fatalf("cleared: %+v %v", k, err)
	}
}

func TestReadKey(t *testing.T) {
	r := New(t.TempDir())
	now := time.Now()
	enrol := func(role Role) []byte {
		tok, _ := r.IssueToken(role, "", time.Minute, now)
		pub := key(t)
		if _, err := r.Redeem(tok, pub, role, "x", now); err != nil {
			t.Fatal(err)
		}
		return pub
	}
	phone, host := enrol(RoleClient), enrol(RoleHost)
	read := key(t)
	if _, err := r.SetReadKey(host, read); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a host's: %v", err)
	}
	if k, err := r.SetReadKey(phone, read); err != nil || k.ReadKey != EncodeKey(read) {
		t.Fatalf("set: %+v %v", k, err)
	}
	d, _ := r.Load()
	if k, ok := d.LookupRead(read); !ok || k.PublicKey != EncodeKey(phone) {
		t.Fatalf("lookup %+v %v", k, ok)
	}
	if !d.Admits(read, RoleClient, true) || d.Admits(read, RoleClient, false) || d.Admits(read, RoleHost, true) {
		t.Fatal("admits")
	}
	// Redeemed as a key of its own, as a login racing the registration
	// would.
	tok, _ := r.IssueToken(RoleClient, "", time.Minute, now)
	if _, err := r.Redeem(tok, read, RoleClient, "x", now); !errors.Is(err, ErrKeyTaken) {
		t.Fatalf("redeemed: %v", err)
	}
	// Gone with its client.
	if _, err := r.Remove(EncodeKey(phone)); err != nil {
		t.Fatal(err)
	}
	d, _ = r.Load()
	if _, ok := d.LookupRead(read); ok {
		t.Fatal("kept")
	}
}

func TestReusableToken(t *testing.T) {
	r := New(t.TempDir())
	now := time.Now()
	if _, err := r.IssueReusableToken("", 5, time.Hour, now); !errors.Is(err, ErrLabelEmpty) {
		t.Fatalf("no label: %v", err)
	}
	if _, err := r.IssueReusableToken(strings.Repeat("x", MaxLabelBytes-7), 5, time.Hour, now); !errors.Is(err, ErrLabelTooLong) {
		t.Fatalf("no room for the number: %v", err)
	}
	if _, err := r.IssueReusableToken("x", 0, time.Hour, now); !errors.Is(err, ErrMaxUses) {
		t.Fatalf("no uses: %v", err)
	}
	tok, err := r.IssueReusableToken("review-google", 2, time.Hour, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.IssueReusableToken("review-google", 2, time.Hour, now); !errors.Is(err, ErrLabelTaken) {
		t.Fatalf("a second with the label: %v", err)
	}
	if _, err := r.IssueToken(RoleClient, "review-google", time.Hour, now); !errors.Is(err, ErrLabelTaken) {
		t.Fatalf("a one-time token with its label: %v", err)
	}
	if _, err := r.Redeem(tok, key(t), RoleHost, "", now); !errors.Is(err, ErrRoleMismatch) {
		t.Fatalf("a host: %v", err)
	}
	a, b := key(t), key(t)
	for i, want := range []struct {
		pub   []byte
		label string
	}{{a, "review-google-1"}, {a, "review-google-1"}, {b, "review-google-2"}} {
		k, err := r.Redeem(tok, want.pub, RoleClient, "phone", now)
		if err != nil || k.Label != want.label {
			t.Fatalf("redeem %d: %+v %v", i, k, err)
		}
	}
	d, _ := r.Load()
	if len(d.Keys) != 2 || len(d.Tokens) != 0 {
		t.Fatalf("used up, it is gone: %+v", d)
	}
	if _, err := r.Redeem(tok, key(t), RoleClient, "", now); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("a third: %v", err)
	}
	// Issued again, it numbers on from the keys the last one let in.
	tok, _ = r.IssueReusableToken("review-google", 2, time.Hour, now)
	if k, err := r.Redeem(tok, key(t), RoleClient, "", now); err != nil || k.Label != "review-google-3" {
		t.Fatalf("again: %+v %v", k, err)
	}
	if _, err := r.Redeem(tok, key(t), RoleClient, "", now.Add(time.Hour)); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("expired: %v", err)
	}
}

func TestRevokeToken(t *testing.T) {
	r := New(t.TempDir())
	now := time.Now()
	tok, _ := r.IssueReusableToken("review-apple", 5, time.Hour, now)
	r.IssueToken(RoleClient, "phone", time.Hour, now)
	if _, err := r.Redeem(tok, key(t), RoleClient, "", now); err != nil {
		t.Fatal(err)
	}
	if n, err := r.RevokeToken("review-apple", now); n != 1 || err != nil {
		t.Fatalf("revoke: %d %v", n, err)
	}
	if _, err := r.RevokeToken("review-apple", now); !errors.Is(err, ErrNoToken) {
		t.Fatalf("again: %v", err)
	}
	if _, err := r.Redeem(tok, key(t), RoleClient, "", now); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("after revoking: %v", err)
	}
	d, _ := r.Load()
	if len(d.Keys) != 1 || len(d.Tokens) != 1 || d.Tokens[0].Label != "phone" {
		t.Fatalf("after: %+v", d)
	}
}
