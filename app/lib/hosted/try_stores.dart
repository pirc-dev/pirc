// The stores' checks tried on a real phone (docs/design.md, step 14, stage
// 4): a sign-up on a hosted relay, with new keys made here and dropped
// after, signing the list's version 1 (lib/e2e/list.dart), the phone's
// attestation for that login (App Attest, or Play
// Integrity) and its subscription as the store proves it (Apple's signed
// transaction, or Google's purchase token); the relay's answer shown as
// it came. Only in a build with --dart-define=PIRC_HOSTED=true, never in
// a release until the hosted relay ships (stage 6).
import 'dart:async';
import 'dart:convert' as convert;
import 'dart:io';

import 'package:fixnum/fixnum.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:sodium/sodium_sumo.dart' show KeyPair;

import '../core/protocol.dart' show hex;
import '../e2e/framed.dart';
import '../e2e/list.dart';
import '../gen/pirc/v1alpha1/common.pbenum.dart' show ErrorCode;
import '../gen/pirc/v1alpha2/account.pb.dart';
import '../gen/pirc/v1alpha2/relay.pb.dart';
import '../ui/look.dart';
import '../ui/adaptive.dart';

const hostedBuild = bool.fromEnvironment('PIRC_HOSTED');

// The hosted relay's test address, used until the relay has its own
// domain (docs/design.md, step 14, stage 6).
const tryRelay = 'wss://hosted-test.pirc.dev';

// What the login signs, and what the attestation binds
// (relay/internal/hosted: AuthContext, AttestContext).
const _authContext = 'pirc-auth-v1alpha2';
const _attestContext = 'pirc-attest-v1alpha2';

const _attest = MethodChannel('dev.pirc.app/attest');
const _store = MethodChannel('dev.pirc.app/store');

/// The relay's refusal of a sign-up with no code while sign-ups are by
/// invite.
const inviteNeeded = 'sign-ups need an invite code';

Uint8List _utf8(String s) => Uint8List.fromList(convert.utf8.encode(s));

// One sign-up, step by step into log; the relay's answer last.
Future<void> trySignUp(String origin, void Function(String) log) async {
  final e2e = await E2e.load();
  final sodium = e2e.sodium;
  // The phone's signing key, which logs in and signs version 1, and its
  // other keys, all thrown away: only their public halves are listed.
  final phone = sodium.crypto.sign.keyPair();
  final readOnly = sodium.crypto.sign.keyPair();
  final boxes = [for (var i = 0; i < 3; i++) sodium.crypto.box.keyPair()];
  try {
    await _signUp(origin, log, e2e, phone, readOnly, boxes);
  } finally {
    for (final k in [phone, readOnly, ...boxes]) {
      k.secretKey.dispose();
    }
  }
}

