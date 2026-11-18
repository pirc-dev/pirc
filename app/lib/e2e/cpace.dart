// CPACE-X25519-SHA512 as in draft-irtf-cfrg-cpace-21, sections 6-8 and
// appendix A. A port of crypto/cpace.ts: the X25519 and SHA-512 functions
// are passed in (join.dart's env). Not constant time: the map to the curve
// uses BigInt.
import 'dart:math';
import 'dart:typed_data';

import 'bytes.dart';

// X25519(scalar, u) per RFC 7748. May throw where the platform refuses.
typedef X25519Fn = Future<Uint8List> Function(List<int> scalar, List<int> u);
typedef Sha512Fn = Future<Uint8List> Function(List<int> data);

class Env {
  const Env({required this.x25519, required this.sha512, required this.random});
  final X25519Fn x25519;
  final Sha512Fn sha512;
  final Uint8List Function(int n) random;
}

final dsi = utf8('CPace255');
const _sInBytes = 128; // SHA-512's input block size
const _fieldBytes = 32;
final _p = (BigInt.one << 255) - BigInt.from(19);
final _a = BigInt.from(486662);
final _z = BigInt.two; // RFC 9380's non-square for curve25519
final identity = Uint8List(32); // G_X25519.I

// The protocol was aborted: K was the identity, or the platform refused the point.
class CPaceAbort implements Exception {
  CPaceAbort(this.message, [this.platformError]);
  final String message;
  final Object? platformError;

  @override
  String toString() => 'CPaceAbort: $message';
}

// --- strings (section 6.3, appendix A.1-A.3) ---

Uint8List lvCat(List<List<int>> args) => concat([for (final a in args) prependLen(a)]);

bool _lexLarger(List<int> a, List<int> b) {
  for (var i = 0; i < min(a.length, b.length); i++) {
    if (a[i] != b[i]) return a[i] > b[i];
  }
  return a.length > b.length;
}

Uint8List oCat(List<int> a, List<int> b) => _lexLarger(a, b) ? concat([utf8('oc'), a, b]) : concat([utf8('oc'), b, a]);

Uint8List transcriptIr(List<int> ya, List<int> ada, List<int> yb, List<int> adb) =>
    concat([lvCat([ya, ada]), lvCat([yb, adb])]);

Uint8List transcriptOc(List<int> ya, List<int> ada, List<int> yb, List<int> adb) =>
    oCat(lvCat([ya, ada]), lvCat([yb, adb]));

Uint8List generatorString(List<int> dsi, List<int> prs, List<int> ci, List<int> sid, int sInBytes) {
  final zpad = max(0, sInBytes - 1 - prependLen(prs).length - prependLen(dsi).length);
  return lvCat([dsi, prs, Uint8List(zpad), ci, sid]);
}

// --- field and Elligator2 (RFC 9380 6.7.1, J = A, K = 1) ---

BigInt _mod(BigInt a) => a % _p; // never negative for a positive modulus

BigInt _inv0(BigInt x) => x.modPow(_p - BigInt.two, _p); // 0 for 0, as RFC 9380 wants

bool _isSquare(BigInt x) => x.modPow((_p - BigInt.one) ~/ BigInt.two, _p) != _p - BigInt.one;

// decodeUCoordinate of RFC 7748 for 255 bits: little endian, bit 255 masked, mod p.
BigInt decodeU(List<int> b) {
  var n = BigInt.zero;
  for (var i = 31; i >= 0; i--) {
    n = (n << 8) | BigInt.from(i == 31 ? b[i] & 0x7f : b[i]);
  }
  return _mod(n);
}

Uint8List encodeU(BigInt u) {
  final out = Uint8List(32);
  final ff = BigInt.from(0xff);
  var n = _mod(u);
  for (var i = 0; i < 32; i++, n >>= 8) {
    out[i] = (n & ff).toInt();
  }
  return out;
}

