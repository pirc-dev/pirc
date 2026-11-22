// Noise, revision 34, with nothing added (docs/e2e.md, sections 4 and 6):
// the cipher state, the symmetric state and a handshake driven by a
// pattern's tokens, over libsodium's raw bindings, for
// Noise_IK_25519_ChaChaPoly_SHA512 and Noise_XXpsk3_25519_ChaChaPoly_SHA512.
// The steps, their order and the names of results and reasons are those of
// e2e/noise-core.ts.
//
// This library is internal: noise.dart is the public entry. The tests reach
// it to inject ephemeral keys, to give handshake messages payloads (the
// published vectors have them), to set a counter and to stand in for
// libsodium's DH and encryption.
//
// No input bytes make anything throw: a failure is a result with a reason,
// and the handshake or transport is dead after it. Only a caller's mistake
// throws, and a throw kills the state too. Every call is synchronous and
// runs none of the caller's code, so no call can start while another runs.
//
// Secrets live in native memory from sodium_malloc: a handshake's (its copy
// of the static secret key, the ephemeral secret key, the PSK's copy, the
// chaining key, the cipher key, DH and HKDF outputs, the HMAC state) in one
// block, a transport's two keys in another. A block is sodium_memzero'd and
// freed when its handshake finishes or dies, or its transport is closed or
// dies; one dropped before that is freed by a finalizer through sodium_free,
// which zeroes it too. The native buffers a message or plaintext passes
// through are zeroed before they are freed. Bytes in Dart's
// garbage-collected heap (plaintexts given out, the copies of messages
// taken on entry, a caller's own key buffers) cannot be wiped from here.
import 'dart:ffi';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';
import 'package:flutter/foundation.dart' show visibleForTesting;
// The raw bindings: the package's API has no SHA-512, HMAC-SHA-512 or
// ChaCha20-Poly1305 IETF.
import 'package:sodium/sodium.ffi.dart' show LibSodiumFFI;
// The HMAC state struct, which the package does not export: from its own
// files, pinned with the package's exact version in pubspec.yaml
// (docs/e2e.md, section 2).
// ignore: implementation_imports
import 'package:sodium/src/ffi/bindings/libsodium.ffi.dart' show crypto_auth_hmacsha512_state;
import 'package:sodium/sodium_sumo.dart' show SecureKey;

/// Why a call failed.
enum NoiseReason { length, dh, decrypt, dead }

/// A caller's mistake: a call out of order, a key of the wrong length, too
/// long a plaintext, an IK responder sending before it may.
class NoiseCallError extends Error {
  NoiseCallError(this.message);
  final String message;
  @override
  String toString() => 'noise: $message';
}

const maxMessage = 65535;
const tagBytes = 16;
const maxPlaintext = maxMessage - tagBytes;
const keyBytes = 32;
const _hashBytes = 64;

/// The first counter value never used, 2^63-1: a call that would use it
/// throws a [RangeError].
const nonceCap = 0x7fffffffffffffff;

const _ffi = LibSodiumFFI();

enum Token { e, s, ee, es, se, ss, psk }

class NoisePattern {
  const NoisePattern._(this.name, {required this.responderKnown, required this.psk, required this.messages});

  final String name;

  /// IK's pre-message: the initiator knows the responder's static key.
  final bool responderKnown;

  /// Whether e MixKeys too (section 9.2).
  final bool psk;

  /// The messages' tokens; the initiator writes the first.
  final List<List<Token>> messages;
}

const ik = NoisePattern._('Noise_IK_25519_ChaChaPoly_SHA512', responderKnown: true, psk: false, messages: [
  [Token.e, Token.es, Token.s, Token.ss],
  [Token.e, Token.ee, Token.se],
]);

const xxpsk3 = NoisePattern._('Noise_XXpsk3_25519_ChaChaPoly_SHA512', responderKnown: false, psk: true, messages: [
  [Token.e],
  [Token.e, Token.ee, Token.s, Token.es],
  [Token.s, Token.se, Token.psk],
]);

/// The 12-byte nonce: 4 zero bytes, then the counter as 8 bytes little-endian.
Uint8List nonceBytes(int n) {
  final out = Uint8List(12);
  ByteData.sublistView(out).setUint64(4, n, Endian.little);
  return out;
}

