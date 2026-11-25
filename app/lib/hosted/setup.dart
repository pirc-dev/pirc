// A hosted account made, joined or opened on this phone (docs/e2e.md,
// sections 2, 6 and 7), and run: the connection and the sessions for the
// app's Client.
//
// The phone's seeds are kept in the key store under the account's relay
// key, `pirc-e2e:` and the relay's origin, which no self-hosted relay's
// address can be: the main seed behind Face ID or the PIN when the lock is
// on, the read seed from the first unlock. A sign-up or a join that fails
// leaves no seed behind.
import 'dart:async';
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';

import '../core/view.dart' show RelayView;
import '../e2e/list.dart';
import '../gen/pirc/v1alpha1/relay.pb.dart' as v1;
import '../gen/pirc/v1alpha2/relay.pb.dart';
import '../keys/key_store.dart';
import 'account.dart';
import 'attest.dart' show renewWith;
import 'connection.dart';
import 'join.dart';
import 'keys.dart';
import 'link.dart';
import 'sessions.dart';

const hostedScheme = 'pirc-e2e:';

/// How many times a sign-up is sent before it is given up.
const signUpAttempts = 3;

/// PiRC's hosted relay, until it has a domain of its own (docs/design.md,
/// step 14, stage 6).
const hostedRelay = String.fromEnvironment('PIRC_HOSTED_ORIGIN', defaultValue: 'wss://hosted-test.pirc.dev');

/// The relay key the app keeps for a hosted account (AppPrefs.relay).
String hostedRelayKey(String origin) => '$hostedScheme${hostedOrigin(origin)}';

/// The origin in a relay key, or null for a self-hosted relay's address.
String? hostedOriginOf(String relay) => relay.startsWith(hostedScheme) ? relay.substring(hostedScheme.length) : null;

/// What a sign-up or join attests (relay.proto, Attestation): for the
/// login whose [nonce] is given, by the key [publicKey], at [origin].
typedef Attest = Future<Attestation> Function(String origin, Uint8List nonce, Uint8List publicKey);

class SignUpFailed implements Exception {
  const SignUpFailed(this.message);
  final String message;
  @override
  String toString() => message;
}

/// A new account's keys, before it exists.
class _NewKeys {
  _NewKeys(this.e2e)
      : mainSeed = e2e.sodium.randombytes.buf(seedBytes),
        readSeed = e2e.sodium.randombytes.buf(seedBytes) {
    main = MainKeys.fromSeed(e2e.sodium, mainSeed);
    read = ReadKeys.fromSeed(e2e.sodium, readSeed);
  }

  final E2e e2e;
  final Uint8List mainSeed;
  final Uint8List readSeed;
  late final MainKeys main;
  late final ReadKeys read;

  Future<void> keep(KeyStore store, String relay, {required bool protect}) async {
    await store.store(relay, KeyKind.main, mainSeed, protect: protect);
    await store.store(relay, KeyKind.read, readSeed, protect: false);
  }

  void wipe() {
    mainSeed.fillRange(0, mainSeed.length, 0);
    readSeed.fillRange(0, readSeed.length, 0);
  }
}

/// The account open on this phone: its keys held while the app is unlocked.
class OpenAccount {
  OpenAccount(this.account, this.main, this.read, List<int> mainSeed) : mainSeed = Uint8List.fromList(mainSeed);
  final HostedAccount account;
  final MainKeys main;
  final ReadKeys read;

  /// The main seed, for Settings to keep it again when the lock changes.
  final Uint8List mainSeed;

  void dispose() {
    main.dispose();
    read.dispose();
    mainSeed.fillRange(0, mainSeed.length, 0);
  }
}

