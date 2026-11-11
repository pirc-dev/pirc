// Package registry is the relay's only durable state: the registered keys,
// the registration tokens not yet used up, and the host keys awaiting
// the operator's approval (docs/design.md, 5.2 and 5.3).
//
// It is one JSON file. Every change takes an exclusive lock on a sibling
// lock file, reads the current file, and replaces it atomically, so the
// relay and the pirc-relay commands can change it at the same time.
package registry

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

type Role string

const (
	RoleHost   Role = "host"
	RoleClient Role = "client"
)

// Key is a registered device.
type Key struct {
	// Ed25519 public key, base64url without padding.
	PublicKey string    `json:"public_key"`
	Role      Role      `json:"role"`
	Label     string    `json:"label"`
	AddedAt   time.Time `json:"added_at"`
	// A client's push gateway handle, if it registered for push: opaque,
	// and deleted with the key (docs/design.md, section 12, step 13).
	PushHandle string `json:"push_handle,omitempty"`
	// A client's read-only key, base64url without padding, if it has one:
	// it may only read the session list, and is deleted with the key.
	ReadKey string `json:"read_key,omitempty"`
}

// Token is a registration token not yet used, or a reusable one not yet
// expired. Only its hash is stored.
type Token struct {
	Hash      string    `json:"hash"`
	Role      Role      `json:"role"`
	Label     string    `json:"label"`
	ExpiresAt time.Time `json:"expires_at"`
	// A reusable token registers any number of keys until it expires, each
	// labelled after it with a number (Used, counting them), so that the
	// keys it let in can be told from the rest: for a store's reviewers,
	// say. Clients only.
	Reusable bool `json:"reusable,omitempty"`
	Used     int  `json:"used,omitempty"`
	MaxUses  int  `json:"max_uses,omitempty"`
}

// Request is a host key that logged in without a token, proving it holds
// the key, and waits for the operator to approve or reject it.
type Request struct {
	PublicKey string `json:"public_key"`
	// As the host gave them in Hello, and the address it connected from.
	Label     string    `json:"label"`
	Software  string    `json:"software"`
	Remote    string    `json:"remote"`
	FirstSeen time.Time `json:"first_seen"`
	LastSeen  time.Time `json:"last_seen"`
}

type Data struct {
	Keys     []Key     `json:"keys"`
	Tokens   []Token   `json:"tokens"`
	Requests []Request `json:"requests,omitempty"`
}

// MaxLabelBytes bounds a label, which is stored and shown to people.
const MaxLabelBytes = 128

// MaxPushHandleBytes bounds a push handle.
const MaxPushHandleBytes = 1024

// Anyone who can reach the relay can make a request, so they are bounded:
// so many at once, each dropped a day after its host last asked, and the
// strings in them cut short.
const (
	MaxRequests      = 16
	RequestTTL       = 24 * time.Hour
	maxRequestString = 128
	// The shortest key prefix that approves, rejects or removes: 96 bits,
	// too many to find a key that shares them, and too many to type by
	// mistake.
	MinKeyPrefix = 16
)

var (
	ErrLabelTooLong = errors.New("label is too long")
	ErrLabelTaken   = errors.New("a live token already has this label")
	ErrNoToken      = errors.New("no live token has this label")
	ErrMaxUses      = errors.New("a reusable token is for at least one use")
	ErrLabelEmpty   = errors.New("label is empty")
	ErrTokenInvalid = errors.New("registration token is unknown, used or expired")
	ErrRoleMismatch = errors.New("registration token is for another role")
	ErrNotFound     = errors.New("no such key")
	ErrHandleSize   = errors.New("a push handle is needed, of at most 1 KiB")
	ErrKeyTaken     = errors.New("that key is registered already, or is a client's read-only key")
	ErrAmbiguous    = errors.New("key prefix matches more than one key")
	ErrNoRequest    = errors.New("no host awaiting approval has that key")
	ErrShortPrefix  = fmt.Errorf("give at least %d characters of the key", MinKeyPrefix)
	ErrRegistered   = errors.New("that key is registered already")
	ErrTooMany      = fmt.Errorf("%d hosts already await approval", MaxRequests)
)

// Registry is the file at Path.
type Registry struct {
	Path string
}

func New(dataDir string) *Registry {
	return &Registry{Path: filepath.Join(dataDir, "registry.json")}
}

