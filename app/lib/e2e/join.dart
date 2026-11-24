// A join's shared pieces (docs/e2e.md, section 6), as e2e/join.ts has them:
// the text a new device shows, and its QR code holds; XXpsk3's prologue;
// and each side's signed offer of its keys. cases/e2e/join.json holds both
// languages to the same bytes.
//
// The text is "PIRC1", then the lookup (8 Crockford base32 characters, 40
// bits), then the 256-bit secret in Crockford base32 (52 characters, the
// last 4 bits zero): 65 characters, upper case, no padding. Reading it
// takes lower case too, and ignores spaces and hyphens, and anything up to
// the last "#", so that a link carrying it after "#" reads as the text.
import 'dart:convert' show utf8;
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';

import '../gen/pirc/v1alpha2/account.pb.dart';
import 'bytes.dart';
import 'framed.dart';
import 'list.dart';

const joinContext = 'pirc-e2e-v2 join';
const joinVersion = 1;
const joinTextPrefix = 'PIRC1';
const lookupChars = 8;
const secretBytes = 32;
const joinTextChars = 5 + lookupChars + 52;
const _alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const _keyBytes = 32;

/// Crockford base32 of [b], most significant bit first; the last
/// character's spare bits zero.
String base32(List<int> b) {
  final out = StringBuffer();
  var acc = 0;
  var bits = 0;
  for (final x in b) {
    acc = (acc << 8) | x;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.write(_alphabet[(acc >> bits) & 31]);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out.write(_alphabet[(acc << (5 - bits)) & 31]);
  return out.toString();
}

/// The [n] bytes [s] holds, or null for another length, a character
/// outside the alphabet, or spare bits set.
Uint8List? fromBase32(String s, int n) {
  if (s.length != (n * 8 + 4) ~/ 5) return null;
  final out = Uint8List(n);
  var acc = 0;
  var bits = 0;
  var at = 0;
  for (final c in s.split('')) {
    final v = _alphabet.indexOf(c);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
    acc &= (1 << bits) - 1;
  }
  return acc == 0 ? out : null;
}

/// A random lookup: 5 random bytes, 8 characters.
String newLookup(Uint8List Function(int n) random) => base32(random(5));

String joinText(String lookup, List<int> secret) {
  if (fromBase32(lookup, 5) == null) throw ArgumentError('join: the lookup is 8 Crockford base32 characters');
  if (secret.length != secretBytes) throw ArgumentError('join: the secret is 32 bytes');
  return joinTextPrefix + lookup + base32(secret);
}

/// The lookup and secret a join's text, or a link carrying it, holds.
typedef JoinCode = ({String lookup, Uint8List secret});

/// The code [input] holds, or null if it holds none.
JoinCode? readJoinText(String input) {
  final hash = input.lastIndexOf('#');
  final s = (hash >= 0 ? input.substring(hash + 1) : input).replaceAll(RegExp(r'[\s-]'), '').toUpperCase();
  if (s.length != joinTextChars || !s.startsWith(joinTextPrefix)) return null;
  final lookup = s.substring(joinTextPrefix.length, joinTextPrefix.length + lookupChars);
  if (fromBase32(lookup, 5) == null) return null;
  final secret = fromBase32(s.substring(joinTextPrefix.length + lookupChars), secretBytes);
  return secret == null ? null : (lookup: lookup, secret: secret);
}

/// XXpsk3's prologue: framed(context, the join's version, the lookup).
Uint8List joinPrologue(String lookup) => framed(joinContext, [framedNumber(Int64(joinVersion)), utf8.encode(lookup)]);

/// What a side signs: framed(context, its role, its five keys, the
/// handshake's final hash).
Uint8List offerSigned(Device d, List<int> handshakeHash) => framed(joinContext, [
      framedNumber(Int64(d.role)),
      d.signingKey,
      d.channelKey,
      d.boxKey,
      d.readOnlyKey,
      d.notificationKey,
      handshakeHash,
    ]);

/// The device with only the fields that hold something set, as every
/// language writes it.
Device _canonical(Device d) => Device(
      role: d.role == 0 ? null : d.role,
      signingKey: d.signingKey.isEmpty ? null : d.signingKey,
      channelKey: d.channelKey.isEmpty ? null : d.channelKey,
      boxKey: d.boxKey.isEmpty ? null : d.boxKey,
      readOnlyKey: d.readOnlyKey.isEmpty ? null : d.readOnlyKey,
      notificationKey: d.notificationKey.isEmpty ? null : d.notificationKey,
    );

/// An offer's bytes, signed with [sign].
Uint8List makeOffer(Device d, List<int> handshakeHash, Uint8List Function(Uint8List m) sign) =>
    JoinOffer(device: _canonical(d), signature: sign(offerSigned(d, handshakeHash))).writeToBuffer();

/// A checked offer: [device] when accepted, otherwise the [reason]:
/// parse, role, key, channel-key or signature.
class OfferResult {
  const OfferResult._(this.device, this.reason);

  final Device? device;
  final String? reason;
  bool get accepted => device != null;
}

extension E2eJoin on E2e {
  /// The other side's offer, checked: of [role], its keys the right sizes,
  /// its channel key the static key the handshake proved, and signed by its
  /// signing key over this handshake.
  OfferResult checkOffer({required List<int> offer, required int role, required List<int> remoteStatic, required List<int> handshakeHash}) {
    OfferResult refused(String reason) => OfferResult._(null, reason);
    final JoinOffer o;
    try {
      o = JoinOffer.fromBuffer(offer);
    } catch (_) {
      return refused('parse');
    }
    if (!o.hasDevice()) return refused('parse');
    final d = o.device;
    if (d.role != role || (d.role != roleClient && d.role != roleComputer)) return refused('role');
    bool key(List<int> b) => b.length == _keyBytes;
    final phoneKeys = d.role == roleClient && d.readOnlyKey.isNotEmpty;
    if (!key(d.signingKey) || !key(d.channelKey) || !key(d.boxKey)) return refused('key');
    if (phoneKeys ? !key(d.readOnlyKey) || !key(d.notificationKey) : d.readOnlyKey.isNotEmpty || d.notificationKey.isNotEmpty) return refused('key');
    if (!bytesEqual(d.channelKey, remoteStatic)) return refused('channel-key');
    if (o.signature.length != signatureBytes) return refused('signature');
    bool ok;
    try {
      ok = sodium.crypto.sign.verifyDetached(
        message: offerSigned(d, handshakeHash),
        signature: Uint8List.fromList(o.signature),
        publicKey: Uint8List.fromList(d.signingKey),
      );
    } catch (_) {
      ok = false;
    }
    if (!ok) return refused('signature');
    return OfferResult._(
      Device(
        role: d.role,
        signingKey: Uint8List.fromList(d.signingKey),
        channelKey: Uint8List.fromList(d.channelKey),
        boxKey: Uint8List.fromList(d.boxKey),
        readOnlyKey: Uint8List.fromList(d.readOnlyKey),
        notificationKey: Uint8List.fromList(d.notificationKey),
      ),
      null,
    );
  }
}