/// Makes an account at [origin] with this phone as its phone: new seeds
/// kept, version 1 signed, the sign-up attested, then the account kept.
Future<OpenAccount> signUp({
  required E2e e2e,
  required KeyStore store,
  required KeyValues values,
  required String origin,
  required Attest attest,
  required bool protect,
  String inviteCode = '',
}) async {
  origin = hostedOrigin(origin);
  final relay = hostedRelayKey(origin);
  // One account on a phone: a second would take the first's place.
  if (await values.get(accountKey) != null) throw const SignUpFailed('this phone has an account already');
  final k = _NewKeys(e2e);
  var kept = false;
  try {
    final self = phoneDevice(k.main, k.read);
    // Version 1 is a new key's first signature; the counter file, which
    // may hold an earlier account's, is for the versions after it.
    final first = e2e.makeList(phone: k.main.signing, devices: [self], counter: Int64.ONE);
    await k.keep(store, relay, protect: protect);
    kept = true;
    // The relay answers the same key and version 1 with the same account
    // again, so an answer lost to the network is asked for again rather
    // than leaving an account nobody holds.
    Frame? answer;
    Object? lost;
    for (var attempt = 0; attempt < signUpAttempts && answer == null; attempt++) {
      try {
        final link = await HostedLink.connect(origin: origin, publicKey: k.main.signing.publicKey, sign: (m) async => k.main.sign(m));
        try {
          final attestation = await attest(origin, link.nonce, k.main.signing.publicKey).timeout(const Duration(seconds: 30));
          link.send(Frame(signUp: SignUp(requestId: 'signup', attestation: attestation, list: first, inviteCode: inviteCode)));
          answer = await link.frames.firstWhere((f) => (f.hasSignedUp() || f.hasError()) && (f.hasSignedUp() ? f.signedUp.requestId : f.error.requestId) == 'signup').timeout(const Duration(seconds: 30));
        } finally {
          await link.close();
        }
      } on SignUpFailed {
        rethrow;
      } on LinkError catch (e) {
        // The relay refused the login itself: no account was made. A
        // connection that only dropped is tried again, below.
        if (e.refused) throw SignUpFailed('the relay refused: $e');
        lost = e;
      } on Object catch (e) {
        lost = e;
      }
    }
    if (answer == null) throw SignUpFailed('could not reach the relay: $lost');
    if (answer.hasError()) throw SignUpFailed(answer.error.message.isEmpty ? 'the relay refused the sign-up' : 'the relay refused: ${answer.error.message}');
    final accountId = e2e.sha256(Uint8List.sublistView(first, signatureBytes));
    if (!_same(answer.signedUp.accountId, accountId)) throw const SignUpFailed('the relay answered with another account');
    final account = await HostedAccount.create(e2e, values, origin: origin, accountId: accountId, phoneKey: k.main.signing.publicKey, self: self, first: first, newest: first);
    return OpenAccount(account, k.main, k.read, k.mainSeed);
  } catch (e) {
    k.main.dispose();
    k.read.dispose();
    if (kept) await store.delete(relay);
    if (e is SignUpFailed) rethrow;
    throw SignUpFailed('the sign-up failed: $e');
  } finally {
    k.wipe();
  }
}

bool _same(List<int> a, List<int> b) => a.length == b.length && Iterable<int>.generate(a.length).every((i) => a[i] == b[i]);

/// This phone joining an account as a client: the code to show and the
/// join's end, which keeps the account once joined.
class JoiningPhone {
  JoiningPhone._(this._join, Future<(OpenAccount, Joined)> both)
      : done = both.then((b) => b.$1),
        joined = both.then((b) => b.$2) {
    // Each is for whoever waits on it; a failure unwaited is no error.
    done.ignore();
    joined.ignore();
  }

  final PhoneJoin _join;

  /// The account, kept and open, once joined.
  final Future<OpenAccount> done;

  /// The join as the screen shows it, once the account is kept.
  final Future<Joined> joined;

  String get text => _join.text;

  void cancel() => _join.cancel();

  static Future<JoiningPhone> start({
    required E2e e2e,
    required KeyStore store,
    required KeyValues values,
    required String origin,
    required Attest attest,
    required bool protect,
  }) async {
    origin = hostedOrigin(origin);
    final relay = hostedRelayKey(origin);
    if (await values.get(accountKey) != null) throw const JoinFailed('this phone has an account already');
    final k = _NewKeys(e2e);
    final self = phoneDevice(k.main, k.read);
    final HostedLink link;
    final Attestation attestation;
    try {
      link = await HostedLink.connect(origin: origin, publicKey: k.main.signing.publicKey, sign: (m) async => k.main.sign(m));
      attestation = await attest(origin, link.nonce, k.main.signing.publicKey).timeout(const Duration(seconds: 30)).catchError((Object e) {
        unawaited(link.close());
        throw e;
      });
    } catch (e) {
      k.main.dispose();
      k.read.dispose();
      k.wipe();
      throw JoinFailed('could not reach the relay: $e');
    }
    final join = PhoneJoin(
      e2e: e2e,
      self: self,
      channel: k.main.channel.secretKey,
      link: link,
      random: e2e.sodium.randombytes.buf,
      sign: k.main.sign,
      attestation: attestation,
    );
    Future<(OpenAccount, Joined)> finish() async {
      try {
        final j = await join.done();
        // An account kept meanwhile (a sign-up) is not written over.
        if (await values.get(accountKey) != null) throw const JoinFailed('this phone has an account already');
        await k.keep(store, relay, protect: protect);
        try {
          final account = await HostedAccount.create(e2e, values, origin: origin, accountId: j.accountId, phoneKey: j.phoneKey, self: self, first: j.first, newest: j.list);
          return (OpenAccount(account, k.main, k.read, k.mainSeed), j);
        } catch (_) {
          await store.delete(relay);
          rethrow;
        }
      } catch (e) {
        k.main.dispose();
        k.read.dispose();
        if (e is JoinFailed) rethrow;
        throw JoinFailed('the join failed: $e');
      } finally {
        k.wipe();
      }
    }

    return JoiningPhone._(join, finish());
  }
}

