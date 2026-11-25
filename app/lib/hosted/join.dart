// Joins (docs/e2e.md, section 6), the app's two sides of them:
//
//   - AddDevice: the account's phone adding a device whose code it scanned
//     or was given as text. It looks the code up at the relay, runs Noise
//     XXpsk3 as the initiator with the code's secret, and takes the new
//     device's signed offer; the screen then says what the device is and
//     asks the person to confirm. Only then is the version of the list that
//     adds the device signed and published, and, once the relay has taken
//     it, sent to the device with version 1 and the phone's own offer.
//   - PhoneJoin: a second phone joining an account as a client, as
//     relay-client/join.ts's DeviceJoin does for a computer or a browser:
//     it shows a code, waits under its lookup, answers the handshake, sends
//     its offer, and takes the phone's accept only if the list it brings
//     holds this phone exactly.
//
// The relay sees the lookup and the steps' sizes; never the secret, and
// nothing a step holds.
import 'dart:async';
import 'dart:convert' show utf8;
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:sodium/sodium_sumo.dart' show KeyPair, SecureKey;

import '../e2e/bytes.dart';
import '../e2e/join.dart';
import '../e2e/list.dart';
import '../e2e/noise.dart';
import '../gen/pirc/v1alpha1/common.pb.dart' as common;
import '../gen/pirc/v1alpha1/common.pbenum.dart';
import '../gen/pirc/v1alpha2/account.pb.dart';
import '../gen/pirc/v1alpha2/relay.pb.dart';
import 'link.dart';

/// How long the code works, on the new device's clock.
const joinDuration = Duration(minutes: 10);

/// How long a step of the relay's or the other side's may take.
const stepTimeout = Duration(seconds: 30);

/// The phone's name as the accept carries it: UTF-8, at most this many bytes.
const phoneNameMaxBytes = 200;

/// A join that ended without the device joining; [message] says why, for the person.
class JoinFailed implements Exception {
  const JoinFailed(this.message, {this.published});
  final String message;

  /// The version of the list the relay took although the join then failed:
  /// the account's newest now, with the device on it.
  final Uint8List? published;
  @override
  String toString() => message;
}

/// What a device offered itself as, once its offer checked out.
class Offered {
  const Offered(this.device);
  final Device device;
  bool get isComputer => device.role == roleComputer;

  /// A client with read-only and notification keys: another phone.
  bool get isPhone => device.role == roleClient && device.readOnlyKey.isNotEmpty;
}

/// What the account's phone holds that a join uses.
class PhoneAccount {
  const PhoneAccount({
    required this.accountId,
    required this.phone,
    required this.signing,
    required this.channel,
    required this.first,
    required this.newest,
    required this.name,
    required this.counter,
  });

  final Uint8List accountId;

  /// The phone as the list holds it.
  final Device phone;
  final KeyPair signing;

  /// The phone's channel key's secret half, live for the join.
  final SecureKey channel;

  /// Version 1 of the list, as signed.
  final Uint8List first;

  /// The newest version, as signed.
  final Uint8List newest;

  /// The phone's name, as the new device will say who approved it.
  final String name;

  /// The next counter, at least the one given, saved before it is used
  /// (docs/e2e.md, section 3).
  final Future<Int64> Function(Int64 atLeast) counter;
}

/// Frames from the relay, each taken once, read from the start: a frame
/// that comes while nothing waits is held, and [seen] tells of it at once.
class _Frames {
  _Frames(Stream<Frame> frames, [this._onFrame]) {
    _sub = frames.listen((f) {
      _held.add(f);
      _onFrame?.call(f);
      _wake();
    }, onDone: () {
      _closed = true;
      _wake();
    });
  }

  late final StreamSubscription<Frame> _sub;
  final void Function(Frame f)? _onFrame;
  final List<Frame> _held = [];
  var _closed = false;
  var _cancelled = false;
  Completer<void>? _waiting;

  void _wake() {
    final w = _waiting;
    _waiting = null;
    w?.complete();
  }

