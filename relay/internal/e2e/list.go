// The account's device list (docs/e2e.md, section 3): checking a version
// against the one before it, a withdrawal against the version it
// withdraws, and a pre-key against the list. Pure, so that the relay, the
// hosts and the clients decide alike.

package e2e

import (
	"bytes"
	"math"
	"math/big"

	"google.golang.org/protobuf/types/known/timestamppb"

	pb "pirc.dev/relay/internal/pb/pirc/v1alpha2"
)

// Version is a list version that passed its checks.
type Version struct {
	Body   *pb.ListVersionBody
	Hash   []byte
	Object *pb.SignedObject
}

const maxDevices = 256

// PreKeyMaxMillis is the longest a pre-key may live: 14 days.
const PreKeyMaxMillis = 14 * 24 * 3600 * 1000

// millis is t in whole milliseconds, -1 if it is absent: what the
// TypeScript compares. Big, as a timestamp's seconds times 1000 can
// overflow an int64.
func millis(t *timestamppb.Timestamp) *big.Int {
	if t == nil {
		return big.NewInt(-1)
	}
	ms := big.NewInt(t.Seconds)
	ms.Mul(ms, big.NewInt(1000))
	n := int64(t.Nanos)
	q := n / 1e6
	if n%1e6 < 0 {
		q-- // floor, not truncation
	}
	return ms.Add(ms, big.NewInt(q))
}

// Device is the device on v with the key, or nil.
func Device(v *pb.ListVersionBody, key []byte) *pb.Device {
	for _, d := range v.GetDevices() {
		if bytes.Equal(d.GetPublicKey(), key) {
			return d
		}
	}
	return nil
}

// IsClient is whether the key is a client on v.
func IsClient(v *pb.ListVersionBody, key []byte) bool {
	d := Device(v, key)
	return d != nil && d.GetRole() == pb.DeviceRole_DEVICE_ROLE_CLIENT
}

// checkShape is what every version must be on its own.
func checkShape(v *pb.ListVersionBody) error {
	devices := v.GetDevices()
	if len(devices) == 0 || len(devices) > maxDevices {
		return refuse("wrong number of devices")
	}
	hasClient := false
	for i, d := range devices {
		if len(d.GetPublicKey()) != 32 {
			return refuse("a device key is not 32 bytes")
		}
		switch d.GetRole() {
		case pb.DeviceRole_DEVICE_ROLE_HOST, pb.DeviceRole_DEVICE_ROLE_CLIENT, pb.DeviceRole_DEVICE_ROLE_READ_ONLY:
		default:
			return refuse("a device has no role")
		}
		if i > 0 && bytes.Compare(devices[i-1].GetPublicKey(), d.GetPublicKey()) >= 0 {
			return refuse("devices not in order, or repeated")
		}
		if d.GetAddedAt() == nil {
			return refuse("a device has no time added")
		}
		if d.GetRole() == pb.DeviceRole_DEVICE_ROLE_READ_ONLY {
			if !IsClient(v, d.GetOwner()) {
				return refuse("a read-only key whose client is not on the list")
			}
		} else if len(d.GetOwner()) > 0 {
			return refuse("an owner on a device that is not a read-only key")
		}
		hasClient = hasClient || d.GetRole() == pb.DeviceRole_DEVICE_ROLE_CLIENT
	}
	if !hasClient {
		return refuse("no client left")
	}
	for _, h := range v.GetWithdrawn() {
		if len(h) != 32 {
			return refuse("a withdrawn hash is not 32 bytes")
		}
	}
	return nil
}

// CheckFirst checks version 1: its body's hash is the account ID; it holds
// one client, which signs it.
func CheckFirst(obj *pb.SignedObject) (*Version, error) {
	body, err := OpenList(nil, obj)
	if err != nil {
		return nil, err
	}
	if body.GetNumber() != 1 || len(body.GetPrevious()) > 0 {
		return nil, refuse("not version 1")
	}
	if err := checkShape(body); err != nil {
		return nil, err
	}
	d := body.GetDevices()[0]
	if len(body.GetDevices()) != 1 || d.GetRole() != pb.DeviceRole_DEVICE_ROLE_CLIENT {
		return nil, refuse("version 1 holds one client")
	}
	if !bytes.Equal(d.GetPublicKey(), body.GetSigner()) || len(d.GetAddedBy()) > 0 {
		return nil, refuse("version 1 is signed by its one device")
	}
	if len(body.GetWithdrawn()) > 0 {
		return nil, refuse("version 1 withdraws nothing")
	}
	return &Version{body, Hash(obj), obj}, nil
}