/// libsodium's DH and encryption, which a test can stand in for.
class NoiseNatives {
  const NoiseNatives();

  int scalarmult(Pointer<UnsignedChar> q, Pointer<UnsignedChar> n, Pointer<UnsignedChar> p) => _ffi.crypto_scalarmult(q, n, p);

  int encrypt(Pointer<UnsignedChar> c, Pointer<UnsignedChar> m, int mlen, Pointer<UnsignedChar> ad, int adlen, Pointer<UnsignedChar> nonce, Pointer<UnsignedChar> k) =>
      _ffi.crypto_aead_chacha20poly1305_ietf_encrypt(c, nullptr, m, mlen, ad, adlen, nullptr, nonce, k);
}

/// Called with a view of every native buffer once zeroed, just before it is
/// freed. Tests only.
@visibleForTesting
void Function(Uint8List zeroed)? noiseOnWipe;

/// How many native blocks are held. Tests only.
@visibleForTesting
int noiseLiveBlocks = 0;

void _zero(Pointer<Uint8> p, int n) {
  _ffi.sodium_memzero(p.cast(), n);
  noiseOnWipe?.call(p.asTypedList(n));
}

final _sodiumFree = NativeFinalizer(_ffi.sodium_freePtr!.cast());

/// Native memory from sodium_malloc, zeroed when made and when freed.
class _Block implements Finalizable {
  _Block(this.size) : _p = _ffi.sodium_malloc(size).cast<Uint8>() {
    if (_p == nullptr) throw StateError('noise: sodium_malloc failed');
    _ffi.sodium_memzero(_p.cast(), size);
    _sodiumFree.attach(this, _p.cast(), detach: this, externalSize: size);
    noiseLiveBlocks++;
  }

  final Pointer<Uint8> _p;
  final int size;
  bool _freed = false;

  bool get freed => _freed;

  Pointer<Uint8> at(int offset) => _p + offset;
  Uint8List view(int offset, int n) => (_p + offset).asTypedList(n);

  void free() {
    if (_freed) return;
    _freed = true;
    _zero(_p, size);
    _sodiumFree.detach(this);
    _ffi.sodium_free(_p.cast());
    noiseLiveBlocks--;
  }
}

/// A native buffer of [n] bytes for [f], zeroed before it is freed.
T _scratch<T>(int n, T Function(Pointer<Uint8> p) f) {
  final size = n == 0 ? 1 : n;
  final p = malloc<Uint8>(size);
  try {
    return f(p);
  } finally {
    _zero(p, size);
    malloc.free(p);
  }
}

Pointer<UnsignedChar> _u(Pointer<Uint8> p) => p.cast();

/// The bytes the HMAC state takes in a block, rounded up to a multiple of
/// 16, from the struct's size here and libsodium's own; throws a
/// [StateError] when they differ (the package's struct moved or changed).
@visibleForTesting
int hmacStateBytes(int structBytes, int libsodiumBytes) {
  if (structBytes != libsodiumBytes) throw StateError('noise: the HMAC state struct is not libsodium\'s');
  return (structBytes + 15) & ~15;
}

/// The handshake block's layout: the HMAC state first, where sodium_malloc's
/// alignment holds for a size that is a multiple of 16; the block's size is
/// one too.
final int _stateBytes = hmacStateBytes(sizeOf<crypto_auth_hmacsha512_state>(), _ffi.crypto_auth_hmacsha512_statebytes());
final int _ck = _stateBytes;
final int _h = _ck + _hashBytes;
final int _temp = _h + _hashBytes;
final int _o1 = _temp + _hashBytes;
final int _o2 = _o1 + _hashBytes;
final int _o3 = _o2 + _hashBytes;
final int _k = _o3 + _hashBytes;
final int _e = _k + keyBytes;
final int _s = _e + keyBytes;
final int _psk = _s + keyBytes;
final int _dh = _psk + keyBytes;
final int _peer = _dh + keyBytes;
final int _pub = _peer + keyBytes;
final int _byte = _pub + keyBytes;
final int _blockBytes = _byte + 16;

