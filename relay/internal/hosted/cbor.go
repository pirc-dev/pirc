package hosted

// Enough CBOR (RFC 8949) to read an App Attest attestation object: maps,
// arrays, byte and text strings and unsigned integers, all of definite
// length. Anything else is refused.

import (
	"encoding/binary"
	"errors"
	"fmt"
)

var errCBOR = errors.New("malformed CBOR")

// cborDecode reads one item and requires that it is all of b.
func cborDecode(b []byte) (any, error) {
	v, rest, err := cborItem(b, 0)
	if err != nil {
		return nil, err
	}
	if len(rest) != 0 {
		return nil, fmt.Errorf("%w: %d bytes after the item", errCBOR, len(rest))
	}
	return v, nil
}

func cborItem(b []byte, depth int) (any, []byte, error) {
	if depth > 8 || len(b) == 0 {
		return nil, nil, errCBOR
	}
	major, info := b[0]>>5, b[0]&0x1f
	b = b[1:]
	var n uint64
	switch {
	case info < 24:
		n = uint64(info)
	case info == 24 && len(b) >= 1:
		n, b = uint64(b[0]), b[1:]
	case info == 25 && len(b) >= 2:
		n, b = uint64(binary.BigEndian.Uint16(b)), b[2:]
	case info == 26 && len(b) >= 4:
		n, b = uint64(binary.BigEndian.Uint32(b)), b[4:]
	case info == 27 && len(b) >= 8:
		n, b = binary.BigEndian.Uint64(b), b[8:]
	default:
		return nil, nil, errCBOR
	}
	switch major {
	case 0:
		return n, b, nil
	case 2, 3:
		if n > uint64(len(b)) {
			return nil, nil, errCBOR
		}
		s := b[:n]
		if major == 3 {
			return string(s), b[n:], nil
		}
		return s, b[n:], nil
	case 4:
		if n > uint64(len(b)) {
			return nil, nil, errCBOR
		}
		out := make([]any, 0, n)
		for range n {
			v, rest, err := cborItem(b, depth+1)
			if err != nil {
				return nil, nil, err
			}
			out, b = append(out, v), rest
		}
		return out, b, nil
	case 5:
		if n > uint64(len(b)) {
			return nil, nil, errCBOR
		}
		out := make(map[string]any, n)
		for range n {
			k, rest, err := cborItem(b, depth+1)
			if err != nil {
				return nil, nil, err
			}
			ks, ok := k.(string)
			if !ok {
				return nil, nil, fmt.Errorf("%w: a map key that is not text", errCBOR)
			}
			v, rest, err := cborItem(rest, depth+1)
			if err != nil {
				return nil, nil, err
			}
			if _, dup := out[ks]; dup {
				return nil, nil, fmt.Errorf("%w: key %q twice", errCBOR, ks)
			}
			out[ks], b = v, rest
		}
		return out, b, nil
	}
	return nil, nil, errCBOR
}