/// The account kept on this phone, opened: its main seed asked for with
/// [reason]. Null when the phone has no seed or no account for it (the
/// app reinstalled, or the account forgotten). Throws KeyUnavailable when
/// the person declines, AccountUnreadable when what is kept does not
/// check out.
Future<OpenAccount?> openAccount({required E2e e2e, required KeyStore store, required KeyValues values, required String relay, String reason = 'Unlock PiRC'}) async {
  final account = await HostedAccount.load(e2e, values);
  if (account == null || hostedRelayKey(account.origin) != relay) return null;
  final mainSeed = await store.load(relay, KeyKind.main, reason: reason);
  final readSeed = await store.load(relay, KeyKind.read);
  if (mainSeed == null || readSeed == null) return null;
  try {
    final main = MainKeys.fromSeed(e2e.sodium, mainSeed);
    final read = ReadKeys.fromSeed(e2e.sodium, readSeed);
    // The seeds are this account's only if they give the phone it lists.
    if (!sameDevice(phoneDevice(main, read), account.self)) {
      main.dispose();
      read.dispose();
      throw const AccountUnreadable('the keys kept are not this account\'s');
    }
    return OpenAccount(account, main, read, mainSeed);
  } finally {
    mainSeed.fillRange(0, mainSeed.length, 0);
    readSeed.fillRange(0, readSeed.length, 0);
  }
}

/// An open account connected: the relay connection and the sessions for
/// the app's Client, which sends through [send].
class HostedRun {
  HostedRun({
    required E2e e2e,
    required this.open,
    required void Function(v1.Frame f) toClient,
    required void Function(RelayView r) relayState,
    void Function()? onRemoved,
    KeyValues? values,
    void Function(Welcome w)? onWelcome,
  }) {
    final a = open.account;
    conn = HostedConnection(
      origin: a.origin,
      accountId: a.accountId,
      publicKey: open.main.signing.publicKey,
      sign: (m) async => open.main.sign(m),
      listCounter: () => a.newest.counter,
      onFrame: (f) => sessions.onFrame(f),
      onState: (s) => sessions.onState(s),
    );
    sessions = HostedSessions(e2e: e2e, account: a, main: open.main, sendRelay: conn.send, toClient: toClient, relayState: relayState, onRemoved: onRemoved, values: values, onWelcome: onWelcome);
  }

  final OpenAccount open;
  late final HostedConnection conn;
  late final HostedSessions sessions;

  bool send(v1.Frame f) => sessions.fromClient(f);
  void start() => conn.start();
  void stop() => conn.stop();

  /// A subscription the store proves, for a locked account or one whose
  /// subscriptions end; done once the store says it is live, and then a
  /// locked account's connection closes and logs in again, unlocked.
  Future<void> renew(String proof) {
    final id = sessions.requestId('r');
    return sessions.request(id, Frame(renewSubscription: renewWith(id, proof)), timeout: const Duration(seconds: 60));
  }

  /// Deletes the account and everything the relay holds of it; only the
  /// account's phone may. Done before the relay closes every connection.
  Future<void> deleteAccount() {
    final id = sessions.requestId('d');
    return sessions.request(id, Frame(deleteAccount: DeleteAccount(requestId: id)));
  }

  /// Stops for good; the keys go with it.
  void dispose() {
    conn.stop();
    sessions.dispose();
    open.dispose();
  }
}