  /// The first frame [pick] gives a value for; others are held for later.
  Future<T> next<T>(T? Function(Frame f) pick, {Duration timeout = stepTimeout, String what = 'the relay', String? late}) async {
    final deadline = DateTime.now().add(timeout);
    for (;;) {
      for (var i = 0; i < _held.length; i++) {
        final v = pick(_held[i]);
        if (v != null) {
          _held.removeAt(i);
          return v;
        }
      }
      if (_cancelled) throw const JoinFailed('cancelled');
      if (_closed) throw const JoinFailed('the connection to the relay was lost');
      final left = deadline.difference(DateTime.now());
      final w = _waiting = Completer<void>();
      try {
        await w.future.timeout(left.isNegative ? Duration.zero : left);
      } on TimeoutException {
        throw JoinFailed(late ?? '$what did not answer in time');
      }
    }
  }

  /// Stops reading; a step waiting ends with "cancelled".
  Future<void> cancel() {
    _cancelled = true;
    _wake();
    return _sub.cancel();
  }
}

String _errorText(common.Error e) => switch (e.code) {
      ErrorCode.ERROR_CODE_SESSION_NOT_FOUND => 'no device shows that code now: check it, or start the join again on the device',
      ErrorCode.ERROR_CODE_RATE_LIMITED => 'too many codes looked up; try again in an hour',
      _ => e.message.isEmpty ? 'the relay refused the join' : 'the relay: ${e.message}',
    };

const _expired = 'the code expired after ten minutes; start the join again';

int _request = 0;
String _requestId(String kind) => '$kind${++_request}';

/// The account's phone adding a device: [start], then [confirm] or [cancel].
class AddDevice {
  /// [frames] is listened to at once, so each AddDevice needs a stream of
  /// its own, or a broadcast one.
  AddDevice({required this.e2e, required this.account, required Stream<Frame> frames, required this.send, @visibleForTesting this.listedAs}) {
    _frames = _Frames(frames, (f) {
      if (_joinId.isNotEmpty && f.hasJoinEnded() && f.joinEnded.joinId == _joinId && !_ended.isCompleted) _ended.complete();
    });
  }

  /// For the tests: the device as the new version is to list it, in place
  /// of the one offered.
  final Device Function(Device offered)? listedAs;

  final E2e e2e;
  final PhoneAccount account;
  final void Function(Frame f) send;
  late final _Frames _frames;
  final _ended = Completer<void>();
  String _joinId = '';
  NoiseTransport? _transport;
  Offered? _offered;
  bool _over = false;

  /// Completes when the device ends the join: while the person is asked,
  /// the screen says so.
  Future<void> get ended => _ended.future;

  /// Looks up the code in [text], runs the handshake and checks the new
  /// device's offer; the device it offered itself as.
  Future<Offered> start(String text) async {
    try {
      return await _start(text);
    } catch (e) {
      _end();
      if (e is JoinFailed) rethrow;
      throw JoinFailed('the join failed: $e');
    }
  }

  Future<Offered> _start(String text) async {
    final code = readJoinText(text);
    if (code == null) throw const JoinFailed('that is not a PiRC join code');
    final id = _requestId('l');
    send(Frame(joinLookup: JoinLookup(requestId: id, lookup: code.lookup)));
    _joinId = await _frames.next((f) {
      if (f.hasJoinPaired() && f.joinPaired.requestId == id) return f.joinPaired.joinId;
      if (f.hasError() && f.error.requestId == id) throw JoinFailed(_errorText(f.error));
      return null;
    });
    final hs = e2e.noise.xxpsk3Initiator(staticKey: account.channel, prologue: joinPrologue(code.lookup), psk: code.secret);
    code.secret.fillRange(0, code.secret.length, 0);
    final m1 = hs.writeMessage();
    if (!m1.ok) throw const JoinFailed('the handshake failed');
    _step(m1.message!);
    final r2 = hs.readMessage(await _nextStep());
    if (!r2.ok) throw const JoinFailed('the device\'s answer did not check out');
    final m3 = hs.writeMessage();
    if (!m3.ok || m3.transport == null) throw const JoinFailed('the handshake failed');
    final t = m3.transport!;
    _transport = t;
    _step(m3.message!);
    // A wrong code fails at the device, which ends the join: this waits for
    // the offer, or that end.
    final r = t.receive(await _nextStep());
    if (!r.ok) throw const JoinFailed('the device\'s offer did not check out');
    final int role;
    try {
      role = JoinOffer.fromBuffer(r.plaintext!).device.role;
    } catch (_) {
      throw const JoinFailed('the device\'s offer was refused (parse)');
    }
    final offer = e2e.checkOffer(offer: r.plaintext!, role: role, remoteStatic: t.remoteStatic ?? Uint8List(0), handshakeHash: t.handshakeHash);
    if (!offer.accepted) throw JoinFailed('the device\'s offer was refused (${offer.reason})');
    final d = offer.device!;
    final refused = refuseAdding(_newest(), d);
    if (refused != null) throw JoinFailed(refused);
    return _offered = Offered(d);
  }

