package hosted

// Checking a version of an account's device list (docs/e2e.md, section 3)
// with Go's crypto/ed25519 and crypto/sha256. No device trusts the relay's
// check.
//
// The steps, their order and the names of results and reasons are those of
// e2e/list.ts, and on a body the phone's list maker produces (fields in
// order, each with its declared wire type, varints and lengths in their
// shortest form) the two agree but for Ed25519. Go's Ed25519 accepts three
// kinds of signature libsodium refuses: a small-order R, a small-order key,
// and a non-canonical key encoding; cases/e2e/list.json records Go's result
// for each. On such bodies Go refuses none that libsodium accepts.
//
// A body only the phone could sign in another encoding (a varint wider than
// 64 bits, a length with bits set above bit 32, a known field with another
// wire type) can give different results in different languages, Go's
// protobuf and protobuf-es reading it differently. That is by design: the
// checks defend against everyone but the phone, which is trusted.
//
// The join's check of the joining device itself (step 13) is a device's,
// not the relay's, and is not here. No input makes CheckList panic; a
// caller's mistake is an error.

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"

	"google.golang.org/protobuf/proto"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

// ListContext is the list signature's framed context.
const ListContext = "pirc-e2e-v2 list"

// The list's limits (docs/e2e.md, section 3).
const (
	ListSignatureBytes = ed25519.SignatureSize
	MaxListBytes       = 16_384
	MaxListClients     = 10
	MaxListComputers   = 50
	RoleComputer       = 1
	RoleClient         = 2
)

const (
	listKeyBytes   = 32
	counterLimit   = uint64(1) << 63
	accountIDBytes = sha256.Size
)

// ListMode is how a version is checked: version 1 (first) or any other
// (later).
type ListMode int

const (
	ListFirst ListMode = iota + 1
	ListLater
)

// ListInput is what CheckList checks.
type ListInput struct {
	// Bytes is the signed list as received: the 64-byte signature, then
	// the body.
	Bytes []byte
	// PhoneKey is the account's phone's signing key.
	PhoneKey []byte
	Mode     ListMode
	// AccountID is 32 bytes. In first mode it is optional (nil): when
	// given, version 1's body must hash to it. In later mode it is
	// required.
	AccountID []byte
	// Highest is the highest counter held, 0 if none.
	Highest uint64
}

// The results.
const (
	ListAccepted    = "accepted"
	ListOld         = "old"
	ListUnsupported = "unsupported"
	ListRefused     = "refused"
)

// ListResult is a check's result. Reason is empty for accepted and old;
// Counter and Hash are set for every result but refused; List only for
// accepted.
type ListResult struct {
	Result  string
	Reason  string
	Counter uint64
	Hash    []byte
	List    *pb.ListBody
}

// ErrListCall is a caller's mistake: an unknown mode, or an account ID
// that is not 32 bytes (or missing in later mode).
var ErrListCall = errors.New("hosted: CheckList called wrongly")

func refused(reason string) ListResult { return ListResult{Result: ListRefused, Reason: reason} }

