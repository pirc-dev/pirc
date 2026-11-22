// The framing the hosted relay's login and attestation sign: the same
// vector as relay-client/test/hosted.test.ts and relay/internal/hosted's
// TestFramed.
import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/e2e/framed.dart';

void main() {
  test('framed: the context, a NUL, each part after its LEB128 length', () {
    final long = List<int>.filled(200, 7);
    expect(framed('ab', [<int>[], long]), [0x61, 0x62, 0, 0, 0xc8, 0x01, ...long]);
  });
}
