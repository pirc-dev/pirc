package hosted

// cases/e2e/list.json and framed.json against CheckList and framed: every
// case needing only the parts the relay has. The relay has first mode; it
// has no join check of its own (self) and makes no lists (make-list).

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

var (
	relayHas   = map[string]bool{"first-mode": true}
	relayLacks = map[string]bool{"self": true, "make-list": true}
)

type deviceJSON struct {
	Role            uint32 `json:"role"`
	SigningKey      string `json:"signingKey"`
	ChannelKey      string `json:"channelKey"`
	BoxKey          string `json:"boxKey"`
	ReadOnlyKey     string `json:"readOnlyKey"`
	NotificationKey string `json:"notificationKey"`
}

type listJSON struct {
	AccountID    string       `json:"accountId"`
	Counter      string       `json:"counter"`
	PreviousHash string       `json:"previousHash"`
	Devices      []deviceJSON `json:"devices"`
}

type expectJSON struct {
	Result  string    `json:"result"`
	Reason  string    `json:"reason"`
	Counter string    `json:"counter"`
	Hash    string    `json:"hash"`
	List    *listJSON `json:"list"`
	Throws  bool      `json:"throws"`
}

type listCase struct {
	Check     string      `json:"check"`
	About     string      `json:"about"`
	Needs     []string    `json:"needs"`
	Bytes     string      `json:"bytes"`
	PhoneKey  string      `json:"phoneKey"`
	Mode      string      `json:"mode"`
	AccountID *string     `json:"accountId"`
	Highest   string      `json:"highest"`
	Expect    expectJSON  `json:"expect"`
	Go        *expectJSON `json:"go"`
	Key       string      `json:"key"`
	Message   string      `json:"message"`
	Signature string      `json:"signature"`
	Valid     bool        `json:"valid"`
	// Read only to check the file's shape: the relay has neither.
	Self         *deviceJSON  `json:"self"`
	Seed         string       `json:"seed"`
	Counter      string       `json:"counter"`
	PreviousBody string       `json:"previousBody"`
	Devices      []deviceJSON `json:"devices"`
}

type framedCase struct {
	Check   string   `json:"check"`
	About   string   `json:"about"`
	Needs   []string `json:"needs"`
	Context string   `json:"context"`
	Parts   []string `json:"parts"`
	Value   string   `json:"value"`
	Bytes   string   `json:"bytes"`
	Throws  bool     `json:"throws"`
}

// caseShape is what each check's cases hold: every key in required,
// exactly one of oneOf when it is given, any of optional, and nothing else.
type caseShape struct {
	required []string
	optional []string
	oneOf    []string
}

// caseKeyTypes is each key's JSON type, by its first byte; null is none
// of them.
var caseKeyTypes = map[string]byte{
	"check": '"', "about": '"', "context": '"', "value": '"', "bytes": '"', "phoneKey": '"', "mode": '"',
	"highest": '"', "accountId": '"', "seed": '"', "counter": '"', "previousBody": '"', "key": '"',
	"message": '"', "signature": '"',
	"needs": '[', "parts": '[', "devices": '[',
	"expect": '{', "go": '{', "self": '{',
	"valid": 'b', "throws": 'b',
}

func jsonTypeIs(raw json.RawMessage, want byte) bool {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return false
	}
	if want == 'b' {
		return string(raw) == "true" || string(raw) == "false"
	}
	return raw[0] == want
}

var caseShapes = map[string]caseShape{
	"framed":    {required: []string{"check", "about", "needs", "context", "parts"}, oneOf: []string{"bytes", "throws"}},
	"number":    {required: []string{"check", "about", "needs", "value"}, oneOf: []string{"bytes", "throws"}},
	"list":      {required: []string{"check", "about", "needs", "bytes", "phoneKey", "mode", "highest", "expect"}, optional: []string{"accountId", "self", "go"}},
	"make-list": {required: []string{"check", "about", "needs", "seed", "accountId", "counter", "previousBody", "devices", "bytes"}},
	"verify":    {required: []string{"check", "about", "needs", "key", "message", "signature", "valid"}},
}

func strictDecode(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("data after the value")
	}
	return nil
}