  ListBody _newest() => ListBody.fromBuffer(Uint8List.sublistView(account.newest, signatureBytes));

  /// The person confirmed: the list that adds the device signed and
  /// published, then sent to it. The version published. Nothing is signed
  /// once the device has ended the join; should it end it after the relay
  /// took the version, JoinFailed carries that version. Where the relay
  /// does not answer the publish, whether it took the version is unknown,
  /// and the caller reads the account's newest from the relay again.
  Future<Uint8List> confirm() async {
    final offered = _offered;
    final t = _transport;
    if (offered == null || t == null || _over) throw StateError('confirm before the offer, or after the end');
    Uint8List? published;
    try {
      if (_ended.isCompleted) throw const JoinFailed('the device ended the join; nothing was added');
      final body = Uint8List.sublistView(account.newest, signatureBytes);
      final newest = ListBody.fromBuffer(body);
      final counter = await account.counter(newest.counter + Int64.ONE);
      if (_ended.isCompleted || _over) throw const JoinFailed('the device ended the join; nothing was added');
      final list = e2e.makeList(
        phone: account.signing,
        devices: [...newest.devices, listedAs?.call(offered.device) ?? offered.device],
        previousBody: body,
        accountId: account.accountId,
        counter: counter,
      );
      final id = _requestId('p');
      send(Frame(publishList: PublishList(requestId: id, list: list)));
      // The relay's answer, whatever the device does meanwhile: only it says
      // whether the device is now on the list.
      await _frames.next((f) {
        if (f.hasDone() && f.done.requestId == id) return true;
        if (f.hasError() && f.error.requestId == id) throw JoinFailed('the relay did not take the new list: ${f.error.message}');
        return null;
      }, late: 'the relay did not say whether it took the new list');
      published = list;
      if (_ended.isCompleted) {
        throw JoinFailed('the device ended the join after it was put on the list: it is on the list but did not join; remove it', published: list);
      }
      final phoneOffer = JoinOffer.fromBuffer(makeOffer(
        account.phone,
        t.handshakeHash,
        (m) => e2e.sodium.crypto.sign.detached(message: m, secretKey: account.signing.secretKey),
      ));
      final accept = JoinAccept(phone: phoneOffer, first: account.first, list: list, phoneName: utf8Cut(account.name, phoneNameMaxBytes));
      final sent = t.send(accept.writeToBuffer());
      if (!sent.ok) throw JoinFailed('the handshake failed', published: list);
      _step(sent.message!);
      _over = true;
      t.close();
      await _frames.cancel();
      return list;
    } catch (e) {
      _end();
      if (e is JoinFailed) {
        if (e.published != null || published == null) rethrow;
        throw JoinFailed(e.message, published: published);
      }
      throw JoinFailed('the join failed: $e', published: published);
    }
  }

  /// The person declined, or left the screen: the join ends at both sides.
  void cancel() => _end();

  void _step(Uint8List s) => send(Frame(joinMessage: JoinMessage(joinId: _joinId, step: s)));

  Future<Uint8List> _nextStep() => _frames.next((f) {
        if (f.hasJoinMessage() && f.joinMessage.joinId == _joinId) return Uint8List.fromList(f.joinMessage.step);
        if (f.hasJoinEnded() && f.joinEnded.joinId == _joinId) throw const JoinFailed('the device ended the join: if it says the code did not match, start again with a new code');
        return null;
      }, what: 'the device');

  void _end() {
    if (_over) return;
    _over = true;
    if (_joinId.isNotEmpty) send(Frame(joinEnded: JoinEnded(joinId: _joinId)));
    _transport?.close();
    unawaited(_frames.cancel());
  }
}

