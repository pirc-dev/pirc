// cases/e2e, run against the Dart port of crypto/ (app/lib/e2e), as
// crypto/test/primitives.test.ts and objects.test.ts run it against the
// TypeScript: Ed25519 as every verifier must decide it, the CFRG's HPKE
// vector, CPace's draft-21 vectors, and every signed object, check, seal
// and step of the join in objects.json. Where the vectors fix the random
// values, what Dart seals and signs must be the same bytes.
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:protobuf/protobuf.dart' show PbFieldType;

import 'package:pirc/e2e/bytes.dart';
import 'package:pirc/e2e/cpace.dart' as cp;
import 'package:pirc/e2e/ed25519.dart' as ed25519;
import 'package:pirc/e2e/hpke.dart' as hpke;
import 'package:pirc/e2e/join.dart' as join;
import 'package:pirc/e2e/keys.dart' as keys;
import 'package:pirc/e2e/list.dart' as list;
import 'package:pirc/e2e/objects.dart';
import 'package:pirc/e2e/utf8_check.dart';
import 'package:pirc/gen/pirc/v1alpha1/common.pb.dart';
import 'package:pirc/gen/pirc/v1alpha2/e2e.pb.dart';
import 'package:pirc/gen/pirc/v1alpha2/relay.pbenum.dart';

typedef Json = Map<String, dynamic>;

const cases = '../cases/e2e';

Json readCase(String name) => jsonDecode(File('$cases/$name').readAsStringSync()) as Json;

