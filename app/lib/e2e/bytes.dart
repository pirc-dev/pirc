// Byte and text helpers shared by the checks (e2e/bytes.ts).
import 'dart:convert';
import 'dart:typed_data';

/// Whether two byte lists hold the same bytes, in time that depends on their
/// length only.
bool bytesEqual(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) {
    d |= a[i] ^ b[i];
  }
  return d == 0;
}

String hexOf(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

// Malformed UTF-8 is refused, never replaced; Dart's decoder refuses
// overlong forms, surrogates and values above U+10FFFF as TextDecoder with
// fatal does. It drops a U+FEFF at the start of what it decodes, which every
// other language keeps as text like any other, so the bytes are decoded
// behind a byte that is not one, and that byte's character dropped.
const _strict = Utf8Decoder(allowMalformed: false);

/// The text of valid UTF-8, or null.
String? utf8Text(List<int> bytes) {
  try {
    return _strict.convert([0x2e, ...bytes]).substring(1);
  } on FormatException {
    return null;
  }
}

/// A text's UTF-8, cut to at most [cap] bytes at a code point boundary. A
/// lone surrogate, which has no UTF-8, is written as U+FFFD, as TextEncoder
/// writes it.
Uint8List utf8Cut(String text, int cap) {
  final b = const Utf8Encoder().convert(text);
  if (b.length <= cap) return b;
  var end = cap;
  while (end > 0 && (b[end] & 0xc0) == 0x80) {
    end--;
  }
  return Uint8List.sublistView(b, 0, end);
}