/// ChaCha20-Poly1305 IETF with a key in native memory and a counter. In IK
/// and XXpsk3 every encryption comes after a key is mixed in (in XXpsk3, by
/// e), so a cipher without a key is never used.
class CipherState implements Finalizable {
  CipherState._(this._block, this._key, this._natives);

  final _Block _block;
  final int _key;
  final NoiseNatives _natives;

  /// The next counter value. Tests set it.
  @visibleForTesting
  int n = 0;

  /// A copy of the key, null once zeroed and freed. Tests only.
  @visibleForTesting
  Uint8List? get key => _block.freed ? null : Uint8List.fromList(_block.view(_key, keyBytes));

  /// The nonce for this use; throws at the cap.
  Uint8List _use() {
    if (n >= nonceCap) throw RangeError('noise: the counter is at its cap');
    return nonceBytes(n);
  }

  Uint8List encrypt(Pointer<Uint8> ad, int adLen, Uint8List plaintext) {
    final nonce = _use();
    final m = plaintext.length;
    final out = _scratch(12 + m + m + tagBytes, (p) {
      final c = p + 12 + m;
      p.asTypedList(12).setAll(0, nonce);
      (p + 12).asTypedList(m).setAll(0, plaintext);
      if (_natives.encrypt(_u(c), _u(p + 12), m, _u(ad), adLen, _u(p), _u(_block.at(_key))) != 0) {
        throw StateError('noise: crypto_aead_chacha20poly1305_ietf_encrypt failed');
      }
      return Uint8List.fromList(c.asTypedList(m + tagBytes));
    });
    n++;
    return out;
  }

  /// The plaintext, or null when the tag does not verify.
  Uint8List? decrypt(Pointer<Uint8> ad, int adLen, Uint8List ciphertext) {
    final nonce = _use();
    final c = ciphertext.length;
    final out = _scratch(12 + c + c, (p) {
      final m = p + 12 + c;
      p.asTypedList(12).setAll(0, nonce);
      (p + 12).asTypedList(c).setAll(0, ciphertext);
      final rc = _ffi.crypto_aead_chacha20poly1305_ietf_decrypt(_u(m), nullptr, nullptr, _u(p + 12), c, _u(ad), adLen, _u(p), _u(_block.at(_key)));
      return rc == 0 ? Uint8List.fromList(m.asTypedList(c - tagBytes)) : null;
    });
    if (out != null) n++;
    return out;
  }
}

/// The chaining key, the hash and the cipher state of a handshake, in its
/// block.
class SymmetricState implements Finalizable {
  SymmetricState._(this._b, String protocolName, NoiseNatives natives) : cipher = CipherState._(_b, _k, natives) {
    // Both names are under 64 bytes: h starts as the name, zero-padded.
    final name = protocolName.codeUnits;
    _b.view(_h, name.length).setAll(0, name);
    _b.view(_ck, _hashBytes).setAll(0, _b.view(_h, _hashBytes));
  }

  final _Block _b;
  final CipherState cipher;

  /// A copy of h.
  Uint8List get h => Uint8List.fromList(_b.view(_h, _hashBytes));

  /// A copy of the chaining key, null once zeroed and freed. Tests only.
  @visibleForTesting
  Uint8List? get ck => _b.freed ? null : Uint8List.fromList(_b.view(_ck, _hashBytes));

  /// Whether the HMAC state, HKDF's buffers and the DH output are zero. Tests only.
  @visibleForTesting
  bool get transientsZero =>
      !_b.freed && _isZero(_b.at(0), _stateBytes) && [_temp, _o1, _o2, _o3].every((o) => _isZero(_b.at(o), _hashBytes)) && _isZero(_b.at(_dh), keyBytes);

  /// HMAC-SHA-512 of [parts] under the 64-byte key at [key], into [out]:
  /// init, update, final, which take the key whole (crypto_auth_hmacsha512
  /// would truncate it).
  void _hmac(int key, List<(Pointer<Uint8>, int)> parts, int out) {
    final st = _b.at(0).cast<crypto_auth_hmacsha512_state>();
    _ffi.crypto_auth_hmacsha512_init(st, _u(_b.at(key)), _hashBytes);
    for (final (p, n) in parts) {
      _ffi.crypto_auth_hmacsha512_update(st, _u(p), n);
    }
    _ffi.crypto_auth_hmacsha512_final(st, _u(_b.at(out)));
    _ffi.sodium_memzero(st.cast(), _stateBytes);
  }