// CheckList checks a version of the device list, in e2e/list.ts's order.
func CheckList(in ListInput) (ListResult, error) {
	switch in.Mode {
	case ListFirst:
		if in.AccountID != nil && len(in.AccountID) != accountIDBytes {
			return ListResult{}, ErrListCall
		}
	case ListLater:
		if len(in.AccountID) != accountIDBytes {
			return ListResult{}, ErrListCall
		}
	default:
		return ListResult{}, ErrListCall
	}

	// 1. Size, before anything is read.
	if len(in.Bytes) < ListSignatureBytes || len(in.Bytes) > MaxListBytes {
		return refused("size"), nil
	}
	// proto.Unmarshal copies bytes fields, so the list returned shares
	// nothing with in.Bytes.
	sig, body := in.Bytes[:ListSignatureBytes], in.Bytes[ListSignatureBytes:]

	// 2. The signature, over the body as received; only then the parse.
	var signedID []byte
	if in.Mode == ListLater {
		signedID = in.AccountID
	}
	if len(in.PhoneKey) != ed25519.PublicKeySize || !ed25519.Verify(in.PhoneKey, framed(ListContext, signedID, body), sig) {
		return refused("signature"), nil
	}
	list := &pb.ListBody{}
	if err := proto.Unmarshal(body, list); err != nil {
		return refused("parse"), nil
	}
	counter := list.GetCounter()
	sum := sha256.Sum256(body)
	hash := sum[:]

	// 3. The counter's range, before it is compared with anything.
	if counter >= counterLimit {
		return refused("range"), nil
	}

	// 4. The mode and the body agree.
	if in.Mode == ListFirst {
		if counter != 1 || len(list.GetAccountId()) != 0 || len(list.GetPreviousHash()) != 0 || (in.AccountID != nil && !bytes.Equal(hash, in.AccountID)) {
			return refused("mode"), nil
		}
	} else if counter < 2 || !bytes.Equal(list.GetAccountId(), in.AccountID) || len(list.GetPreviousHash()) != listKeyBytes {
		return refused("mode"), nil
	}

	// 5. Newer than what is held.
	if counter <= in.Highest {
		return ListResult{Result: ListOld, Counter: counter, Hash: hash}, nil
	}
	unsupported := func(reason string) (ListResult, error) {
		return ListResult{Result: ListUnsupported, Reason: reason, Counter: counter, Hash: hash}, nil
	}
	devices := list.GetDevices()

	// 6. No unknown field, in the body or in any device.
	if len(list.ProtoReflect().GetUnknown()) > 0 {
		return unsupported("unknown-field")
	}
	for _, d := range devices {
		if len(d.ProtoReflect().GetUnknown()) > 0 {
			return unsupported("unknown-field")
		}
	}

	// 7. Roles.
	for _, d := range devices {
		if r := d.GetRole(); r != RoleComputer && r != RoleClient {
			return unsupported("role")
		}
	}

	// 8. The three keys every device has.
	for _, d := range devices {
		if len(d.GetSigningKey()) != listKeyBytes || len(d.GetChannelKey()) != listKeyBytes || len(d.GetBoxKey()) != listKeyBytes {
			return unsupported("key")
		}
	}

	// 9. A phone's two keys: both or neither, and only on a client.
	for _, d := range devices {
		r, n := len(d.GetReadOnlyKey()), len(d.GetNotificationKey())
		both := r == listKeyBytes && n == listKeyBytes
		neither := r == 0 && n == 0
		if !(both || neither) || (both && d.GetRole() != RoleClient) {
			return unsupported("phone-keys")
		}
	}

	// 10. No public key twice, across devices and kinds.
	seen := map[string]bool{}
	for _, d := range devices {
		for _, k := range [][]byte{d.GetSigningKey(), d.GetChannelKey(), d.GetBoxKey(), d.GetReadOnlyKey(), d.GetNotificationKey()} {
			if len(k) == 0 {
				continue
			}
			h := hex.EncodeToString(k)
			if seen[h] {
				return unsupported("duplicate-key")
			}
			seen[h] = true
		}
	}

	// 11. How many.
	clients := 0
	for _, d := range devices {
		if d.GetRole() == RoleClient {
			clients++
		}
	}
	computers := len(devices) - clients
	if len(devices) == 0 || clients > MaxListClients || computers > MaxListComputers || (in.Mode == ListFirst && len(devices) != 1) {
		return unsupported("count")
	}

	// 12. The pinned phone, as a client with its phone keys.
	var phone *pb.Device
	for _, d := range devices {
		if bytes.Equal(d.GetSigningKey(), in.PhoneKey) {
			phone = d
			break
		}
	}
	if phone == nil || phone.GetRole() != RoleClient || len(phone.GetReadOnlyKey()) != listKeyBytes {
		return unsupported("phone")
	}

	return ListResult{Result: ListAccepted, Counter: counter, Hash: hash, List: list}, nil
}