Future<void> _signUp(String origin, void Function(String) log, E2e e2e, KeyPair phone, KeyPair readOnly, List<KeyPair> boxes) async {
  final sodium = e2e.sodium;
  final list = e2e.makeList(
    phone: phone,
    devices: [
      Device(
        role: roleClient,
        signingKey: phone.publicKey,
        channelKey: boxes[0].publicKey,
        boxKey: boxes[1].publicKey,
        readOnlyKey: readOnly.publicKey,
        notificationKey: boxes[2].publicKey,
      ),
    ],
    counter: Int64.ONE,
  );
  log('version 1 of the list: ${list.length} bytes');

  log('connecting to $origin');
  final ws = await WebSocket.connect('$origin/v1alpha2').timeout(const Duration(seconds: 15));
  final frames = StreamIterator(ws.where((m) => m is List<int>).map((m) => Frame.fromBuffer(m as List<int>)));
  Future<Frame> next() async {
    if (!await frames.moveNext().timeout(const Duration(seconds: 60))) {
      throw StateError('the relay closed the connection (${ws.closeCode} ${ws.closeReason})');
    }
    return frames.current;
  }

  try {
    ws.add(Frame(hello: Hello(protocolVersion: ProtocolVersion.PROTOCOL_VERSION_V1ALPHA2, publicKey: phone.publicKey)).writeToBuffer());
    final challenge = await next();
    if (!challenge.hasChallenge()) throw StateError('expected Challenge, got ${challenge.whichBody()}');
    final nonce = challenge.challenge.nonce;
    final sig = sodium.crypto.sign.detached(message: framed(_authContext, [Uint8List(0), _utf8(origin), nonce]), secretKey: phone.secretKey);
    ws.add(Frame(auth: Auth(signature: sig)).writeToBuffer());
    final welcome = await next();
    if (!welcome.hasWelcome()) {
      throw StateError('expected Welcome, got ${welcome.whichBody()}${welcome.hasError() ? ': ${welcome.error.message}' : ''}');
    }
    log('logged in without an account');

    final data = framed(_attestContext, [_utf8(origin), nonce, phone.publicKey]);
    final att = Attestation();
    final got = await _attest.invokeMapMethod<String, Object?>('attest', data);
    if (defaultTargetPlatform == TargetPlatform.iOS) {
      att.appAttest = AppAttest(keyId: got!['keyId']! as Uint8List, attestation: got['attestation']! as Uint8List);
      log('App Attest: key ${hex(att.appAttest.keyId).substring(0, 16)}…, ${att.appAttest.attestation.length} bytes');
    } else {
      att.playIntegrity = PlayIntegrity(token: got!['token']! as String);
      log('Play Integrity: a token of ${att.playIntegrity.token.length} characters');
    }
    final proof = await _store.invokeMethod<String>('proof');
    if (proof == null) {
      log('no subscription on this store account: the relay will refuse');
    } else {
      att.subscription = proof;
      log('subscription proof: ${proof.length} characters');
    }

    ws.add(Frame(signUp: SignUp(requestId: 'try', attestation: att, list: list)).writeToBuffer());
    for (;;) {
      final f = await next();
      if (f.hasSignedUp()) {
        log('SIGNED UP: account ${hex(f.signedUp.accountId).substring(0, 16)}…');
        return;
      }
      if (f.hasError()) {
        // Expected while sign-ups are by invite: the relay asks for the
        // code before it looks at the attestation or the subscription.
        if (f.error.code == ErrorCode.ERROR_CODE_TOKEN_INVALID && f.error.message == inviteNeeded) {
          log('Sign-ups on this relay need an invite code, as expected while they are by invite. The relay asks for it first, so the attestation and the subscription were not checked.');
          return;
        }
        log('REFUSED (${f.error.code.name}): ${f.error.message}');
        return;
      }
    }
  } finally {
    await ws.close();
  }
}

class TryStoresScreen extends StatefulWidget {
  const TryStoresScreen({super.key});

  @override
  State<TryStoresScreen> createState() => _TryStoresScreenState();
}

class _TryStoresScreenState extends State<TryStoresScreen> {
  final _origin = TextEditingController(text: tryRelay);
  final _lines = <String>[];
  bool _running = false;

  @override
  void dispose() {
    _origin.dispose();
    super.dispose();
  }

  Future<void> _run() async {
    setState(() {
      _running = true;
      _lines.clear();
    });
    void log(String s) {
      if (mounted) setState(() => _lines.add(s));
    }

    try {
      await trySignUp(_origin.text.trim(), log);
    } on Object catch (e) {
      log('FAILED: $e');
    } finally {
      if (mounted) setState(() => _running = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return CupertinoPageScaffold(
      navigationBar: CupertinoNavigationBar(leading: barLeading(context), middle: const Text("The stores' checks")),
      child: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text("Signs up on a hosted relay with new keys, sending a list of this phone alone, its attestation and its subscription. The keys are dropped afterwards.", style: look.text()),
            const SizedBox(height: 12),
            CupertinoTextField(selectionControls: fieldHandles, contextMenuBuilder: fieldMenu, magnifierConfiguration: fieldMagnifier, controller: _origin, autocorrect: false, keyboardType: TextInputType.url),
            const SizedBox(height: 12),
            Press.filled(onPressed: _running ? null : _run, child: Text(_running ? 'Trying…' : 'Try a sign-up')),
            const SizedBox(height: 16),
            for (final l in _lines) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(l, style: look.text(size: 15))),
            if (_lines.isNotEmpty && !_running)
              Press(onPressed: () => Clipboard.setData(ClipboardData(text: _lines.join('\n'))), child: const Text('Copy')),
          ],
        ),
      ),
    );
  }
}
