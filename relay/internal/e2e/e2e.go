// Package e2e is the part of the end-to-end encrypted account that the
// relay checks (docs/e2e.md, section 9): the device list's chain and
// signatures, withdrawals, pre-keys, and who signed a bundle or a label
// record. It opens nothing; the relay never holds a key that would.
//
// crypto/ in TypeScript is the reference, and cases/e2e holds what both
// must decide.
package e2e

import "encoding/binary"

// Framed is how every signed string is built (docs/e2e.md, section 2,
// "Exact bytes"): the context's ASCII, a NUL byte, then each part prefixed
// by its length as an unsigned LEB128.
func Framed(context string, parts ...[]byte) []byte {
	out := append([]byte(context), 0)
	for _, p := range parts {
		out = binary.AppendUvarint(out, uint64(len(p)))
		out = append(out, p...)
	}
	return out
}
