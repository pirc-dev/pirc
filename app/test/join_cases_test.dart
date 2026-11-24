// cases/e2e/join.json against the app's Dart (lib/e2e/join.dart): the text
// made and read, the prologue, and the offers made to exact bytes and
// checked, every case run.
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:sodium/sodium_sumo.dart';

import 'package:pirc/e2e/bytes.dart';
import 'package:pirc/e2e/join.dart';
import 'package:pirc/e2e/list.dart';
import 'package:pirc/gen/pirc/v1alpha2/account.pb.dart';

typedef Json = Map<String, Object?>;

Uint8List unhex(Object? s) {
  final t = s! as String;
  return Uint8List.fromList([for (var i = 0; i < t.length; i += 2) int.parse(t.substring(i, i + 2), radix: 16)]);
}

Device device(Object? j) {
  final d = j! as Json;
  return Device(
    role: d['role']! as int,
    signingKey: unhex(d['signingKey']),
    channelKey: unhex(d['channelKey']),
    boxKey: unhex(d['boxKey']),
    readOnlyKey: unhex(d['readOnlyKey']),
    notificationKey: unhex(d['notificationKey']),
  );
}

Json deviceJson(Device d) => {
      'role': d.role,
      'signingKey': hexOf(d.signingKey),
      'channelKey': hexOf(d.channelKey),
      'boxKey': hexOf(d.boxKey),
      'readOnlyKey': hexOf(d.readOnlyKey),
      'notificationKey': hexOf(d.notificationKey),
    };

void main() {
  late E2e e2e;
  late SodiumSumo sodium;
  setUpAll(() async {
    e2e = await E2e.load();
    sodium = e2e.sodium;
  });

  test('join.json', () {
    final file = jsonDecode(File('../cases/e2e/join.json').readAsStringSync()) as Json;
    expect(file.keys.toList()..sort(), ['about', 'cases']);
    final cases = (file['cases']! as List).cast<Json>();
    final seen = <String>{};
    final failures = <String>[];
    void want(Object? got, Object? expected, Json c) {
      if (jsonEncode(got) != jsonEncode(expected)) failures.add('${c['about']}: got ${jsonEncode(got)}, want ${jsonEncode(expected)}');
    }

    for (final c in cases) {
      final check = c['check']! as String;
      seen.add(check);
      switch (check) {
        case 'join-text':
          want(joinText(c['lookup']! as String, unhex(c['secret'])), c['text'], c);
        case 'read-join-text':
          final r = readJoinText(c['input']! as String);
          want(r == null ? null : {'lookup': r.lookup, 'secret': hexOf(r.secret)}, c['expect'], c);
        case 'join-prologue':
          want(hexOf(joinPrologue(c['lookup']! as String)), c['bytes'], c);
        case 'make-offer':
          final kp = sodium.crypto.sign.seedKeyPair(SecureKey.fromList(sodium, unhex(c['seed'])));
          final bytes = makeOffer(device(c['device']), unhex(c['handshakeHash']), (m) => sodium.crypto.sign.detached(message: m, secretKey: kp.secretKey));
          kp.secretKey.dispose();
          want(hexOf(bytes), c['bytes'], c);
        case 'check-offer':
          final r = e2e.checkOffer(offer: unhex(c['offer']), role: c['role']! as int, remoteStatic: unhex(c['remoteStatic']), handshakeHash: unhex(c['handshakeHash']));
          want(r.accepted ? {'result': 'accepted', 'device': deviceJson(r.device!)} : {'result': 'refused', 'reason': r.reason}, c['expect'], c);
        default:
          failures.add('unknown check $check');
      }
    }
    expect(failures, isEmpty);
    expect(seen.toList()..sort(), ['check-offer', 'join-prologue', 'join-text', 'make-offer', 'read-join-text']);
  });

  test('base32: every length round trips; spare bits, a foreign character, the length refused', () {
    for (var n = 0; n < 40; n++) {
      final b = sodium.randombytes.buf(n);
      expect(fromBase32(base32(b), n), b);
    }
    expect(fromBase32('ZX', 1), isNull);
    expect(fromBase32('ZU', 1), isNull);
    expect(fromBase32('ZW0', 1), isNull);
    expect(() => joinText('VTPVXVT', Uint8List(32)), throwsArgumentError);
    expect(() => joinText('VTPVXVT2', Uint8List(31)), throwsArgumentError);
  });
}