  /// HKDF as the specification's, with two or three outputs, into o1, o2
  /// and o3; temp zeroed.
  void _hkdf(Pointer<Uint8> ikm, int ikmLen, int outputs) {
    _hmac(_ck, [(ikm, ikmLen)], _temp);
    final byte = _b.at(_byte);
    byte.value = 1;
    _hmac(_temp, [(byte, 1)], _o1);
    byte.value = 2;
    _hmac(_temp, [(_b.at(_o1), _hashBytes), (byte, 1)], _o2);
    if (outputs == 3) {
      byte.value = 3;
      _hmac(_temp, [(_b.at(_o2), _hashBytes), (byte, 1)], _o3);
    }
    _ffi.sodium_memzero(_b.at(_temp).cast(), _hashBytes);
  }

  void _clearOutputs() => _ffi.sodium_memzero(_b.at(_o1).cast(), 3 * _hashBytes);

  void _takeCk(int from) => _b.view(_ck, _hashBytes).setAll(0, _b.view(from, _hashBytes));

  /// The first 32 bytes of a 64-byte output as the cipher key, the counter at 0.
  void _setKey(int from) {
    _b.view(_k, keyBytes).setAll(0, _b.view(from, keyBytes));
    cipher.n = 0;
  }

  void mixHash(Pointer<Uint8> data, int n) {
    _scratch(_hashBytes + n, (p) {
      p.asTypedList(_hashBytes).setAll(0, _b.view(_h, _hashBytes));
      (p + _hashBytes).asTypedList(n).setAll(0, data.asTypedList(n));
      if (_ffi.crypto_hash_sha512(_u(_b.at(_h)), _u(p), _hashBytes + n) != 0) throw StateError('noise: crypto_hash_sha512 failed');
    });
  }

  void mixHashBytes(Uint8List data) => _scratch(data.length, (p) {
        p.asTypedList(data.length).setAll(0, data);
        mixHash(p, data.length);
      });

  void mixKey(Pointer<Uint8> ikm, int n) {
    _hkdf(ikm, n, 2);
    _takeCk(_o1);
    _setKey(_o2);
    _clearOutputs();
  }

  void mixKeyBytes(Uint8List ikm) => _scratch(ikm.length, (p) {
        p.asTypedList(ikm.length).setAll(0, ikm);
        mixKey(p, ikm.length);
      });

  void mixKeyAndHash(Pointer<Uint8> ikm, int n) {
    _hkdf(ikm, n, 3);
    _takeCk(_o1);
    mixHash(_b.at(_o2), _hashBytes);
    _setKey(_o3);
    _clearOutputs();
  }

  Uint8List encryptAndHash(Uint8List plaintext) {
    final c = cipher.encrypt(_b.at(_h), _hashBytes, plaintext);
    mixHashBytes(c);
    return c;
  }

  /// The plaintext, or null; a failure kills the handshake, so h after one is never used.
  Uint8List? decryptAndHash(Uint8List ciphertext) {
    final p = cipher.decrypt(_b.at(_h), _hashBytes, ciphertext);
    mixHashBytes(ciphertext);
    return p;
  }

  /// The two cipher keys into [to] at 0 and 32: the initiator's sending key first.
  void _split(_Block to) {
    _hkdf(_b.at(_byte), 0, 2);
    to.view(0, keyBytes).setAll(0, _b.view(_o1, keyBytes));
    to.view(keyBytes, keyBytes).setAll(0, _b.view(_o2, keyBytes));
  }
}

bool _isZero(Pointer<Uint8> p, int n) => _ffi.sodium_is_zero(_u(p), n) == 1;

/// What a call gives: [reason] on a failure; otherwise a write's [message],
/// a read's [payload], and, after the last message, the [transport].
class HandshakeResult {
  const HandshakeResult._({this.reason, this.message, this.payload, this.transport});

  final NoiseReason? reason;
  final Uint8List? message;
  final Uint8List? payload;
  final Transport? transport;
  bool get ok => reason == null;
}

/// What a send or receive gives: [reason] on a failure, otherwise the
/// message or plaintext in [bytes].
class TransportResult {
  const TransportResult._({this.reason, this.bytes});