// CheckNext checks a version after prev: chained, signed by a client in
// prev, changing devices only as a client may.
func CheckNext(accountID []byte, prev *Version, obj *pb.SignedObject) (*Version, error) {
	body, err := OpenList(accountID, obj)
	if err != nil {
		return nil, err
	}
	// The TypeScript's numbers do not wrap; at the last uint64 there is no next.
	if prev.Body.GetNumber() == math.MaxUint64 || body.GetNumber() != prev.Body.GetNumber()+1 {
		return nil, refuse("not the next number")
	}
	if !bytes.Equal(body.GetPrevious(), prev.Hash) {
		return nil, refuse("does not chain from the version before")
	}
	if !IsClient(prev.Body, body.GetSigner()) {
		return nil, refuse("not signed by a client in the version before")
	}
	if err := checkShape(body); err != nil {
		return nil, err
	}
	for _, d := range body.GetDevices() {
		if before := Device(prev.Body, d.GetPublicKey()); before != nil {
			if before.GetRole() != d.GetRole() || !bytes.Equal(before.GetAddedBy(), d.GetAddedBy()) ||
				!bytes.Equal(before.GetOwner(), d.GetOwner()) || millis(before.GetAddedAt()).Cmp(millis(d.GetAddedAt())) != 0 {
				return nil, refuse("a device kept but changed")
			}
		} else {
			if !bytes.Equal(d.GetAddedBy(), body.GetSigner()) {
				return nil, refuse("a new device not added by the signer")
			}
			if d.GetRole() == pb.DeviceRole_DEVICE_ROLE_READ_ONLY && !bytes.Equal(d.GetOwner(), body.GetSigner()) {
				return nil, refuse("a read-only key added by another client than its own")
			}
		}
	}
	for _, h := range prev.Body.GetWithdrawn() {
		if !containsBytes(body.GetWithdrawn(), h) {
			return nil, refuse("a withdrawal dropped")
		}
	}
	return &Version{body, Hash(obj), obj}, nil
}

func containsBytes(list [][]byte, b []byte) bool {
	for _, x := range list {
		if bytes.Equal(x, b) {
			return true
		}
	}
	return false
}

// CheckWithdrawal checks a withdrawal of withdrawn, by its own signer, in
// favour of another version with its number.
func CheckWithdrawal(accountID []byte, withdrawn *Version, obj *pb.SignedObject) (*pb.WithdrawalBody, error) {
	body, err := OpenWithdrawal(accountID, obj)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(body.GetSigner(), withdrawn.Body.GetSigner()) {
		return nil, refuse("not withdrawn by its own signer")
	}
	w, win := body.GetWithdrawn(), body.GetWinner()
	if w == nil || win == nil || w.GetNumber() != withdrawn.Body.GetNumber() || !bytes.Equal(w.GetHash(), withdrawn.Hash) {
		return nil, refuse("names another version")
	}
	if win.GetNumber() != w.GetNumber() || len(win.GetHash()) != 32 || bytes.Equal(win.GetHash(), w.GetHash()) {
		return nil, refuse("the winner is not another version with its number")
	}
	return body, nil
}

// CheckPreKey checks a pre-key of a client or a read-only key on list,
// current at nowMillis.
func CheckPreKey(accountID []byte, list *pb.ListVersionBody, obj *pb.SignedObject, nowMillis int64) (*pb.PreKeyBody, error) {
	body, err := OpenPreKey(accountID, obj)
	if err != nil {
		return nil, err
	}
	switch Device(list, body.GetSigner()).GetRole() {
	case pb.DeviceRole_DEVICE_ROLE_CLIENT, pb.DeviceRole_DEVICE_ROLE_READ_ONLY:
	default:
		return nil, refuse("not a client's or a read-only key's")
	}
	if len(body.GetPreKey()) != 32 {
		return nil, refuse("the pre-key is not 32 bytes")
	}
	made, expires := millis(body.GetMadeAt()), millis(body.GetExpiresAt())
	life := new(big.Int).Sub(expires, made)
	if made.Sign() < 0 || expires.Cmp(made) <= 0 || life.Cmp(big.NewInt(PreKeyMaxMillis)) > 0 {
		return nil, refuse("lives longer than 14 days")
	}
	if big.NewInt(nowMillis).Cmp(expires) >= 0 {
		return nil, refuse("expired")
	}
	return body, nil
}