/// Why [d] cannot be added to the list [newest], or null if it can: a
/// device whose keys are on it already, or one past the caps.
String? refuseAdding(ListBody newest, Device d) {
  // The list holds each public key once, of any kind: a key of the
  // device's that the list has, or that the device gives twice, is refused.
  List<List<int>> keysOf(Device x) => [x.signingKey, x.channelKey, x.boxKey, x.readOnlyKey, x.notificationKey].where((k) => k.isNotEmpty).toList();
  final held = [for (final x in newest.devices) ...keysOf(x)];
  final mine = keysOf(d);
  for (var i = 0; i < mine.length; i++) {
    if (held.any((k) => bytesEqual(k, mine[i]))) return 'that device is on the list already';
    for (var j = 0; j < i; j++) {
      if (bytesEqual(mine[i], mine[j])) return 'that device gives one key for two';
    }
  }
  final computers = newest.devices.where((x) => x.role == roleComputer).length;
  if (d.role == roleComputer ? computers >= maxComputers : newest.devices.length - computers >= maxClients) {
    return d.role == roleComputer ? 'the account has $maxComputers computers, the most it can' : 'the account has $maxClients phones and browsers, the most it can';
  }
  return null;
}

/// What a joined phone holds after: the account and the two versions taken.
class Joined {
  const Joined({required this.accountId, required this.phoneKey, required this.first, required this.list, required this.counter, required this.phoneName});
  final Uint8List accountId;
  final Uint8List phoneKey;
  final Uint8List first;
  final Uint8List list;
  final Int64 counter;
  final String phoneName;
}

/// A phone joining an account as a client, logged in without an account:
/// its [text] shown until [done] ends. The joined phone then logs in again,
/// to the account.
class PhoneJoin {
  PhoneJoin({
    required this.e2e,
    required this.self,
    required this.channel,
    required this.link,
    required Uint8List Function(int n) random,
    required this.sign,
    this.attestation,
    Duration? duration,
    DateTime Function()? now,
  })  : _frames = _Frames(link.frames),
        _secret = random(secretBytes),
        lookup = newLookup(random),
        _duration = duration ?? joinDuration,
        _now = now ?? DateTime.now {
    text = joinText(lookup, _secret);
  }

  final E2e e2e;

  /// This phone, as the list is to hold it: a client with all five keys.
  final Device self;

  /// Its channel key's secret half, live for the join.
  final SecureKey channel;

  /// Its connection, logged in without an account, for this join alone:
  /// closed when the join ends, which ends a wait not yet paired.
  final HostedLink link;
  void send(Frame f) => link.send(f);
  final Uint8List Function(Uint8List m) sign;
  final Attestation? attestation;
  final String lookup;
  late final String text;
  final Uint8List _secret;
  final _Frames _frames;
  final Duration _duration;
  final DateTime Function() _now;
  String _joinId = '';
  NoiseTransport? _transport;
  bool _over = false;

  /// Waits under the lookup, for ten minutes on this phone's clock.
  Future<Joined> done() async {
    final deadline = _now().add(_duration);
    void inTime() {
      if (!_now().isBefore(deadline)) throw const JoinFailed(_expired);
    }

    Duration left() {
      final l = deadline.difference(_now());
      return l.isNegative ? Duration.zero : l;
    }

    try {
      send(Frame(joinWait: JoinWait(lookup: lookup, attestation: attestation)));
      _joinId = await _frames.next((f) {
        if (f.hasJoinPaired()) return f.joinPaired.joinId;
        if (f.hasError()) throw JoinFailed(f.error.code == ErrorCode.ERROR_CODE_TIMEOUT ? _expired : _errorText(f.error));
        return null;
      }, timeout: left(), late: _expired);
      inTime();
      final hs = e2e.noise.xxpsk3Responder(staticKey: channel, prologue: joinPrologue(lookup), psk: _secret);
      _secret.fillRange(0, _secret.length, 0);
      final r1 = hs.readMessage(await _nextStep(left()));
      inTime();
      if (!r1.ok) throw const JoinFailed('the phone\'s first message did not check out');
      final m2 = hs.writeMessage();
      if (!m2.ok) throw const JoinFailed('the handshake failed');
      _step(m2.message!);
      // The secret proves itself here: a wrong one fails, and the code is spent.
      final r3 = hs.readMessage(await _nextStep(left()));
      inTime();
      if (!r3.ok || r3.transport == null) throw const JoinFailed('the code did not match: start the join again');
      final t = r3.transport!;
      _transport = t;
      final offer = t.send(makeOffer(self, t.handshakeHash, sign));
      if (!offer.ok) throw const JoinFailed('the handshake failed');
      _step(offer.message!);
      // The person confirms at the account's phone: as long as the code lasts.
      final r = t.receive(await _nextStep(left()));
      inTime();
      if (!r.ok) throw const JoinFailed('the phone\'s answer did not check out');
      final JoinAccept accept;
      try {
        accept = JoinAccept.fromBuffer(r.plaintext!);
      } catch (_) {
        throw const JoinFailed('the phone\'s answer did not parse');
      }
      final joined = checkAccept(e2e, accept, remoteStatic: t.remoteStatic ?? Uint8List(0), handshakeHash: t.handshakeHash, self: self);
      _finish();
      return joined;
    } catch (e) {
      _finish();
      if (e is JoinFailed) rethrow;
      throw JoinFailed('the join failed: $e');
    }
  }