  final NoiseReason? reason;
  final Uint8List? bytes;
  bool get ok => reason == null;
}

const _deadHandshake = HandshakeResult._(reason: NoiseReason.dead);
const _deadTransport = TransportResult._(reason: NoiseReason.dead);
HandshakeResult _failure(NoiseReason r) => HandshakeResult._(reason: r);

/// Both directions of a channel after its handshake, their keys in one
/// native block.
class Transport implements Finalizable {
  Transport._(this._b, this._remote, this._hash, this._confirmed, this._gated, bool initiator, NoiseNatives natives)
      : sendCipher = CipherState._(_b, initiator ? 0 : keyBytes, natives),
        receiveCipher = CipherState._(_b, initiator ? keyBytes : 0, natives);

  final _Block _b;
  final Uint8List _remote;
  final Uint8List _hash;
  bool _confirmed;
  final bool _gated;
  bool _dead = false;
  final CipherState sendCipher;
  final CipherState receiveCipher;

  bool get dead => _dead;

  /// The other side's static key; null once the transport is dead.
  Uint8List? get remoteStatic => _dead ? null : Uint8List.fromList(_remote);

  Uint8List get handshakeHash => Uint8List.fromList(_hash);

  /// Whether the other side has shown it holds its keys: at an IK responder
  /// (the initiator's static key) and an XXpsk3 initiator (the PSK) only
  /// once a message from the other side has decrypted; at once otherwise.
  bool get confirmed => _confirmed;

  Never _mistake(String what) {
    _die();
    throw NoiseCallError(what);
  }

  TransportResult send(Uint8List plaintext) {
    if (_dead) return _deadTransport;
    if (_gated && !_confirmed) _mistake('sending before the initiator\'s first message');
    if (plaintext.length > maxPlaintext) _mistake('plaintext of ${plaintext.length} bytes, over $maxPlaintext');
    try {
      return TransportResult._(bytes: sendCipher.encrypt(nullptr, 0, plaintext));
    } catch (_) {
      _die();
      rethrow;
    }
  }

  TransportResult receive(Uint8List message) {
    if (_dead) return _deadTransport;
    if (message.length < tagBytes || message.length > maxMessage) {
      _die();
      return const TransportResult._(reason: NoiseReason.length);
    }
    final Uint8List? plaintext;
    try {
      plaintext = receiveCipher.decrypt(nullptr, 0, message);
    } catch (_) {
      _die();
      rethrow;
    }
    if (plaintext == null) {
      _die();
      return const TransportResult._(reason: NoiseReason.decrypt);
    }
    _confirmed = true;
    return TransportResult._(bytes: plaintext);
  }

  /// Zeroes both keys; every later call gives dead.
  void close() => _die();

  void _die() {
    _dead = true;
    _b.free();
  }
}

/// Throws unless [k] is 32 bytes.
void _checkKey(Uint8List? k, String what) {
  if (k == null || k.length != keyBytes) throw NoiseCallError('$what is not $keyBytes bytes');
}

