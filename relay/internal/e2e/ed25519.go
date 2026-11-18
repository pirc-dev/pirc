// Ed25519, verified strictly and alike on every platform (docs/e2e.md,
// section 2): byte checks first, then the standard library's verify, which
// computes the cofactorless equation. crypto/ed25519 accepts a
// non-canonical public key; the checks are what refuse it.

package e2e

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
)

// The group order L and the field prime p, little-endian.
var (
	orderL = unhex("edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010")
	primeP = unhex("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f")
)

// Every encoding of a small-order point once y < p is checked: the eight
// canonical ones, and the two with x = 0 and the sign bit set.
var smallOrder = [][]byte{
	unhex("0100000000000000000000000000000000000000000000000000000000000000"),
	unhex("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
	unhex("0000000000000000000000000000000000000000000000000000000000000000"),
	unhex("0000000000000000000000000000000000000000000000000000000000000080"),
	unhex("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05"),
	unhex("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85"),
	unhex("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"),
	unhex("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa"),
	unhex("0100000000000000000000000000000000000000000000000000000000000080"),
	unhex("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
}

func unhex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

// lessLE is a < b, both 32 bytes little-endian.
func lessLE(a, b []byte) bool {
	for i := 31; i >= 0; i-- {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

// pointOK is whether b encodes y below p and is not a small-order point.
func pointOK(b []byte) bool {
	y := bytes.Clone(b)
	y[31] &= 0x7f
	if !lessLE(y, primeP) {
		return false
	}
	for _, s := range smallOrder {
		if bytes.Equal(b, s) {
			return false
		}
	}
	return true
}

// precheck is whether the signature may go to ed25519.Verify.
func precheck(publicKey, sig []byte) bool {
	return len(publicKey) == ed25519.PublicKeySize && len(sig) == ed25519.SignatureSize &&
		lessLE(sig[32:], orderL) && pointOK(publicKey) && pointOK(sig[:32])
}

// Verify is PiRC's Ed25519 rule: the byte checks, then the cofactorless
// equation.
func Verify(publicKey, message, sig []byte) bool {
	return precheck(publicKey, sig) && ed25519.Verify(ed25519.PublicKey(publicKey), message, sig)
}
