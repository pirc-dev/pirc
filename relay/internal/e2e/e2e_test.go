// The vectors in cases/e2e that the relay's checks must decide, read as
// crypto/test/objects.test.ts reads them. HPKE, CPace, the bundle's
// unwraps, frames, the envelope, labels' contents and the join are the
// devices' work, not the relay's, and are not checked here.

package e2e

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

func load(t *testing.T, name string, v any) {
	b, err := os.ReadFile("../../../cases/e2e/" + name)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatal(err)
	}
}

func dehex(t *testing.T, s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestEd25519Vectors(t *testing.T) {
	var file struct {
		Vectors []struct {
			Name      string
			PublicKey string `json:"public_key"`
			Message   string
			Signature string
			Valid     bool
		}
	}
	load(t, "ed25519.json", &file)
	if len(file.Vectors) == 0 {
		t.Fatal("no vectors")
	}
	for _, v := range file.Vectors {
		got := Verify(dehex(t, v.PublicKey), dehex(t, v.Message), dehex(t, v.Signature))
		if got != v.Valid {
			t.Errorf("%s: got %v, want %v", v.Name, got, v.Valid)
		}
	}
}

// objectsFile is cases/e2e/objects.json, as far as the relay reads it.
type objectsFile struct {
	AccountID string `json:"account_id"`
	NowMs     int64  `json:"now_ms,string"`
	Framed    []struct {
		Context string
		Parts   []string
		Out     string
	}
	Checks []struct {
		Check, Prev, Object, About string
		Valid                      bool
	}
	Refused []struct {
		About, Kind, Encoded string
		AccountID            string `json:"account_id"`
	}
	Objects map[string]struct {
		Kind      string
		AccountID string `json:"account_id"`
		JSON      json.RawMessage
		Body      string
		Signer    string
		Signature string
		Hash      string
		Encoded   string
	}
}

func loadObjects(t *testing.T) *objectsFile {
	var f objectsFile
	load(t, "objects.json", &f)
	if len(f.Objects) == 0 || len(f.Checks) == 0 || len(f.Framed) == 0 {
		t.Fatal("objects.json is missing a section")
	}
	return &f
}

func (f *objectsFile) object(t *testing.T, name string) *pb.SignedObject {
	o, ok := f.Objects[name]
	if !ok {
		t.Fatalf("no object %q", name)
	}
	var obj pb.SignedObject
	if err := proto.Unmarshal(dehex(t, o.Encoded), &obj); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return &obj
}

// Every object in refused is refused by the relay as it decodes it,
// though its signature checks.
func TestRefused(t *testing.T) {
	f := loadObjects(t)
	if len(f.Refused) == 0 {
		t.Fatal("objects.json has no refused objects")
	}
	for _, r := range f.Refused {
		var obj pb.SignedObject
		if err := proto.Unmarshal(dehex(t, r.Encoded), &obj); err != nil {
			t.Fatalf("%s: %v", r.About, err)
		}
		acct := dehex(t, r.AccountID)
		if !Verify(obj.Signer, Framed("pirc-e2e-v1 "+r.Kind, acct, obj.Body), obj.Signature) {
			t.Errorf("%s: the signature does not check", r.About)
		}
		var err error
		switch r.Kind {
		case "bundle":
			_, err = OpenBundle(acct, &obj)
		default:
			t.Fatalf("%s: no opener for %q", r.About, r.Kind)
		}
		if err == nil {
			t.Errorf("%s: opened", r.About)
		}
	}
}

func TestFramed(t *testing.T) {
	f := loadObjects(t)
	for _, c := range f.Framed {
		var parts [][]byte
		for _, p := range c.Parts {
			parts = append(parts, dehex(t, p))
		}
		if got := hex.EncodeToString(Framed(c.Context, parts...)); got != c.Out {
			t.Errorf("%q: got %s, want %s", c.Context, got, c.Out)
		}
	}
}

// bodies holds every kind's body message, the relay's and the rest, so
// that each body's encoding and signature is checked.
var bodies = map[string]func() proto.Message{
	"list":         func() proto.Message { return &pb.ListVersionBody{} },
	"withdrawal":   func() proto.Message { return &pb.WithdrawalBody{} },
	"pre-key":      func() proto.Message { return &pb.PreKeyBody{} },
	"label-key":    func() proto.Message { return &pb.LabelKeyWrapBody{} },
	"labels":       func() proto.Message { return &pb.LabelsBody{} },
	"bundle":       func() proto.Message { return &pb.BundleBody{} },
	"announcement": func() proto.Message { return &pb.AnnouncementBody{} },
	"request":      func() proto.Message { return &pb.EnvelopeBody{} },
	"join":         func() proto.Message { return &pb.JoinDeviceBody{} },
}

// badSignatures are the objects whose signature is meant not to check.
var badSignatures = map[string]bool{"x-bad-signature": true}

func TestObjects(t *testing.T) {
	f := loadObjects(t)
	for name, o := range f.Objects {
		newBody, ok := bodies[o.Kind]
		if !ok {
			t.Errorf("%s: unknown kind %q", name, o.Kind)
			continue
		}
		body := newBody()
		if err := protojson.Unmarshal(o.JSON, body); err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		enc, err := proto.MarshalOptions{Deterministic: true}.Marshal(body)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if got := hex.EncodeToString(enc); got != o.Body {
			t.Errorf("%s: encoded\n%s\nwant\n%s", name, got, o.Body)
		}
		obj := f.object(t, name)
		if hex.EncodeToString(obj.GetBody()) != o.Body || hex.EncodeToString(obj.GetSigner()) != o.Signer ||
			hex.EncodeToString(obj.GetSignature()) != o.Signature {
			t.Errorf("%s: encoded object does not hold its body, signer and signature", name)
		}
		if got := hex.EncodeToString(Hash(obj)); got != o.Hash {
			t.Errorf("%s: hash %s, want %s", name, got, o.Hash)
		}
		ok = Verify(obj.GetSigner(), signedBytes(o.Kind, dehex(t, o.AccountID), obj.GetBody()), obj.GetSignature())
		if ok == badSignatures[name] {
			t.Errorf("%s: signature checks: %v", name, ok)
		}
	}
}

func TestChecks(t *testing.T) {
	f := loadObjects(t)
	account := dehex(t, f.AccountID)
	must := func(v *Version, err error) *Version {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	V := map[string]*Version{}
	V["v1"] = must(CheckFirst(f.object(t, "v1")))
	V["v2"] = must(CheckNext(account, V["v1"], f.object(t, "v2")))
	V["v3"] = must(CheckNext(account, V["v2"], f.object(t, "v3")))
	V["v4a"] = must(CheckNext(account, V["v3"], f.object(t, "v4a")))
	V["v4b"] = must(CheckNext(account, V["v3"], f.object(t, "v4b")))
	if hex.EncodeToString(V["v1"].Hash) != f.AccountID {
		t.Error("version 1's hash is not the account ID")
	}
	for _, c := range f.Checks {
		obj := f.object(t, c.Object)
		var err error
		switch c.Check {
		case "first":
			_, err = CheckFirst(obj)
		case "next":
			_, err = CheckNext(account, V[c.Prev], obj)
		case "withdrawal":
			_, err = CheckWithdrawal(account, V[c.Prev], obj)
		case "pre-key":
			_, err = CheckPreKey(account, V[c.Prev].Body, obj, f.NowMs)
		default:
			t.Fatalf("unknown check %q", c.Check)
		}
		var refused *Refused
		if err != nil && !errors.As(err, &refused) {
			t.Fatalf("%s: not a refusal: %v", c.About, err)
		}
		if valid := err == nil; valid != c.Valid {
			t.Errorf("%s (%s): valid %v, want %v: %v", c.About, c.Object, valid, c.Valid, err)
		}
	}
}

// The other kinds the relay opens: whose they are, and what it reads.
func TestOpenRelayKinds(t *testing.T) {
	f := loadObjects(t)
	account := dehex(t, f.AccountID)
	signer := func(name string) string { return f.Objects[name].Signer }
	b, err := OpenBundle(account, f.object(t, "bundle"))
	if err != nil || hex.EncodeToString(b.GetHostKey()) != signer("bundle") || len(b.GetKeyId()) != 16 {
		t.Fatalf("bundle: %v", err)
	}
	if _, err := OpenLabels(account, f.object(t, "labels")); err != nil {
		t.Fatalf("labels: %v", err)
	}
	for _, name := range []string{"label-key-tablet", "label-key-phone-read"} {
		if _, err := OpenLabelKey(account, f.object(t, name)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	// Opened as another kind, or for another account, nothing opens.
	if _, err := OpenLabels(account, f.object(t, "bundle")); err == nil {
		t.Error("a bundle opened as labels")
	}
	if _, err := OpenBundle(bytes.Repeat([]byte{9}, 32), f.object(t, "bundle")); err == nil {
		t.Error("a bundle opened for another account")
	}
}