// EncodeKey is how keys are written in the file and shown to people.
func EncodeKey(pub []byte) string {
	return base64.RawURLEncoding.EncodeToString(pub)
}

// DecodeKey reads a key as EncodeKey writes it.
func DecodeKey(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(s)
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// Load reads the file; a missing file is an empty registry.
func (r *Registry) Load() (*Data, error) {
	b, err := os.ReadFile(r.Path)
	if errors.Is(err, os.ErrNotExist) {
		return &Data{}, nil
	}
	if err != nil {
		return nil, err
	}
	d := &Data{}
	if err := json.Unmarshal(b, d); err != nil {
		return nil, fmt.Errorf("%s: %w", r.Path, err)
	}
	return d, nil
}

// Stamp is what a reader checks to tell whether the file changed.
type Stamp struct {
	ModTime time.Time
	Size    int64
}

func (a Stamp) Same(b Stamp) bool {
	return a.ModTime.Equal(b.ModTime) && a.Size == b.Size
}

// Stamp describes the file now; zero when it does not exist.
func (r *Registry) Stamp() Stamp {
	fi, err := os.Stat(r.Path)
	if err != nil {
		return Stamp{}
	}
	return Stamp{fi.ModTime(), fi.Size()}
}

// update runs fn on the current data under the lock and saves the result.
// errUnchanged, from update's fn, leaves the file as it was.
var errUnchanged = errors.New("unchanged")

func (r *Registry) update(fn func(d *Data) error) error {
	if err := os.MkdirAll(filepath.Dir(r.Path), 0o700); err != nil {
		return err
	}
	lock, err := os.OpenFile(r.Path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)

	d, err := r.Load()
	if err != nil {
		return err
	}
	if err := fn(d); errors.Is(err, errUnchanged) {
		return nil
	} else if err != nil {
		return err
	}
	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(r.Path), ".registry-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), r.Path); err != nil {
		return err
	}
	// Make the rename itself durable: a lost one would undo a revocation.
	dir, err := os.Open(filepath.Dir(r.Path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

// IssueToken creates a one-time token for registering one key of role,
// valid for ttl, and returns it. Expired tokens are dropped on the way.
func (r *Registry) IssueToken(role Role, label string, ttl time.Duration, now time.Time) (string, error) {
	return r.issue(Token{Role: role, Label: label}, ttl, now)
}

// IssueReusableToken creates a token that registers up to maxUses clients
// until it expires, each labelled label-N, numbered on from any key so
// labelled already, so that no two share a label. The label is needed,
// and no other live token may have it, since it is how the token is told
// apart and revoked (RevokeToken).
func (r *Registry) IssueReusableToken(label string, maxUses int, ttl time.Duration, now time.Time) (string, error) {
	if label == "" {
		return "", ErrLabelEmpty
	}
	if maxUses < 1 {
		return "", ErrMaxUses
	}
	return r.issue(Token{Role: RoleClient, Label: label, Reusable: true, MaxUses: maxUses}, ttl, now)
}

// The highest N among keys labelled label-N.
func numbered(keys []Key, label string) int {
	high := 0
	for _, k := range keys {
		rest, ok := strings.CutPrefix(k.Label, label+"-")
		if n, err := strconv.Atoi(rest); ok && err == nil && n > high {
			high = n
		}
	}
	return high
}

func (r *Registry) issue(t Token, ttl time.Duration, now time.Time) (string, error) {
	// A reusable token's keys add a number to its label.
	max := MaxLabelBytes
	if t.Reusable {
		max -= 8
	}
	if len(t.Label) > max {
		return "", ErrLabelTooLong
	}
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	t.Hash, t.ExpiresAt = hashToken(token), now.Add(ttl)
	err := r.update(func(d *Data) error {
		d.Tokens = live(d.Tokens, now)
		// A reusable token's label is its own: no other live token shares it.
		if t.Label != "" && slices.ContainsFunc(d.Tokens, func(o Token) bool { return o.Label == t.Label && (t.Reusable || o.Reusable) }) {
			return ErrLabelTaken
		}
		if t.Reusable {
			t.Used = numbered(d.Keys, t.Label)
			t.MaxUses += t.Used
		}
		d.Tokens = append(d.Tokens, t)
		return nil
	})
	return token, err
}

// RevokeToken deletes the live tokens labelled label, and returns how many.
// The keys a token registered stay: remove them by their labels (label-1
// and so on for a reusable one).
func (r *Registry) RevokeToken(label string, now time.Time) (int, error) {
	n := 0
	err := r.update(func(d *Data) error {
		d.Tokens = live(d.Tokens, now)
		before := len(d.Tokens)
		d.Tokens = slices.DeleteFunc(d.Tokens, func(t Token) bool { return t.Label == label })
		n = before - len(d.Tokens)
		if n == 0 {
			return ErrNoToken
		}
		return nil
	})
	return n, err
}

func live(tokens []Token, now time.Time) []Token {
	return slices.DeleteFunc(tokens, func(t Token) bool { return !now.Before(t.ExpiresAt) })
}

func findToken(d *Data, token string, now time.Time) (int, error) {
	h := hashToken(token)
	for i, t := range d.Tokens {
		if subtle.ConstantTimeCompare([]byte(t.Hash), []byte(h)) == 1 {
			if !now.Before(t.ExpiresAt) {
				return -1, ErrTokenInvalid
			}
			return i, nil
		}
	}
	return -1, ErrTokenInvalid
}

// CheckToken reports whether token could register a key of role now,
// without using it.
func (r *Registry) CheckToken(token string, role Role, now time.Time) error {
	d, err := r.Load()
	if err != nil {
		return err
	}
	return d.CheckToken(token, role, now)
}

// CheckToken is Registry.CheckToken against this snapshot.
func (d *Data) CheckToken(token string, role Role, now time.Time) error {
	i, err := findToken(d, token, now)
	if err != nil {
		return err
	}
	if d.Tokens[i].Role != role {
		return ErrRoleMismatch
	}
	return nil
}

// Redeem uses token to register pub with role. The label is the token's,
// or fallbackLabel when the token has none. Expired tokens are dropped on
// the way.
func (r *Registry) Redeem(token string, pub []byte, role Role, fallbackLabel string, now time.Time) (Key, error) {
	if len(fallbackLabel) > MaxLabelBytes {
		return Key{}, ErrLabelTooLong
	}
	var added Key
	err := r.update(func(d *Data) error {
		d.Tokens = live(d.Tokens, now)
		i, err := findToken(d, token, now)
		if err != nil {
			return err
		}
		t := d.Tokens[i]
		if t.Role != role {
			return ErrRoleMismatch
		}
		if !t.Reusable {
			d.Tokens = append(d.Tokens[:i], d.Tokens[i+1:]...)
		}
		label := t.Label
		if label == "" {
			label = fallbackLabel
		}
		enc := EncodeKey(pub)
		for _, k := range d.Keys {
			if k.PublicKey == enc {
				if k.Role != role {
					return ErrRoleMismatch
				}
				added = k
				return nil
			}
		}
		if _, ok := d.LookupRead(pub); ok {
			return ErrKeyTaken
		}
		if t.Reusable {
			if t.Used >= t.MaxUses {
				return ErrTokenInvalid
			}
			d.Tokens[i].Used++
			label = fmt.Sprintf("%s-%d", t.Label, d.Tokens[i].Used)
			// Used up: gone, as a one-time token is.
			if d.Tokens[i].Used >= t.MaxUses {
				d.Tokens = append(d.Tokens[:i], d.Tokens[i+1:]...)
			}
		}
		added = Key{PublicKey: enc, Role: role, Label: label, AddedAt: now}
		d.Keys = append(d.Keys, added)
		d.Requests = dropRequest(d.Requests, enc)
		return nil
	})
	return added, err
}

func liveRequests(rs []Request, now time.Time) []Request {
	return slices.DeleteFunc(rs, func(q Request) bool { return !now.Before(q.LastSeen.Add(RequestTTL)) })
}

func dropRequest(rs []Request, enc string) []Request {
	return slices.DeleteFunc(rs, func(q Request) bool { return q.PublicKey == enc })
}

// byPrefix finds the one item whose key starts with prefix: notFound when
// none does, ErrAmbiguous when more than one does.
func byPrefix[T any](items []T, prefix string, key func(T) string, notFound error) (int, error) {
	idx := -1
	for i, it := range items {
		if strings.HasPrefix(key(it), prefix) {
			if idx >= 0 {
				return -1, ErrAmbiguous
			}
			idx = i
		}
	}
	if idx < 0 {
		return -1, notFound
	}
	return idx, nil
}

func cut(s string) string {
	if len(s) <= maxRequestString {
		return s
	}
	s = s[:maxRequestString]
	// Back up to the start of a character.
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}

// Request records that pub, a host key not registered, asks to be, or
// refreshes its request; created reports a new one. A request seen less
// than refresh ago is left as it is, without writing the file, and so is a
// key registered by then, which needs no request.
func (r *Registry) Request(pub []byte, label, software, remote string, now time.Time, refresh time.Duration) (created bool, err error) {
	enc := EncodeKey(pub)
	err = r.update(func(d *Data) error {
		if _, ok := d.Lookup(pub); ok {
			return errUnchanged
		}
		if q, ok := d.Requested(pub); ok && now.Before(q.LastSeen.Add(RequestTTL)) && now.Sub(q.LastSeen) < refresh {
			return errUnchanged
		}
		d.Requests = liveRequests(d.Requests, now)
		q := Request{PublicKey: enc, Label: cut(label), Software: cut(software), Remote: cut(remote), FirstSeen: now, LastSeen: now}
		for i := range d.Requests {
			if d.Requests[i].PublicKey == enc {
				q.FirstSeen = d.Requests[i].FirstSeen
				d.Requests[i] = q
				return nil
			}
		}
		if len(d.Requests) >= MaxRequests {
			return ErrTooMany
		}
		d.Requests = append(d.Requests, q)
		created = true
		return nil
	})
	return created, err
}

// Requested returns pub's request, if it has one in this snapshot.
func (d *Data) Requested(pub []byte) (Request, bool) {
	enc := EncodeKey(pub)
	for _, q := range d.Requests {
		if q.PublicKey == enc {
			return q, true
		}
	}
	return Request{}, false
}

// Pending returns the requests still live, oldest first.
func (d *Data) Pending(now time.Time) []Request {
	var out []Request
	for _, q := range d.Requests {
		if now.Before(q.LastSeen.Add(RequestTTL)) {
			out = append(out, q)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].FirstSeen.Before(out[j].FirstSeen) })
	return out
}

// takeRequest removes and returns the live request whose key starts with
// prefix.
func takeRequest(d *Data, prefix string, now time.Time) (Request, error) {
	d.Requests = liveRequests(d.Requests, now)
	idx, err := byPrefix(d.Requests, prefix, func(q Request) string { return q.PublicKey }, ErrNoRequest)
	if err != nil {
		return Request{}, err
	}
	q := d.Requests[idx]
	d.Requests = slices.Delete(d.Requests, idx, idx+1)
	return q, nil
}

// Approve registers the requested host key that starts with prefix, under
// label, or the label it asked with when label is empty.
func (r *Registry) Approve(prefix, label string, now time.Time) (Key, error) {
	if len(prefix) < MinKeyPrefix {
		return Key{}, ErrShortPrefix
	}
	if len(label) > MaxLabelBytes {
		return Key{}, ErrLabelTooLong
	}
	var added Key
	err := r.update(func(d *Data) error {
		q, err := takeRequest(d, prefix, now)
		if err != nil {
			return err
		}
		// Registered since it asked (a registry restored from before a
		// token enrolled it): a second entry would make it unremovable.
		for _, k := range d.Keys {
			if k.PublicKey == q.PublicKey {
				return ErrRegistered
			}
			if k.ReadKey == q.PublicKey {
				return ErrKeyTaken
			}
		}
		if label == "" {
			label = q.Label
		}
		added = Key{PublicKey: q.PublicKey, Role: RoleHost, Label: label, AddedAt: now}
		d.Keys = append(d.Keys, added)
		return nil
	})
	return added, err
}

// Reject drops the request whose key starts with prefix. The host asks
// again the next time it connects.
func (r *Registry) Reject(prefix string, now time.Time) (Request, error) {
	if len(prefix) < MinKeyPrefix {
		return Request{}, ErrShortPrefix
	}
	var dropped Request
	err := r.update(func(d *Data) error {
		q, err := takeRequest(d, prefix, now)
		dropped = q
		return err
	})
	return dropped, err
}

// Lookup returns the registered key, if any.
func (d *Data) Lookup(pub []byte) (Key, bool) {
	enc := EncodeKey(pub)
	for _, k := range d.Keys {
		if k.PublicKey == enc {
			return k, true
		}
	}
	return Key{}, false
}

// Admits says whether a connection with pub, logged in with role, read-only
// or not, may stay.
func (d *Data) Admits(pub []byte, role Role, readOnly bool) bool {
	if readOnly {
		_, ok := d.LookupRead(pub)
		return ok && role == RoleClient
	}
	k, ok := d.Lookup(pub)
	return ok && k.Role == role
}

// LookupRead returns the client whose read-only key pub is, if any.
func (d *Data) LookupRead(pub []byte) (Key, bool) {
	enc := EncodeKey(pub)
	for _, k := range d.Keys {
		if k.ReadKey != "" && k.ReadKey == enc {
			return k, true
		}
	}
	return Key{}, false
}

// SetReadKey makes read the read-only key of the client key owner,
// replacing any earlier one. read may be no registered key, nor another
// client's read-only key.
func (r *Registry) SetReadKey(owner, read []byte) (Key, error) {
	enc, readEnc := EncodeKey(owner), EncodeKey(read)
	var changed Key
	err := r.update(func(d *Data) error {
		idx := -1
		for i, k := range d.Keys {
			if k.PublicKey == readEnc || (k.ReadKey == readEnc && k.PublicKey != enc) {
				return ErrKeyTaken
			}
			if k.PublicKey == enc {
				idx = i
			}
		}
		if idx < 0 || d.Keys[idx].Role != RoleClient {
			return ErrNotFound
		}
		d.Keys[idx].ReadKey = readEnc
		changed = d.Keys[idx]
		return nil
	})
	return changed, err
}

// Remove deletes the key whose encoding starts with prefix.
func (r *Registry) Remove(prefix string) (Key, error) {
	var removed Key
	if len(prefix) < MinKeyPrefix {
		return Key{}, ErrShortPrefix
	}
	err := r.update(func(d *Data) error {
		idx, err := byPrefix(d.Keys, prefix, func(k Key) string { return k.PublicKey }, ErrNotFound)
		if err != nil {
			return err
		}
		removed = d.Keys[idx]
		d.Keys = slices.Delete(d.Keys, idx, idx+1)
		return nil
	})
	return removed, err
}

// Rename sets the label of the key whose encoding starts with prefix.
func (r *Registry) Rename(prefix, label string) (Key, error) {
	if len(prefix) < MinKeyPrefix {
		return Key{}, ErrShortPrefix
	}
	if label == "" {
		return Key{}, ErrLabelEmpty
	}
	if len(label) > MaxLabelBytes {
		return Key{}, ErrLabelTooLong
	}
	var renamed Key
	err := r.update(func(d *Data) error {
		idx, err := byPrefix(d.Keys, prefix, func(k Key) string { return k.PublicKey }, ErrNotFound)
		if err != nil {
			return err
		}
		d.Keys[idx].Label = label
		renamed = d.Keys[idx]
		return nil
	})
	return renamed, err
}

// SetPush registers the client key pub for push with handle, replacing
// any earlier registration, or unregisters it when handle is empty.
func (r *Registry) SetPush(pub []byte, handle string) (Key, error) {
	if len(handle) > MaxPushHandleBytes {
		return Key{}, ErrHandleSize
	}
	enc := EncodeKey(pub)
	var changed Key
	err := r.update(func(d *Data) error {
		idx := slices.IndexFunc(d.Keys, func(k Key) bool { return k.PublicKey == enc })
		if idx < 0 {
			return ErrNotFound
		}
		d.Keys[idx].PushHandle = handle
		changed = d.Keys[idx]
		return nil
	})
	return changed, err
}

// ClearPush unregisters the client key pub for push if handle is still
// its registration, leaving a newer one; cleared says whether it was.
func (r *Registry) ClearPush(pub []byte, handle string) (cleared bool, err error) {
	enc := EncodeKey(pub)
	err = r.update(func(d *Data) error {
		idx := slices.IndexFunc(d.Keys, func(k Key) bool { return k.PublicKey == enc })
		if idx < 0 {
			return ErrNotFound
		}
		if d.Keys[idx].PushHandle != handle {
			return errUnchanged
		}
		d.Keys[idx].PushHandle = ""
		cleared = true
		return nil
	})
	return cleared, err
}

// Sorted returns the keys by role, then label.
func (d *Data) Sorted() []Key {
	keys := append([]Key(nil), d.Keys...)
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].Role != keys[j].Role {
			return keys[i].Role < keys[j].Role
		}
		return keys[i].Label < keys[j].Label
	})
	return keys
}
