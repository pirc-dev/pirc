// Whether every string in an encoded message is valid UTF-8 (docs/e2e.md,
// section 2: a string that is not refuses the object). Go's and
// TypeScript's decoders refuse one as they decode; Dart's protobuf takes
// it, putting U+FFFD in its place, so the bytes are walked here with the
// message's own field types, nested messages too, and each string's
// bytes decoded strictly.
import 'dart:convert';

import 'package:protobuf/protobuf.dart';

bool stringsAreUtf8(BuilderInfo info, List<int> b) {
  try {
    _walk(info, b, 0, b.length);
    return true;
  } on FormatException {
    return false;
  } on RangeError {
    // Bytes no decoder would take: no, not a crash.
    return false;
  }
}

void _walk(BuilderInfo info, List<int> b, int start, int end) {
  var i = start;
  int varint() {
    var v = 0, shift = 0;
    for (;;) {
      if (i >= end) throw const FormatException('truncated');
      final x = b[i++];
      if (shift < 63) {
        v |= (x & 0x7f) << shift;
      } else {
        // The tenth byte holds bit 63 only: more overflows 64 bits, which
        // every decoder refuses. Bit 63 is kept, so that a key or a length
        // with it reads as negative and is refused, not cut short.
        if (x > 1) throw const FormatException('varint over 64 bits');
        v |= x << 63;
      }
      if (x & 0x80 == 0) return v;
      // Ten bytes at most, as every decoder reads them: the tenth, holding
      // no more than bit 63, never continues.
      shift += 7;
    }
  }

  // An unknown group, skipped as the decoders skip it, to its end.
  void group(int tag) {
    for (;;) {
      final key = _key(varint());
      final t = key >> 3, wire = key & 7;
      switch (wire) {
        case 0:
          varint();
        case 1:
          i += 8;
        case 5:
          i += 4;
        case 2:
          final n = varint();
          if (n < 0 || n > end - i) throw const FormatException('truncated');
          i += n;
        case 3:
          group(t);
        case 4:
          if (t != tag) throw const FormatException('a group ended by another tag');
          return;
        default:
          throw const FormatException('a wire type no message has');
      }
      if (i > end) throw const FormatException('truncated');
    }
  }

  while (i < end) {
    final key = _key(varint());
    final tag = key >> 3, wire = key & 7;
    switch (wire) {
      case 0:
        varint();
      case 1:
        i += 8;
      case 5:
        i += 4;
      case 3:
        // None of these messages has a group: an unknown one, as Go's and
        // TypeScript's decoders take it.
        group(tag);
      case 2:
        final n = varint();
        if (n < 0 || n > end - i) throw const FormatException('truncated');
        final f = info.fieldInfo[tag];
        if (f != null) {
          final base = PbFieldType.baseType(f.type);
          if (base == PbFieldType.STRING_BIT) {
            const Utf8Decoder().convert(b, i, i + n);
          } else if (PbFieldType.isGroupOrMessage(f.type) && f.subBuilder != null) {
            _walk(f.subBuilder!().info_, b, i, i + n);
          }
        }
        i += n;
      default:
        throw const FormatException('a wire type no message has, or a group ended that was not begun');
    }
    if (i > end) throw const FormatException('truncated');
  }
}

// A field's key as the other decoders take it: over 32 bits, Go's and
// TypeScript's refuse the message, where Dart's keeps the low 32 bits and
// would read a string this walk would skip as another field.
int _key(int k) {
  if (k < 0 || k > 0xffffffff) throw const FormatException('a key over 32 bits');
  return k;
}