// readCases reads a file of cases/e2e strictly: no unknown key anywhere,
// every key a case's check needs present, and at least one case.
func readCases[C any](t *testing.T, name string) []C {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "cases", "e2e", name))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		About *string           `json:"about"`
		Cases []json.RawMessage `json:"cases"`
	}
	if err := strictDecode(data, &f); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	if f.About == nil || len(f.Cases) == 0 {
		t.Fatalf("%s: no about, or no cases", name)
	}
	out := make([]C, len(f.Cases))
	for i, raw := range f.Cases {
		var keys map[string]json.RawMessage
		if err := json.Unmarshal(raw, &keys); err != nil {
			t.Fatalf("%s, case %d: %v", name, i, err)
		}
		var check string
		_ = json.Unmarshal(keys["check"], &check)
		shape, ok := caseShapes[check]
		if !ok {
			t.Fatalf("%s, case %d: unknown check %q", name, i, check)
		}
		for _, k := range shape.required {
			if _, ok := keys[k]; !ok {
				t.Fatalf("%s, case %d (%s): no %q", name, i, check, k)
			}
		}
		allowed := map[string]bool{}
		for _, ks := range [][]string{shape.required, shape.optional, shape.oneOf} {
			for _, k := range ks {
				allowed[k] = true
			}
		}
		for k, v := range keys {
			if !allowed[k] {
				t.Fatalf("%s, case %d (%s): key %q is not a %s case's", name, i, check, k, check)
			}
			if !jsonTypeIs(v, caseKeyTypes[k]) {
				t.Fatalf("%s, case %d (%s): %q is %s", name, i, check, k, v)
			}
		}
		if len(shape.oneOf) > 0 {
			n := 0
			for _, k := range shape.oneOf {
				if _, ok := keys[k]; ok {
					n++
				}
			}
			if n != 1 {
				t.Fatalf("%s, case %d (%s): not exactly one of %v", name, i, check, shape.oneOf)
			}
		}
		for _, k := range []string{"expect", "go"} {
			if e, ok := keys[k]; ok {
				var ek map[string]json.RawMessage
				if err := json.Unmarshal(e, &ek); err != nil {
					t.Fatalf("%s, case %d: %s: %v", name, i, k, err)
				}
				_, result := ek["result"]
				_, throws := ek["throws"]
				if result == throws {
					t.Fatalf("%s, case %d: %s has not exactly one of result and throws", name, i, k)
				}
			}
		}
		if err := strictDecode(raw, &out[i]); err != nil {
			t.Fatalf("%s, case %d: %v", name, i, err)
		}
	}
	return out
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func has(needs []string, n string) bool {
	for _, m := range needs {
		if m == n {
			return true
		}
	}
	return false
}

func needsOnly(needs []string) bool {
	for _, n := range needs {
		if !relayHas[n] {
			return false
		}
	}
	return true
}

func gotJSON(r ListResult) expectJSON {
	e := expectJSON{Result: r.Result, Reason: r.Reason}
	if r.Result == ListRefused {
		return e
	}
	e.Counter = strconv.FormatUint(r.Counter, 10)
	e.Hash = hex.EncodeToString(r.Hash)
	if r.List != nil {
		l := &listJSON{
			AccountID:    hex.EncodeToString(r.List.GetAccountId()),
			Counter:      strconv.FormatUint(r.List.GetCounter(), 10),
			PreviousHash: hex.EncodeToString(r.List.GetPreviousHash()),
			Devices:      []deviceJSON{},
		}
		for _, d := range r.List.GetDevices() {
			l.Devices = append(l.Devices, deviceJSON{
				Role:            d.GetRole(),
				SigningKey:      hex.EncodeToString(d.GetSigningKey()),
				ChannelKey:      hex.EncodeToString(d.GetChannelKey()),
				BoxKey:          hex.EncodeToString(d.GetBoxKey()),
				ReadOnlyKey:     hex.EncodeToString(d.GetReadOnlyKey()),
				NotificationKey: hex.EncodeToString(d.GetNotificationKey()),
			})
		}
		e.List = l
	}
	return e
}