class Handshake implements Finalizable {
  /// [remoteStatic] is the responder's static key, which an IK initiator
  /// knows; [psk] XXpsk3's; [ephemeral], the ephemeral secret key, random
  /// when null, is the tests'. [payloads] is whether handshake messages may
  /// carry payloads: PiRC's never do, so each has a fixed length; the
  /// published vectors' do. Every input is copied here, the static key, the
  /// PSK and the ephemeral key into native memory, and the caller's own
  /// copies are left as they are; the prologue is read once, here.
  Handshake({
    required this.pattern,
    required this.initiator,
    required SecureKey staticKey,
    Uint8List? remoteStatic,
    required Uint8List prologue,
    Uint8List? psk,
    Uint8List? ephemeral,
    required this.payloads,
    @visibleForTesting NoiseNatives natives = const NoiseNatives(),
  }) : _natives = natives {
    if (staticKey.length != keyBytes) throw NoiseCallError('the static key is not $keyBytes bytes');
    final knowsRemote = pattern.responderKnown && initiator;
    if (knowsRemote) {
      _checkKey(remoteStatic, 'the responder\'s static key');
      _rs = Uint8List.fromList(remoteStatic!);
    } else if (remoteStatic != null) {
      throw NoiseCallError('a remote static key this side cannot know');
    }
    if (pattern.psk) {
      _checkKey(psk, 'the PSK');
    } else if (psk != null) {
      throw NoiseCallError('a PSK for a pattern without one');
    }
    if (ephemeral != null) _checkKey(ephemeral, 'the ephemeral secret key');

    _b = _Block(_blockBytes);
    try {
      staticKey.runUnlockedSync((k) => _b.view(_s, keyBytes).setAll(0, k));
      if (_ffi.crypto_scalarmult_base(_u(_b.at(_pub)), _u(_b.at(_s))) != 0) throw StateError('noise: crypto_scalarmult_base failed');
      _staticPublic = Uint8List.fromList(_b.view(_pub, keyBytes));
      if (psk != null) {
        _b.view(_psk, keyBytes).setAll(0, psk);
      }
      if (ephemeral != null) {
        _b.view(_e, keyBytes).setAll(0, ephemeral);
        _hasE = true;
      }
      symmetric = SymmetricState._(_b, pattern.name, natives);
      symmetric.mixHashBytes(prologue);
      if (pattern.responderKnown) symmetric.mixHashBytes(initiator ? _rs! : _staticPublic);
    } catch (_) {
      _b.free();
      rethrow;
    }
  }

  final NoisePattern pattern;
  final bool initiator;
  final bool payloads;
  final NoiseNatives _natives;
  late final _Block _b;
  late final SymmetricState symmetric;
  late final Uint8List _staticPublic;
  bool _dead = false;
  int _index = 0;
  bool _hasE = false;
  Uint8List? _re;
  Uint8List? _rs;

  bool get dead => _dead;

  /// The other side's static key once a message has carried it (at an IK
  /// responder, not yet confirmed); null while unknown and once dead.
  Uint8List? get remoteStatic {
    final rs = _rs;
    return rs != null && !_dead ? Uint8List.fromList(rs) : null;
  }

  /// A copy of the ephemeral secret key, null once zeroed and freed. Tests only.
  @visibleForTesting
  Uint8List? get ephemeralSecret => _b.freed ? null : Uint8List.fromList(_b.view(_e, keyBytes));

  HandshakeResult writeMessage([Uint8List? payload]) => _call(true, () => _write(payload ?? Uint8List(0)));

  HandshakeResult readMessage(Uint8List message) => _call(false, () => _read(message));

  HandshakeResult _call(bool writing, HandshakeResult Function() body) {
    if (_dead) return _deadHandshake;
    if (_index >= pattern.messages.length) _mistake('the handshake is over');
    final mine = (_index % 2 == 0) == initiator;
    if (mine != writing) _mistake(writing ? 'writing out of turn' : 'reading out of turn');
    try {
      final r = body();
      if (!r.ok) _die();
      return r;
    } catch (_) {
      _die();
      rethrow;
    }
  }

  Never _mistake(String what) {
    _die();
    throw NoiseCallError(what);
  }

  /// A message's length without its payload: 32 bytes for e, 48 for s (its
  /// tag: a key is always mixed in before it), and the payload's tag.
  int _fixedLength(List<Token> tokens) {
    var n = tagBytes;
    for (final t in tokens) {
      n += switch (t) {
        Token.e => keyBytes,
        Token.s => keyBytes + tagBytes,
        _ => 0,
      };
    }
    return n;
  }

  /// A DH token's keys: whether the local one is the ephemeral key, and the remote one.
  (bool, Uint8List) _dhKeys(Token t) {
    final i = initiator;
    final localE = t == Token.ee || (t == Token.es && i) || (t == Token.se && !i);
    final remoteE = t == Token.ee || (t == Token.es && !i) || (t == Token.se && i);
    return (localE, remoteE ? _re! : _rs!);
  }