  /// Ends the join, at both sides.
  void cancel() => _finish();

  void _step(Uint8List s) => send(Frame(joinMessage: JoinMessage(joinId: _joinId, step: s)));

  Future<Uint8List> _nextStep(Duration timeout) => _frames.next((f) {
        if (f.hasJoinMessage() && f.joinMessage.joinId == _joinId) return Uint8List.fromList(f.joinMessage.step);
        if (f.hasJoinEnded() && f.joinEnded.joinId == _joinId) throw const JoinFailed('the phone ended the join');
        if (f.hasError() && f.error.code == ErrorCode.ERROR_CODE_TIMEOUT) throw const JoinFailed(_expired);
        return null;
      }, timeout: timeout, late: _expired);

  void _finish() {
    if (_over) return;
    _over = true;
    _secret.fillRange(0, _secret.length, 0);
    if (_joinId.isNotEmpty) send(Frame(joinEnded: JoinEnded(joinId: _joinId)));
    _transport?.close();
    unawaited(_frames.cancel());
    unawaited(link.close());
  }
}

/// The phone's accept, checked at a joining device that is [self]: the
/// phone's offer under the key the handshake proved, version 1 signed by it
/// and holding it as offered, and the newer version signed by it for that
/// account and holding [self] exactly. Throws JoinFailed with why not.
Joined checkAccept(E2e e2e, JoinAccept a, {required Uint8List remoteStatic, required Uint8List handshakeHash, required Device self}) {
  if (!a.hasPhone()) throw const JoinFailed('the phone sent no offer');
  final offer = e2e.checkOffer(offer: a.phone.writeToBuffer(), role: roleClient, remoteStatic: remoteStatic, handshakeHash: handshakeHash);
  if (!offer.accepted) throw JoinFailed('the phone\'s offer was refused (${offer.reason})');
  final phone = offer.device!;
  if (phone.readOnlyKey.isEmpty) throw const JoinFailed('the device that answered is not a phone');
  final first = e2e.checkList(bytes: a.first, phoneKey: phone.signingKey, mode: ListMode.first, highest: Int64.ZERO);
  if (first.result != 'accepted') throw JoinFailed('version 1 of the list was refused (${first.reason ?? first.result})');
  final d = first.list!.devices.first;
  if (!(d.role == phone.role &&
      bytesEqual(d.signingKey, phone.signingKey) &&
      bytesEqual(d.channelKey, phone.channelKey) &&
      bytesEqual(d.boxKey, phone.boxKey) &&
      bytesEqual(d.readOnlyKey, phone.readOnlyKey) &&
      bytesEqual(d.notificationKey, phone.notificationKey))) {
    throw const JoinFailed('version 1 of the list is not that phone\'s');
  }
  final newest = e2e.checkList(bytes: a.list, phoneKey: phone.signingKey, mode: ListMode.later, accountId: first.hash, highest: Int64.ONE, self: self);
  if (newest.result != 'accepted') throw JoinFailed('the list was refused (${newest.reason ?? newest.result})');
  // Shown to the person: no control or format characters.
  final name = a.phoneName.length <= phoneNameMaxBytes ? utf8.decode(a.phoneName, allowMalformed: true).replaceAll(RegExp(r'[\p{Cc}\p{Cf}]', unicode: true), '') : '';
  return Joined(
    accountId: first.hash!,
    phoneKey: Uint8List.fromList(phone.signingKey),
    first: Uint8List.fromList(a.first),
    list: Uint8List.fromList(a.list),
    counter: newest.counter!,
    phoneName: name,
  );
}