func TestListCases(t *testing.T) {
	cases := readCases[listCase](t, "list.json")
	ran, left := 0, 0
	for _, c := range cases {
		for _, n := range c.Needs {
			if !relayHas[n] && !relayLacks[n] {
				t.Fatalf("%s: unknown need %q", c.About, n)
			}
		}
		if c.Check != "list" && c.Check != "verify" && c.Check != "make-list" {
			t.Fatalf("%s: unknown check %q", c.About, c.Check)
		}
		// Each need the relay lacks is tied to what makes the case need it.
		if has(c.Needs, "self") != (c.Self != nil) {
			t.Fatalf("%s: needs self without a self, or the reverse", c.About)
		}
		if has(c.Needs, "make-list") != (c.Check == "make-list") {
			t.Fatalf("%s: needs make-list without being a make-list case, or the reverse", c.About)
		}
		if !needsOnly(c.Needs) {
			left++
			continue
		}
		if c.Check == "make-list" {
			t.Fatalf("%s: a make-list case without the make-list need", c.About)
		}
		ran++
		if c.Check == "verify" {
			if got := ed25519.Verify(unhex(t, c.Key), unhex(t, c.Message), unhex(t, c.Signature)); got != c.Valid {
				t.Errorf("%s: verify = %v, want %v", c.About, got, c.Valid)
			}
			continue
		}
		in := ListInput{Bytes: unhex(t, c.Bytes), PhoneKey: unhex(t, c.PhoneKey)}
		switch c.Mode {
		case "first":
			in.Mode = ListFirst
		case "later":
			in.Mode = ListLater
		default:
			t.Fatalf("%s: unknown mode %q", c.About, c.Mode)
		}
		if c.AccountID != nil {
			in.AccountID = unhex(t, *c.AccountID)
		}
		h, err := strconv.ParseUint(c.Highest, 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		in.Highest = h
		r, err := CheckList(in)
		if err != nil {
			t.Errorf("%s: %v", c.About, err)
			continue
		}
		got := gotJSON(r)
		want := c.Expect
		if c.Go != nil {
			want = *c.Go
		}
		// Where Go's result differs, the file gives no list; Go's accepted
		// result must hold one all the same.
		if c.Go != nil {
			if got.List == nil {
				t.Errorf("%s: no list", c.About)
			}
			got.List = nil
		}
		gj, _ := json.Marshal(got)
		wj, _ := json.Marshal(want)
		if !bytes.Equal(gj, wj) {
			t.Errorf("%s:\n got %s\nwant %s", c.About, gj, wj)
		}
		// Go refuses none of these bodies that libsodium accepts.
		if c.Expect.Result == ListAccepted && r.Result != ListAccepted {
			t.Errorf("%s: libsodium accepts, Go gives %s %s", c.About, r.Result, r.Reason)
		}
	}
	// Every case left out needs self or make-list: an unknown need fails above.
	t.Logf("ran %d of %d list.json cases; %d need self or make-list", ran, len(cases), left)
	if ran == 0 || ran+left != len(cases) {
		t.Errorf("ran %d and left out %d of %d cases", ran, left, len(cases))
	}
}

func TestListCallerMistakes(t *testing.T) {
	ok := make([]byte, 32)
	for _, in := range []ListInput{
		{Bytes: make([]byte, 100), PhoneKey: ok},
		{Bytes: make([]byte, 100), PhoneKey: ok, Mode: ListLater},
		{Bytes: make([]byte, 100), PhoneKey: ok, Mode: ListLater, AccountID: make([]byte, 31)},
		{Bytes: make([]byte, 100), PhoneKey: ok, Mode: ListFirst, AccountID: []byte{}},
	} {
		if _, err := CheckList(in); !errors.Is(err, ErrListCall) {
			t.Errorf("%+v: no error", in)
		}
	}
	for _, key := range [][]byte{nil, make([]byte, 31), make([]byte, 33)} {
		r, err := CheckList(ListInput{Bytes: make([]byte, 100), PhoneKey: key, Mode: ListFirst})
		if err != nil || r.Result != ListRefused || r.Reason != "signature" {
			t.Errorf("phone key of %d bytes: %+v, %v", len(key), r, err)
		}
	}
}

// panics reports whether f panics.
func panics(f func()) (p bool) {
	defer func() { p = recover() != nil }()
	f()
	return false
}

func TestFramedCases(t *testing.T) {
	cases := readCases[framedCase](t, "framed.json")
	ran, left := 0, 0
	for _, c := range cases {
		for _, n := range c.Needs {
			if !relayHas[n] && !relayLacks[n] {
				t.Fatalf("%s: unknown need %q", c.About, n)
			}
		}
		if !needsOnly(c.Needs) {
			left++
			continue
		}
		var run func() []byte
		switch c.Check {
		case "framed":
			parts := make([][]byte, len(c.Parts))
			for i, p := range c.Parts {
				parts[i] = unhex(t, p)
			}
			run = func() []byte { return framed(c.Context, parts...) }
		case "number":
			v, err := strconv.ParseUint(c.Value, 10, 64)
			if err != nil {
				t.Fatal(err)
			}
			run = func() []byte { return framedNumber(v) }
		default:
			continue
		}
		ran++
		if c.Throws {
			if !panics(func() { run() }) {
				t.Errorf("%s: no panic", c.About)
			}
		} else if got := hex.EncodeToString(run()); got != c.Bytes {
			t.Errorf("%s: %s", c.About, got)
		}
	}
	if ran == 0 || ran+left != len(cases) {
		t.Errorf("ran %d and left out %d of %d framed.json cases", ran, left, len(cases))
	}
}

func TestContextsPassTheRule(t *testing.T) {
	for _, c := range []string{AuthContext, AttestContext, ListContext} {
		if panics(func() { framed(c) }) {
			t.Errorf("%q is refused", c)
		}
	}
}