  /// A DH, its output mixed into the key, or a failure; the output zeroed.
  /// libsodium refuses a result of all zeros, and it is checked again here.
  HandshakeResult? _dhToken(Token t) {
    final (localE, remote) = _dhKeys(t);
    _b.view(_peer, keyBytes).setAll(0, remote);
    final out = _b.at(_dh);
    final rc = _natives.scalarmult(_u(out), _u(_b.at(localE ? _e : _s)), _u(_b.at(_peer)));
    if (rc != 0 || _isZero(out, keyBytes)) {
      _ffi.sodium_memzero(out.cast(), keyBytes);
      return _failure(NoiseReason.dh);
    }
    symmetric.mixKey(out, keyBytes);
    _ffi.sodium_memzero(out.cast(), keyBytes);
    return null;
  }

  Uint8List _ephemeral() {
    if (!_hasE) {
      _ffi.randombytes_buf(_b.at(_e).cast(), keyBytes);
      _hasE = true;
    }
    if (_ffi.crypto_scalarmult_base(_u(_b.at(_pub)), _u(_b.at(_e))) != 0) throw StateError('noise: crypto_scalarmult_base failed');
    return Uint8List.fromList(_b.view(_pub, keyBytes));
  }

  HandshakeResult _write(Uint8List payload) {
    if (payload.isNotEmpty && !payloads) _mistake('a handshake payload');
    final tokens = pattern.messages[_index];
    if (_fixedLength(tokens) + payload.length > maxMessage) _mistake('payload too long');
    final s = symmetric;
    final out = BytesBuilder(copy: false);
    for (final t in tokens) {
      switch (t) {
        case Token.e:
          final e = _ephemeral();
          out.add(e);
          s.mixHashBytes(e);
          if (pattern.psk) s.mixKeyBytes(e);
        case Token.s:
          out.add(s.encryptAndHash(_staticPublic));
        case Token.psk:
          s.mixKeyAndHash(_b.at(_psk), keyBytes);
        case Token.ee || Token.es || Token.se || Token.ss:
          final f = _dhToken(t);
          if (f != null) return f;
      }
    }
    out.add(s.encryptAndHash(payload));
    _index++;
    return HandshakeResult._(message: out.takeBytes(), transport: _finish());
  }

  HandshakeResult _read(Uint8List given) {
    // Read more than once: a copy, in case given is a view of native memory
    // that another thread writes.
    final message = Uint8List.fromList(given);
    final tokens = pattern.messages[_index];
    final fixed = _fixedLength(tokens);
    if (message.length > maxMessage || (payloads ? message.length < fixed : message.length != fixed)) return _failure(NoiseReason.length);
    final s = symmetric;
    var at = 0;
    for (final t in tokens) {
      switch (t) {
        case Token.e:
          // A view of the message's copy, which nothing writes.
          final re = Uint8List.sublistView(message, at, at + keyBytes);
          _re = re;
          at += keyBytes;
          s.mixHashBytes(re);
          if (pattern.psk) s.mixKeyBytes(re);
        case Token.s:
          final rs = s.decryptAndHash(Uint8List.sublistView(message, at, at + keyBytes + tagBytes));
          if (rs == null) return _failure(NoiseReason.decrypt);
          _rs = rs;
          at += keyBytes + tagBytes;
        case Token.psk:
          s.mixKeyAndHash(_b.at(_psk), keyBytes);
        case Token.ee || Token.es || Token.se || Token.ss:
          final f = _dhToken(t);
          if (f != null) return f;
      }
    }
    final payload = s.decryptAndHash(Uint8List.sublistView(message, at));
    if (payload == null) return _failure(NoiseReason.decrypt);
    _index++;
    return HandshakeResult._(payload: payload, transport: _finish());
  }

  /// After the last message: the transport, and the handshake's block zeroed and freed.
  Transport? _finish() {
    if (_index < pattern.messages.length) return null;
    final keys = _Block(2 * keyBytes);
    symmetric._split(keys);
    final hash = symmetric.h;
    // IK's responder waits for the initiator's static key to be shown, and
    // XXpsk3's initiator for the PSK; only the first may not send meanwhile.
    final ikResponder = pattern.responderKnown && !initiator;
    final xxInitiator = pattern.psk && initiator;
    final confirmed = !ikResponder && !xxInitiator;
    // rs is never written after it is set, and both hand out only copies.
    final transport = Transport._(keys, _rs!, hash, confirmed, ikResponder, initiator, _natives);
    _b.free();
    return transport;
  }

  void _die() {
    _dead = true;
    _b.free();
  }
}
