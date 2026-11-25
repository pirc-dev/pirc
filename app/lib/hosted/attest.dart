// The phone's attestation for a sign-up or a join (relay.proto,
// Attestation; docs/design.md, step 14, stage 4): App Attest or Play
// Integrity over framed("pirc-attest-v1alpha2", origin, the login's nonce,
// the key), with the store's proof of the subscription when there is one.
// A build made with --dart-define=PIRC_TEST_ATTEST=true sends the test
// attestation instead, which only a relay started with a test verifier
// takes: simulators and emulators cannot attest.
import 'dart:convert' show utf8;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../e2e/framed.dart';
import '../gen/pirc/v1alpha2/relay.pb.dart';

const testAttest = bool.fromEnvironment('PIRC_TEST_ATTEST');
const _attestContext = 'pirc-attest-v1alpha2';
const _attest = MethodChannel('dev.pirc.app/attest');
const _store = MethodChannel('dev.pirc.app/store');

/// The attestation this phone gives for one login.
Future<Attestation> platformAttest(String origin, Uint8List nonce, Uint8List publicKey) async {
  if (testAttest) return Attestation(test: [1]);
  final data = framed(_attestContext, [utf8.encode(origin), nonce, publicKey]);
  final got = await _attest.invokeMapMethod<String, Object?>('attest', data);
  if (got == null) throw StateError('the phone gave no attestation');
  final a = defaultTargetPlatform == TargetPlatform.iOS
      ? Attestation(appAttest: AppAttest(keyId: got['keyId']! as Uint8List, attestation: got['attestation']! as Uint8List))
      : Attestation(playIntegrity: PlayIntegrity(token: got['token']! as String));
  // None during a trial the relay counts itself.
  final proof = await storeProof();
  if (proof != null) a.subscription = proof;
  return a;
}

/// The store's proof of this phone's subscription, as the relay checks it
/// (Apple's signed transaction, Google's purchase token); null for none,
/// or in a build without a store.
Future<String?> storeProof() async {
  try {
    return await _store.invokeMethod<String>('proof');
  } on MissingPluginException {
    return null;
  }
}

/// The proof as RenewSubscription carries it, by store.
RenewSubscription renewWith(String requestId, String proof) => defaultTargetPlatform == TargetPlatform.iOS
    ? RenewSubscription(requestId: requestId, appStoreTransaction: proof)
    : RenewSubscription(requestId: requestId, googlePlayToken: proof);

/// The App Store's storefront country (ISO 3166-1 alpha-3) on iOS; null on
/// Android, where Play has no China mainland store. On iOS a storefront
/// that cannot be had is said as unknownStorefront: the hosted relay is
/// then not offered (decision 6), but to a build for simulators, which
/// have no App Store account.
Future<String?> hostedStorefront() async {
  if (defaultTargetPlatform != TargetPlatform.iOS) return null;
  try {
    final c = await _store.invokeMethod<String>('storefront');
    return c ?? (testAttest ? null : unknownStorefront);
  } on Object {
    return unknownStorefront;
  }
}

const unknownStorefront = 'unknown';

/// China mainland's storefront, where the hosted relay is not offered
/// (docs/design.md, step 14, decision 6).
const chinaMainland = 'CHN';
