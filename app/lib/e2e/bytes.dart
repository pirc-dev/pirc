// Bytes, and the one way PiRC frames strings for signing, hashing, HKDF's
// and HPKE's info and AES-GCM's additional data (docs/e2e.md, section 2,
// "Exact bytes"): the context's ASCII, a NUL byte, then each part
// prefixed by its length as an unsigned LEB128. A port of crypto/bytes.ts.
import 'dart:convert' as convert;
import 'dart:math';
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';

Uint8List utf8(String s) => Uint8List.fromList(convert.utf8.encode(s));

final empty = Uint8List(0);

Uint8List concat(List<List<int>> parts) {
  final out = Uint8List(parts.fold(0, (n, p) => n + p.length));
  var i = 0;
  for (final p in parts) {
    out.setRange(i, i + p.length, p);
    i += p.length;
  }
  return out;
}

Uint8List leb128(int n) {
  if (n < 0) throw RangeError('bad length $n');
  final out = <int>[];
  do {
    out.add(n < 128 ? n : (n & 0x7f) | 0x80);
    n >>= 7;
  } while (n > 0);
  return Uint8List.fromList(out);
}

// CPace's prepend_len.
Uint8List prependLen(List<int> data) => concat([leb128(data.length), data]);

Uint8List framed(String context, [List<List<int>> parts = const []]) =>
    concat([utf8(context), const [0], for (final p in parts) prependLen(p)]);

// 8 bytes big-endian. An Int64 is how the generated types hold a uint64:
// its 64 bits are the number's, whatever its sign as an Int64.
Uint8List u64(Int64 n) => Uint8List.fromList(n.toBytes().reversed.toList());

Uint8List u64Of(int n) {
  if (n < 0) throw RangeError('not a u64: $n');
  return u64(Int64(n));
}

bool equal(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) {
    d |= a[i] ^ b[i];
  }
  return d == 0;
}

// Bytewise order, for the lists that are kept sorted by key.
int compare(List<int> a, List<int> b) {
  for (var i = 0; i < min(a.length, b.length); i++) {
    if (a[i] != b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

String hex(List<int> b) => [for (final x in b) x.toRadixString(16).padLeft(2, '0')].join();

Uint8List unhex(String s) {
  if (s.length.isOdd || RegExp('[^0-9a-fA-F]').hasMatch(s)) throw const FormatException('not hex');
  return Uint8List.fromList([for (var i = 0; i < s.length; i += 2) int.parse(s.substring(i, i + 2), radix: 16)]);
}

final _random = Random.secure();

Uint8List random(int n) => Uint8List.fromList([for (var i = 0; i < n; i++) _random.nextInt(256)]);
