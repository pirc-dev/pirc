// A joining phone's check of the accept (lib/hosted/join.dart, checkAccept),
// each refusal with accepts made here: the phone's offer, version 1, the
// newer version, and the name shown.
import 'dart:convert';
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sodium/sodium_sumo.dart';

import 'package:pirc/e2e/join.dart';
import 'package:pirc/e2e/list.dart';
import 'package:pirc/gen/pirc/v1alpha2/account.pb.dart';
import 'package:pirc/hosted/join.dart';

void main() {
  late E2e e2e;
  late SodiumSumo sodium;
  setUpAll(() async {
    e2e = await E2e.load();
    sodium = e2e.sodium;
  });

  // A device's keys and its Device, all five keys if a phone.
  ({KeyPair signing, Device device}) keys(int role, bool phone) {
    final s = sodium.crypto.sign.keyPair();
    Uint8List k() => sodium.crypto.box.keyPair().publicKey;
    return (
      signing: s,
      device: Device(role: role, signingKey: s.publicKey, channelKey: k(), boxKey: k(), readOnlyKey: phone ? sodium.crypto.sign.keyPair().publicKey : null, notificationKey: phone ? k() : null),
    );
  }

  final hh = Uint8List.fromList(List.filled(64, 7));
  Uint8List sign(KeyPair k, Uint8List m) => sodium.crypto.sign.detached(message: m, secretKey: k.secretKey);

  // An accept as an honest phone sends it, with what a case changes.
  ({JoinAccept accept, Device phone, Device self}) honest() {
    final p = keys(roleClient, true);
    final self = keys(roleClient, true).device;
    final v1 = e2e.makeList(phone: p.signing, devices: [p.device], counter: Int64.ONE);
    final body = Uint8List.sublistView(v1, signatureBytes);
    final v2 = e2e.makeList(phone: p.signing, devices: [p.device, self], previousBody: body, accountId: e2e.sha256(body), counter: Int64(2));
    final accept = JoinAccept(phone: JoinOffer.fromBuffer(makeOffer(p.device, hh, (m) => sign(p.signing, m))), first: v1, list: v2, phoneName: utf8.encode('Pixel 9'));
    return (accept: accept, phone: p.device, self: self);
  }

  Joined check(JoinAccept a, Device phone, Device self, {Uint8List? remote}) => checkAccept(e2e, a, remoteStatic: remote ?? Uint8List.fromList(phone.channelKey), handshakeHash: hh, self: self);
  Matcher fails(String m) => throwsA(isA<JoinFailed>().having((e) => e.message, 'message', m));

  test('an honest accept: the account, the counter, the name', () {
    final h = honest();
    final j = check(h.accept, h.phone, h.self);
    expect(j.accountId, e2e.sha256(Uint8List.sublistView(Uint8List.fromList(h.accept.first), signatureBytes)));
    expect(j.counter, Int64(2));
    expect(j.phoneName, 'Pixel 9');
  });

  test("the phone's offer: absent, under another channel key, not a phone", () {
    final h = honest();
    expect(() => check(h.accept.deepCopy()..clearPhone(), h.phone, h.self), fails('the phone sent no offer'));
    expect(() => check(h.accept, h.phone, h.self, remote: Uint8List(32)), fails("the phone's offer was refused (channel-key)"));
    final b = keys(roleClient, false);
    final browser = h.accept.deepCopy()..phone = JoinOffer.fromBuffer(makeOffer(b.device, hh, (m) => sign(b.signing, m)));
    expect(() => check(browser, b.device, h.self), fails('the device that answered is not a phone'));
  });

  test('version 1: not signed by the phone, or holding another phone with its signing key', () {
    final h = honest();
    final other = keys(roleClient, true);
    final notIts = h.accept.deepCopy()..first = e2e.makeList(phone: other.signing, devices: [other.device], counter: Int64.ONE);
    expect(() => check(notIts, h.phone, h.self), fails('version 1 of the list was refused (signature)'));
    // The phone's offer signed by its own key, but version 1 holds other keys beside it.
    final p = keys(roleClient, true);
    final listed = p.device.deepCopy()..boxKey = other.device.boxKey;
    final v1 = e2e.makeList(phone: p.signing, devices: [listed], counter: Int64.ONE);
    final a = JoinAccept(phone: JoinOffer.fromBuffer(makeOffer(p.device, hh, (m) => sign(p.signing, m))), first: v1, list: h.accept.list);
    expect(() => check(a, p.device, h.self), fails("version 1 of the list is not that phone's"));
  });

  test('the newer version: without this device as it is, or of another account', () {
    final h = honest();
    expect(() => check(h.accept, h.phone, h.self.deepCopy()..boxKey = Uint8List(32)), fails('the list was refused (self)'));
    expect(() => check(h.accept, h.phone, h.self.deepCopy()..role = roleComputer), fails('the list was refused (self)'));
    final again = honest();
    final mixed = h.accept.deepCopy()..list = again.accept.list;
    expect(() => check(mixed, h.phone, again.self), fails('the list was refused (signature)'));
  });

  test("the name: control and format characters dropped; one over 200 bytes not shown", () {
    final h = honest();
    expect(check(h.accept.deepCopy()..phoneName = utf8.encode('Pix\u0007el\u202E 9'), h.phone, h.self).phoneName, 'Pixel 9');
    expect(check(h.accept.deepCopy()..phoneName = utf8.encode('x' * 201), h.phone, h.self).phoneName, '');
  });

  test('adding: refused for keys on the list already, or past 10 clients or 50 computers', () {
    final phone = keys(roleClient, true).device;
    final computer = keys(roleComputer, false).device;
    final browser = keys(roleClient, false).device;
    ListBody list(List<Device> d) => ListBody(devices: d);
    expect(refuseAdding(list([phone]), computer), isNull);
    expect(refuseAdding(list([phone, computer]), computer.deepCopy()..signingKey = Uint8List(32)), 'that device is on the list already');
    expect(refuseAdding(list([phone]), phone.deepCopy()..channelKey = Uint8List(32)..boxKey = Uint8List(32)), 'that device is on the list already');
    final nine = [phone, for (var i = 0; i < 8; i++) keys(roleClient, false).device];
    final fortyNine = [for (var i = 0; i < 49; i++) keys(roleComputer, false).device];
    expect(refuseAdding(list([...nine, ...fortyNine]), browser), isNull);
    expect(refuseAdding(list([...nine, ...fortyNine]), computer), isNull);
    expect(refuseAdding(list([...nine, browser, ...fortyNine]), keys(roleClient, true).device), 'the account has 10 phones and browsers, the most it can');
    expect(refuseAdding(list([...nine, ...fortyNine, computer]), keys(roleComputer, false).device), 'the account has 50 computers, the most it can');
  });
}