// map_to_curve_elligator2 for curve25519; returns the u coordinate.
BigInt elligator2(BigInt r) {
  var x1 = _mod(-_a * _inv0(BigInt.one + _z * r * r));
  if (x1 == BigInt.zero) x1 = _mod(-_a);
  final gx1 = _mod(x1 * x1 * x1 + _a * x1 * x1 + x1);
  return _isSquare(gx1) ? x1 : _mod(-x1 - _a);
}

// --- CPace (sections 7.2 and 8.2) ---

typedef Generator = ({Uint8List genStr, Uint8List hash, Uint8List u, Uint8List g});

Future<Generator> calculateGenerator(Env env, List<int> prs, List<int> ci, List<int> sid) async {
  final genStr = generatorString(dsi, prs, ci, sid, _sInBytes);
  final hash = (await env.sha512(genStr)).sublist(0, _fieldBytes);
  final u = decodeU(hash);
  return (genStr: genStr, hash: hash, u: encodeU(u), g: encodeU(elligator2(u)));
}

bool _isIdentity(List<int> k) => k.length == 32 && k.every((x) => x == 0);

// G_X25519.scalar_mult_vfy, with the abort folded in: returns K, or throws
// CPaceAbort when K is the identity. package:cryptography's X25519 returns
// zeros for a low-order point rather than throwing, so the identity check
// is what aborts here; a platform that throws aborts too.
//
// The peer's u is passed on in canonical form (bit 255 cleared, reduced mod
// p), as crypto/cpace.ts does for Firefox's sake; RFC 7748's X25519
// computes on that anyway. The transcript keeps the bytes as received.
Future<Uint8List> scalarMultVfy(Env env, List<int> y, List<int> g, {bool canonical = true}) async {
  Uint8List k;
  try {
    k = await env.x25519(y, canonical ? encodeU(decodeU(g)) : g);
  } catch (e) {
    throw CPaceAbort("X25519 refused the peer's point", e);
  }
  if (_isIdentity(k)) throw CPaceAbort('K is the identity');
  return k;
}

// One side: its scalar y, its share Y = X25519(y, g), its associated data and the session ID.
class Party {
  Party(this.y, this.share, this.ad, this.sid);
  final Uint8List y;
  final Uint8List share;
  final Uint8List ad;
  final Uint8List sid;
}

// One side's message. y is random unless given (test vectors).
Future<Party> start(Env env,
    {required List<int> prs, required List<int> ci, required List<int> sid, required List<int> ad, List<int>? y}) async {
  final gen = await calculateGenerator(env, prs, ci, sid);
  final scalar = Uint8List.fromList(y ?? env.random(_fieldBytes)); // G_X25519.sample_scalar
  return Party(scalar, await env.x25519(scalar, gen.g), Uint8List.fromList(ad), Uint8List.fromList(sid));
}

enum Role { initiator, responder }

typedef Finished = ({Uint8List k, Uint8List isk, Uint8List sidOutput});

Uint8List _iskPrefix(List<int> sid, List<int> k) => lvCat([concat([dsi, utf8('_ISK')]), sid, k]);

// ISK for the initiator/responder setting (transcript_ir).
Future<Finished> finish(Env env, Party me, Role role, List<int> yOther, List<int> adOther) async {
  final k = await scalarMultVfy(env, me.y, yOther);
  final t = role == Role.initiator
      ? transcriptIr(me.share, me.ad, yOther, adOther)
      : transcriptIr(yOther, adOther, me.share, me.ad);
  final isk = await env.sha512(concat([_iskPrefix(me.sid, k), t]));
  return (k: k, isk: isk, sidOutput: await env.sha512(concat([utf8('CPaceSidOutput'), t])));
}

// ISK for parallel execution (transcript_oc), used only to check B.1.6.
Future<({Uint8List isk, Uint8List sidOutput})> iskOc(
    Env env, List<int> sid, List<int> k, List<int> ya, List<int> ada, List<int> yb, List<int> adb) async {
  final t = transcriptOc(ya, ada, yb, adb);
  return (
    isk: await env.sha512(concat([_iskPrefix(sid, k), t])),
    sidOutput: await env.sha512(concat([utf8('CPaceSidOutput'), t])),
  );
}
