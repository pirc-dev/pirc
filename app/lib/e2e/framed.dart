// framed (docs/e2e.md, section 2): how every signed string is built. It
// imports no sodium, so code that needs only this, such as the hosted
// login, loads no native library.
//
// Nothing parses framed bytes: a reader builds the bytes it expects and
// compares.
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';

/// The context's ASCII, a NUL byte, then each part prefixed by its length
/// as an unsigned LEB128. Throws an [ArgumentError] for a context that is
/// empty or holds a character below 0x20 or above 0x7E.
Uint8List framed(String context, List<List<int>> parts) {
  if (context.isEmpty) throw ArgumentError.value(context, 'context', 'empty');
  for (final c in context.codeUnits) {
    if (c < 0x20 || c > 0x7e) throw ArgumentError.value(context, 'context', 'a character outside 0x20 to 0x7E');
  }
  final out = BytesBuilder(copy: false)..add(context.codeUnits)..addByte(0);
  for (final p in parts) {
    out.add(leb128(p.length));
    out.add(p);
  }
  return out.takeBytes();
}

/// A length as an unsigned LEB128.
List<int> leb128(int n) {
  if (n < 0) throw RangeError.value(n, 'n', 'a length is not negative');
  final out = <int>[];
  do {
    final low = n % 128;
    n ~/= 128;
    out.add(n > 0 ? low + 128 : low);
  } while (n > 0);
  return out;
}

/// A number as a framed part holds it: 8 bytes, big-endian. Throws a
/// [RangeError] for a value read as negative: below 0, or 2^63 or above as
/// an unsigned 64-bit number.
Uint8List framedNumber(Int64 value) {
  if (value.isNegative) throw RangeError.value(value.toInt(), 'value', 'outside 0 to 2^63-1');
  return Uint8List.fromList(value.toBytes().reversed.toList());
}