void main() {
  test('the caps: 256 hosts, 32 clients, 32 read-only keys', () {
    Device d(DeviceRole r) => Device(role: r);
    List<Device> n(DeviceRole r, int k) => List.generate(k, (_) => d(r));
    expect(list.overCaps([...n(DeviceRole.DEVICE_ROLE_HOST, list.maxHosts), ...n(DeviceRole.DEVICE_ROLE_CLIENT, list.maxClients), ...n(DeviceRole.DEVICE_ROLE_READ_ONLY, list.maxClients)]), isNull);
    expect(list.overCaps(n(DeviceRole.DEVICE_ROLE_HOST, list.maxHosts + 1)), 'more than 256 hosts');
    expect(list.overCaps(n(DeviceRole.DEVICE_ROLE_CLIENT, list.maxClients + 1)), 'more than 32 clients');
    expect(list.overCaps(n(DeviceRole.DEVICE_ROLE_READ_ONLY, list.maxClients + 1)), 'more than 32 clients');
  });

  group('primitives', () {
    test('Ed25519: every vector decided as the rule says', () async {
      for (final v in readCase('ed25519.json')['vectors'] as List) {
        final got = await ed25519.verify(unhex(v['public_key']), unhex(v['message']), unhex(v['signature']));
        expect(got, v['valid'], reason: v['name']);
      }
    });

    test('Ed25519: a key from its seed signs what verifies', () async {
      final s = await ed25519.SeedSigner.fromSeed(List.filled(32, 7));
      final m = utf8('m');
      expect(await ed25519.verify(s.publicKey, m, await s.sign(m)), isTrue);
    });

    test("HPKE: the CFRG's vector, schedule and single-shot seal", () async {
      final v = readCase('hpke.json')['vector'] as Json;
      final e = await hpke.x25519FromPrivate(unhex(v['skEm']));
      final r = await hpke.x25519FromPrivate(unhex(v['skRm']));
      expect(hex(e.publicKey), v['pkEm']);
      expect(hex(r.publicKey), v['pkRm']);
      final dh = await hpke.x25519(e, r.publicKey);
      final s = await hpke.testSchedule(dh, e.publicKey, r.publicKey, unhex(v['info']));
      expect(hex(s.sharedSecret), v['shared_secret']);
      expect(hex(s.key), v['key']);
      expect(hex(s.baseNonce), v['base_nonce']);
      final first = (v['encryptions'] as List).first as Json;
      final sealed = await hpke.seal(r.publicKey, unhex(v['info']), unhex(first['aad']), unhex(first['pt']), ephemeral: e);
      expect(hex(sealed), v['enc'] + first['ct']);
      final opened = await hpke.open(r, unhex(v['info']), unhex(first['aad']), sealed);
      expect(hex(opened!), first['pt']);
      expect(await hpke.open(r, unhex(v['info']), unhex('00'), sealed), isNull);
    });

    test("CPace: draft 21's generator and exchange", () async {
      final c = readCase('cpace.json');
      final g = c['calculate_generator'] as Json;
      final gen = await cp.calculateGenerator(join.env, unhex(g['PRS']), unhex(g['CI']), unhex(g['sid']));
      expect(hex(gen.g), g['generator g']);
      final x = c['exchange'] as Json;
      final a = await cp.start(join.env,
          prs: unhex(x['PRS']), ci: unhex(x['CI']), sid: unhex(x['sid']), ad: unhex(x['ADa']), y: unhex(x['ya']));
      final b = await cp.start(join.env,
          prs: unhex(x['PRS']), ci: unhex(x['CI']), sid: unhex(x['sid']), ad: unhex(x['ADb']), y: unhex(x['yb']));
      expect(hex(a.share), x['Ya']);
      expect(hex(b.share), x['Yb']);
      final ia = await cp.finish(join.env, a, cp.Role.initiator, b.share, b.ad);
      final ib = await cp.finish(join.env, b, cp.Role.responder, a.share, a.ad);
      expect(hex(ia.isk), x['ISK_IR']);
      expect(hex(ib.isk), x['ISK_IR']);
    });

    test("CPace: every low-order point ends the exchange; the others give draft 21's K", () async {
      final c = readCase('cpace.json')['scalar_mult_vfy_low_order'] as Json;
      final y = unhex(c['s']);
      final mustAbort = (c['must_abort'] as List).cast<String>();
      var seen = 0;
      for (final MapEntry(key: name, :value) in c.entries) {
        if (!name.startsWith('Invalid Y')) continue;
        seen++;
        if (mustAbort.contains(name)) {
          await expectLater(cp.scalarMultVfy(join.env, y, unhex(value)), throwsA(isA<cp.CPaceAbort>()), reason: name);
        } else {
          expect(hex(await cp.scalarMultVfy(join.env, y, unhex(value))), (c['q'] as Json)[name], reason: name);
        }
      }
      expect(seen, 12);
    });
  });

  group('objects.json', () {
    final file = readCase('objects.json');
    final account = unhex(file['account_id']);
    final now = int.parse(file['now_ms']);
    final objs = file['objects'] as Json;
    SignedObject obj(String name) => decode(unhex(objs[name]['encoded']));
    Json dev(String n) => file['devices'][n] as Json;
    Future<hpke.X25519Pair> preKeyOf(String n) => hpke.x25519FromPrivate(unhex(dev(n)['pre_key_private']));
    final sk = file['sending_keys'] as Json;

    Future<list.Version> v3() async =>
        list.checkNext(account, await list.checkNext(account, await list.checkFirst(obj('v1')), obj('v2')), obj('v3'));

    test('every object in refused is refused, though its signature checks', () async {
      final refused = file['refused'] as List;
      expect(refused, isNotEmpty);
      for (final r in refused.cast<Json>()) {
        final o = decode(unhex(r['encoded']));
        final acct = unhex(r['account_id']);
        expect(await ed25519.verify(o.signer, framed('pirc-e2e-v1 ${r['kind']}', [acct, o.body]), o.signature), isTrue, reason: r['about']);
        final kind = {'bundle': Kind.bundle}[r['kind']]!;
        // Dart's protobuf alone takes it, with U+FFFD in place of the bytes.
        expect(BundleBody.fromBuffer(o.body).instanceId, contains("\ufffd"));
        expect(await open(kind, acct, o), isNull, reason: r['about']);
      }
    });

    test('the UTF-8 check refuses wire bytes no decoder takes, and does not crash on them', () {
      final named = JoinDeviceBody(name: 'ab').writeToBuffer();
      // The name's key, 0x22, as ten bytes; the tenth holding bit 63, or more.
      final key63 = [0xa2, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01];
      expect(stringsAreUtf8(JoinDeviceBody().info_, [...key63, 0x02, 0x61, 0x62]), isFalse, reason: 'a key with bit 63');
      final key64 = [...key63.sublist(0, 9), 0x02];
      expect(stringsAreUtf8(JoinDeviceBody().info_, [...key64, 0x02, 0x61, 0x62]), isFalse, reason: 'a key over 64 bits');
      final eleven = [0xa2, for (var i = 0; i < 9; i++) 0x80, 0x00];
      expect(stringsAreUtf8(JoinDeviceBody().info_, [...eleven, 0x02, 0x61, 0x62]), isFalse, reason: 'an eleven-byte varint');
      // The name's length as 2^63 - 1, and as 2^63 + 2: refused, not read.
      final big = [0x22, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, 0x61, 0x62];
      expect(stringsAreUtf8(JoinDeviceBody().info_, big), isFalse, reason: 'a length of 2^63 - 1');
      final bit63 = [0x22, 0x82, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01, 0x61, 0x62];
      expect(stringsAreUtf8(JoinDeviceBody().info_, bit63), isFalse, reason: 'a length with bit 63');
      expect(stringsAreUtf8(JoinDeviceBody().info_, named), isTrue);
    });

    test('JoinDevice holds no string: its signed body is what objects.open checks', () {
      for (final f in JoinDevice().info_.fieldInfo.values) {
        expect(PbFieldType.baseType(f.type), isNot(PbFieldType.STRING_BIT), reason: f.name);
      }
    });

    test("the UTF-8 check: nested messages' strings checked, a valid U+FFFD taken", () {
      final good = JoinDevice(device: SignedObject(body: [1])).writeToBuffer();
      expect(stringsAreUtf8(JoinDevice().info_, good), isTrue);
      final named = JoinDeviceBody(name: 'caf\u00e9 \ufffd').writeToBuffer();
      expect(stringsAreUtf8(JoinDeviceBody().info_, named), isTrue);
      final bad = Uint8List.fromList(named)..[named.length - 1] = 0xff;
      expect(stringsAreUtf8(JoinDeviceBody().info_, bad), isFalse);
      // Nested: a JoinResult's approval's approver name.
      final r = JoinResult(approval: JoinApproval(approverName: 'abcd')).writeToBuffer();
      final i = r.indexOf(0x64); // 'd'
      expect(stringsAreUtf8(JoinResult().info_, r), isTrue);
      expect(stringsAreUtf8(JoinResult().info_, Uint8List.fromList(r)..[i] = 0xc3), isFalse);
      // An unknown group, field 50, with a nested group and a string in it,
      // is skipped as the decoders skip it; one never ended is refused.
      final grouped = [...named, 0x93, 0x03, 0x9b, 0x03, 0x9c, 0x03, 0x0a, 0x01, 0x41, 0x94, 0x03];
      expect(JoinDeviceBody.fromBuffer(grouped).name, 'caf\u00e9 \ufffd');
      expect(stringsAreUtf8(JoinDeviceBody().info_, grouped), isTrue);
      expect(stringsAreUtf8(JoinDeviceBody().info_, [...named, 0x93, 0x03]), isFalse);
    });

    test('framed strings', () {
      for (final f in file['framed'] as List) {
        expect(hex(framed(f['context'], [for (final p in f['parts'] as List) unhex(p)])), f['out']);
      }
    });

    test('every body encodes from its JSON to the signed bytes, and every hash', () async {
      for (final MapEntry(key: name, value: o as Json) in objs.entries) {
        final body = Kind.byName(o['kind']).create()..mergeFromProto3Json(o['json']);
        expect(hex(canonical(body).writeToBuffer()), o['body'], reason: name);
        expect(hex(await hash(obj(name))), o['hash'], reason: name);
        expect(hex(encode(obj(name))), o['encoded'], reason: name);
      }
    });

    test('every signature verifies, and Dart signs the same bytes', () async {
      final seeds = <String, String>{
        for (final d in (file['devices'] as Json).values) d['public_key']: d['seed'],
        file['join']['new_device']['public_key']: file['join']['new_device']['seed'],
      };
      for (final MapEntry(key: name, value: o as Json) in objs.entries) {
        final kind = Kind.byName(o['kind']);
        final signed = signedBytes(kind, unhex(o['account_id']), unhex(o['body']));
        final ok = await ed25519.verify(unhex(o['signer']), signed, unhex(o['signature']));
        // Changed after signing, to be refused.
        final tampered = name == 'x-bad-signature';
        expect(ok, !tampered, reason: name);
        if (tampered) continue;
        final signer = await ed25519.SeedSigner.fromSeed(unhex(seeds[o['signer']]!));
        expect(hex(await signer.sign(signed)), o['signature'], reason: name);
      }
    });

    test('sign encodes once, signs those bytes, and refuses another signer', () async {
      final phone = await ed25519.SeedSigner.fromSeed(unhex(dev('phone')['seed']));
      final tablet = await ed25519.SeedSigner.fromSeed(unhex(dev('tablet')['seed']));
      final body = ListVersionBody.fromBuffer(obj('v2').body);
      final o = await sign(Kind.list, account, phone, body);
      expect(hex(encode(o)), objs['v2']['encoded']);
      await expectLater(sign(Kind.list, account, tablet, body), throwsArgumentError);
      expect(await open(Kind.list, account, o), body);
      expect(await open(Kind.list, empty, o), isNull);
      expect(await open(Kind.withdrawal, account, o), isNull);
    });

    test('every check decided as the file says', () async {
      Future<list.Version> v(String name, [list.Version? prev]) =>
          name == 'v1' ? list.checkFirst(obj(name)) : list.checkNext(account, prev!, obj(name));
      final vs = <String, list.Version>{};
      vs['v1'] = await v('v1');
      vs['v2'] = await v('v2', vs['v1']);
      vs['v3'] = await v('v3', vs['v2']);
      vs['v4a'] = await v('v4a', vs['v3']);
      vs['v4b'] = await v('v4b', vs['v3']);
      for (final c in file['checks'] as List) {
        var valid = true;
        String? why;
        try {
          final o = obj(c['object']);
          switch (c['check']) {
            case 'first':
              await list.checkFirst(o);
            case 'next':
              await list.checkNext(account, vs[c['prev']]!, o);
            case 'withdrawal':
              await list.checkWithdrawal(account, vs[c['prev']]!, o);
            default:
              await list.checkPreKey(account, vs[c['prev']]!.body, o, now);
          }
        } on list.Refused catch (e) {
          valid = false;
          why = e.message;
        }
        expect(valid, c['valid'], reason: c['about']);
        // Refused for the same reason as the TypeScript.
        expect(why, c['why'], reason: c['about']);
      }
      expect(hex(vs['v1']!.hash), file['account_id']);
    });

    test('the sending keys, and what each device unwraps from the bundle', () async {
      final keysOf = await keys.sendingKeys(unhex(sk['secret']), unhex(sk['key_id']), account, unhex(sk['host_key']));
      expect(hex(keysOf.announcement), sk['announcement']);
      expect(hex(keysOf.conversation), sk['conversation']);
      final b = await open(Kind.bundle, account, obj('bundle'));
      expect(b, isNotNull);
      final list3 = await v3();
      for (final u in file['bundle']['unwraps'] as List) {
        final got = await keys.unwrap(account, b!, list3.body,
            publicKey: unhex(dev(u['device'])['public_key']), preKey: await preKeyOf(u['device']));
        expect(got == null ? null : hex(got.announcement), u['announcement'], reason: u['device']);
        expect(got?.conversation == null ? null : hex(got!.conversation!), u['conversation'], reason: u['device']);
      }
      // A read-only key's wrap holds the announcement key and nothing else.
      final read = b!.recipients.firstWhere((r) => hex(r.publicKey) == dev('phone-read')['public_key']);
      expect(read.conversationKey, isEmpty);
      // A bundle naming a device off the list gives nobody anything.
      final list4a = await list.checkNext(account, list3, obj('v4a'));
      expect(await keys.unwrap(account, b, list4a.body, publicKey: unhex(dev('phone')['public_key']), preKey: await preKeyOf('phone')),
          isNull);
      // With the file's ephemerals, the same recipients, byte for byte; the stranger's pre-key is left out.
      final ephemerals = [for (final e in file['bundle']['ephemerals'] as List) unhex(e)];
      var i = 0;
      final recipients = await keys.wrapFor(
        list3.body,
        [
          for (final n in ['phone-read', 'stranger', 'tablet', 'phone'])
            (publicKey: unhex(dev(n)['public_key']), preKey: unhex(dev(n)['pre_key'])),
        ],
        keysOf,
        accountId: account,
        hostKey: unhex(sk['host_key']),
        keyId: unhex(sk['key_id']),
        ephemeral: () => hpke.x25519FromPrivate(ephemerals[i++]),
      );
      expect(i, ephemerals.length);
      expect(recipients, b.recipients);
    });

    test('frames open only where they were sealed', () async {
      final session = SessionRef()..mergeFromProto3Json(file['frames']['session']);
      for (final f in file['frames']['frames'] as List) {
        final k = unhex(f['key'] == 'announcement' ? sk['announcement'] : sk['conversation']);
        keys.FrameAt at({SessionRef? s, List<int>? recipient, FrameKind? kind, int counter = 0, int listVersion = 0}) =>
            keys.FrameAt(
              accountId: account,
              keyId: unhex(sk['key_id']),
              session: s ?? session,
              kind: kind ?? FrameKind.values.firstWhere((x) => x.name == 'FRAME_KIND_${f['kind']}'),
              recipient: recipient ?? unhex(f['recipient']),
              listVersion: Int64.parseInt(f['list_version']) + listVersion,
              counter: Int64.parseInt(f['counter']) + counter,
            );
        final here = at();
        expect(hex(keys.frameAad(here)), f['aad'], reason: f['about']);
        expect(hex((await keys.openFrame(k, here, unhex(f['ciphertext'])))!), f['plaintext'], reason: f['about']);
        expect(hex(await keys.sealFrame(k, here, unhex(f['plaintext']))), f['ciphertext'], reason: f['about']);
        // Moved to another session, another client, another kind or counter: it fails.
        for (final moved in [
          at(s: session.deepCopy()..sessionId = 'another'),
          at(recipient: (f['recipient'] as String).isNotEmpty ? empty : unhex(dev('tablet')['public_key'])),
          at(kind: here.kind == FrameKind.FRAME_KIND_BROADCAST ? FrameKind.FRAME_KIND_ANSWER : FrameKind.FRAME_KIND_BROADCAST),
          at(counter: 1),
          at(listVersion: 1),
        ]) {
          expect(await keys.openFrame(k, moved, unhex(f['ciphertext'])), isNull, reason: f['about']);
        }
      }
      final ann = (file['frames']['frames'] as List).first;
      expect(await open(Kind.announcement, account, decode(unhex(ann['plaintext']))), isNotNull);
    });

    test("the envelope opens with the request key, and is the phone's", () async {
      final e = file['envelope'] as Json;
      final rk = await hpke.x25519FromPrivate(unhex(file['bundle']['request_key_private']));
      final hostKey = unhex(sk['host_key']), keyId = unhex(sk['key_id']);
      final plain = await keys.openEnvelope(rk, account, hostKey, keyId, unhex(e['sealed']));
      expect(hex(plain!), objs['envelope']['encoded']);
      final body = await open(Kind.request, account, decode(plain));
      expect(hex(body!.signer), dev('phone')['public_key']);
      expect(await keys.openEnvelope(rk, account, hostKey, Uint8List(16), unhex(e['sealed'])), isNull);
      final again = await keys.sealEnvelope(rk.publicKey, account, hostKey, keyId, plain,
          ephemeral: await hpke.x25519FromPrivate(unhex(e['ephemeral'])));
      expect(hex(again), e['sealed']);
    });

    test("labels and the label key's wraps", () async {
      final l = file['labels'] as Json;
      final labelKey = unhex(l['label_key']);
      final rec = (await open(Kind.labels, account, obj(l['object'])))!;
      final got = await keys.openLabels(labelKey, account, rec.labelKey, rec.counter, rec.sealed);
      final want = Labels()..mergeFromProto3Json(l['labels']);
      expect(got, want);
      expect(hex(await keys.sealLabels(labelKey, account, rec.labelKey, rec.counter, want, nonce: unhex(l['nonce']))),
          hex(rec.sealed));
      expect(await keys.openLabels(labelKey, account, rec.labelKey, rec.counter + 1, rec.sealed), isNull);
      for (final w in l['wraps'] as List) {
        final body = (await open(Kind.labelKey, account, obj(w['object'])))!;
        final me = unhex(dev(w['device'])['public_key']);
        expect(hex((await keys.unwrapLabelKey(await preKeyOf(w['device']), account, body.labelKey, me, body.wrap))!),
            l['label_key']);
        final again = await keys.wrapLabelKey(body.preKey, account, body.labelKey, me, labelKey,
            ephemeral: await hpke.x25519FromPrivate(unhex(w['ephemeral'])));
        expect(hex(again), hex(body.wrap));
        // Not for another device.
        expect(
            await keys.unwrapLabelKey(
                await preKeyOf('phone'), account, body.labelKey, unhex(dev('phone')['public_key']), body.wrap),
            isNull);
      }
    });

    test('a join, step by step', () async {
      final j = file['join'] as Json;
      final code = join.readCode('k7qm 2xrp9');
      expect(code?.lookup, j['lookup']);
      expect(code?.secret, j['secret']);
      expect(join.readCode('K7QM-2XRPU'), isNull);
      expect(join.readCode('k7qm-2xrpi'), (lookup: 'K7QM', secret: '2XRP1'));
      expect(hex(join.channelId(j['origin'], j['lookup'])), j['channel_id']);
      final prs = utf8(j['secret']), ci = unhex(j['channel_id']), sid = unhex(j['nonce']);
      final d = await cp.start(join.env, prs: prs, ci: ci, sid: sid, ad: empty, y: unhex(j['device_scalar']));
      final c = await cp.start(join.env, prs: prs, ci: ci, sid: sid, ad: empty, y: unhex(j['client_scalar']));
      expect(hex(d.share), j['device_share']);
      expect(hex(c.share), j['client_share']);
      final isk = (await cp.finish(join.env, c, cp.Role.responder, d.share, empty)).isk;
      expect(hex(isk), j['isk']);
      expect(hex((await cp.finish(join.env, d, cp.Role.initiator, c.share, empty)).isk), j['isk']);
      final k = await join.keys(isk, ci, sid, d.share, c.share);
      expect(hex(k.transcript), j['transcript']);
      expect({
        'device_confirm': hex(k.deviceConfirm),
        'client_confirm': hex(k.clientConfirm),
        'device_seal': hex(k.deviceSeal),
        'client_seal': hex(k.clientSeal),
      }, j['keys']);
      expect(hex(await join.confirmation(k.clientConfirm, k.transcript)), j['client_confirmation']);
      expect(await join.confirmed(k.clientConfirm, k.transcript, unhex(j['client_confirmation'])), isTrue);
      expect(await join.confirmed(k.deviceConfirm, k.transcript, unhex(j['device_confirmation'])), isTrue);
      expect(await join.confirmed(k.deviceConfirm, k.transcript, unhex(j['client_confirmation'])), isFalse);

      // The client's side: open the device's message, check it, seal the approval.
      final ch = join.clientChannel(k);
      final devicePlain = (await ch.open(unhex(j['device_message']['sealed'])))!;
      expect(hex(devicePlain), j['device_message']['plaintext']);
      final signedDevice = JoinDevice.fromBuffer(devicePlain).device;
      final body = (await open(Kind.join, empty, signedDevice))!;
      expect(hex(body.transcript), j['transcript']);
      expect(hex(await ch.seal(unhex(j['approval']['plaintext']))), j['approval']['sealed']);
      expect(hex(ch.transcript), j['transcript_after']);
      expect(JoinResult.fromBuffer(unhex(j['approval']['plaintext'])).whichResult(), JoinResult_Result.approval);

      // The device's side: the same sealed bytes from the same keys, and the approval opens.
      final dch = join.deviceChannel(k);
      expect(hex(await dch.seal(devicePlain)), j['device_message']['sealed']);
      expect(hex((await dch.open(unhex(j['approval']['sealed'])))!), j['approval']['plaintext']);
      expect(hex(dch.transcript), j['transcript_after']);
      // Opened twice, the second is under the next counter and transcript: it fails.
      expect(await dch.open(unhex(j['approval']['sealed'])), isNull);

      // A wrong code: CPace's keys differ, and the confirmation fails.
      final wrong = await cp.start(join.env, prs: utf8('2XRP8'), ci: ci, sid: sid, ad: empty, y: unhex(j['client_scalar']));
      final iskWrong = (await cp.finish(join.env, wrong, cp.Role.responder, d.share, empty)).isk;
      final kw = await join.keys(iskWrong, ci, sid, d.share, wrong.share);
      expect(await join.confirmed(k.clientConfirm, k.transcript, await join.confirmation(kw.clientConfirm, kw.transcript)),
          isFalse);
    });

    test('a new code reads back as itself', () {
      for (var i = 0; i < 20; i++) {
        final c = join.newCode();
        expect(join.readCode(c.shown), (lookup: c.lookup, secret: c.secret));
      }
    });
  });
}
