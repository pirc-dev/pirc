// The hosted account's pieces without a relay: the phone's keys from its
// seeds, the account kept and its lists taken, the phone's counter, a
// channel's pieces and window against the IK responder, and the adapter's
// frames for the Client.
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sodium/sodium_sumo.dart';

import 'package:pirc/core/view.dart';
import 'package:pirc/e2e/bytes.dart';
import 'package:pirc/e2e/list.dart';
import 'package:pirc/e2e/noise.dart';
import 'package:pirc/gen/pirc/v1alpha1/common.pb.dart' as common;
import 'package:pirc/gen/pirc/v1alpha1/common.pbenum.dart';
import 'package:pirc/gen/pirc/v1alpha1/relay.pb.dart' as v1;
import 'package:pirc/gen/pirc/v1alpha2/account.pb.dart';
import 'package:pirc/gen/pirc/v1alpha2/channel.pb.dart';
import 'package:pirc/gen/pirc/v1alpha2/relay.pb.dart' as v2;
import 'package:pirc/hosted/account.dart';
import 'package:pirc/hosted/channel.dart';
import 'package:pirc/hosted/connection.dart';
import 'package:pirc/hosted/keys.dart';
import 'package:pirc/hosted/sessions.dart';

Uint8List seed(int n) => Uint8List.fromList(List.generate(32, (i) => (i * 31 + n) & 0xff));

class _Events implements ChannelEvents {
  final states = <(Int64, Uint8List?)>[];
  final sessions = <SessionFrame>[];
  final closes = <String>[];
  @override
  void listState(HostedChannel ch, Int64 counter, Uint8List? newer) => states.add((counter, newer));
  @override
  void session(HostedChannel ch, SessionFrame s) => sessions.add(s);
  @override
  void closed(HostedChannel ch, String why) => closes.add(why);
}

void main() {
  late E2e e2e;
  late SodiumSumo sodium;
  late MainKeys main;
  late ReadKeys read;
  late Device self;
  late Uint8List v1List;
  late Uint8List accountId;
  late Device computer;
  late KeyPair computerChannel;

  Uint8List version(Int64 counter, List<Device> devices) => e2e.makeList(
        phone: main.signing,
        devices: devices,
        previousBody: Uint8List.sublistView(v1List, signatureBytes),
        accountId: accountId,
        counter: counter,
      );

  setUpAll(() async {
    e2e = await E2e.load();
    sodium = e2e.sodium;
    main = MainKeys.fromSeed(sodium, seed(1));
    read = ReadKeys.fromSeed(sodium, seed(2));
    self = phoneDevice(main, read);
    v1List = e2e.makeList(phone: main.signing, devices: [self], counter: Int64.ONE);
    accountId = e2e.sha256(Uint8List.sublistView(v1List, signatureBytes));
    computerChannel = sodium.crypto.box.keyPair();
    computer = Device(
      role: roleComputer,
      signingKey: sodium.crypto.sign.keyPair().publicKey,
      channelKey: computerChannel.publicKey,
      boxKey: sodium.crypto.box.keyPair().publicKey,
    );
  });

  group('keys', () {
    test('the same seeds give the same keys, and no two keys are one', () {
      final again = phoneDevice(MainKeys.fromSeed(sodium, seed(1)), ReadKeys.fromSeed(sodium, seed(2)));
      expect(again.writeToBuffer(), self.writeToBuffer());
      final keys = [self.signingKey, self.channelKey, self.boxKey, self.readOnlyKey, self.notificationKey].map(hexOf).toSet();
      expect(keys.length, 5);
      expect(phoneDevice(MainKeys.fromSeed(sodium, seed(3)), read).signingKey, isNot(self.signingKey));
    });

    test('they sign as the list and the relay check', () {
      final m = Uint8List.fromList([1, 2, 3]);
      expect(sodium.crypto.sign.verifyDetached(message: m, signature: main.sign(m), publicKey: main.signing.publicKey), isTrue);
      expect(sodium.crypto.sign.verifyDetached(message: m, signature: read.sign(m), publicKey: read.readOnly.publicKey), isTrue);
      expect(() => MainKeys.fromSeed(sodium, Uint8List(31)), throwsArgumentError);
    });
  });

  group('account', () {
    Future<HostedAccount> fresh(KeyValues values) =>
        HostedAccount.create(e2e, values, origin: 'wss://relay.test', accountId: accountId, phoneKey: main.signing.publicKey, self: self, first: v1List, newest: v1List);

    test('kept and read again, checked', () async {
      final values = MemoryValues();
      final a = await fresh(values);
      expect(a.isPhone, isTrue);
      expect(a.listed, isTrue);
      final v2l = version(Int64(2), [self, computer]);
      expect(await a.take(v2l), isA<TakenNewer>());
      final b = (await HostedAccount.load(e2e, values))!;
      expect(b.newest.counter, Int64(2));
      expect(b.newest.bytes, v2l);
      expect(await HostedAccount.load(e2e, MemoryValues()), isNull);
    });

    test('what is kept and does not check out is refused', () async {
      final values = MemoryValues();
      await fresh(values);
      final kept = values.values[accountKey]!;
      // A version whose signature is not the phone's.
      final good = version(Int64(2), [self]);
      final forged = Uint8List.fromList([...List.filled(signatureBytes, 7), ...good.sublist(signatureBytes)]);
      String b64(List<int> b) => base64Url.encode(b).replaceAll('=', '');
      values.values[accountKey] = kept.replaceFirst(RegExp(r'"newest":"[^"]*"'), '"newest":"${b64(forged)}"');
      await expectLater(HostedAccount.load(e2e, values), throwsA(isA<AccountUnreadable>()));
      values.values[accountKey] = '{';
      await expectLater(HostedAccount.load(e2e, values), throwsA(isA<AccountUnreadable>()));
    });

    test('a version is taken only newer and signed by the phone', () async {
      final a = await fresh(MemoryValues());
      final changes = <Int64>[];
      a.changes.listen((l) => changes.add(l.counter));
      expect(await a.take(version(Int64(3), [self, computer])), isA<TakenNewer>());
      expect(await a.take(version(Int64(2), [self])), isA<TakenOld>());
      expect(await a.take(a.newest.bytes), isA<TakenOld>());
      final good = version(Int64(4), [self]);
      expect(await a.take([...List.filled(signatureBytes, 7), ...good.sublist(signatureBytes)]), isA<TakenRefused>());
      expect(await a.take([1, 2, 3]), isA<TakenRefused>());
      expect(changes, [Int64(3)]);
      // A version without this phone: no longer listed.
      final other = phoneDevice(MainKeys.fromSeed(sodium, seed(5)), ReadKeys.fromSeed(sodium, seed(6)));
      final b = await HostedAccount.create(e2e, MemoryValues(), origin: 'wss://relay.test', accountId: accountId, phoneKey: main.signing.publicKey, self: other, first: v1List, newest: version(Int64(5), [self, other]));
      expect(b.isPhone, isFalse);
      expect(b.listed, isTrue);
      await b.take(version(Int64(6), [self]));
      expect(b.listed, isFalse);
    });

    test('a write never lands over a newer version another writer kept', () async {
      final values = MemoryValues();
      final a = await fresh(values);
      // The notification extension took version 4 meanwhile.
      final b = (await HostedAccount.load(e2e, values))!;
      await b.take(version(Int64(4), [self, computer]));
      await a.take(version(Int64(3), [self]));
      expect((await HostedAccount.load(e2e, values))!.newest.counter, Int64(4));
    });
  });

  group('counter', () {
    test('saved before it is given, never below what is asked, across restarts', () async {
      final d = Directory.systemTemp.createTempSync('pirc-counter-');
      addTearDown(() => d.deleteSync(recursive: true));
      final path = '${d.path}/counter';
      final c = FileCounter(path);
      expect(await c.next(Int64(2)), Int64(2));
      expect(File(path).readAsStringSync().trim(), '2');
      expect(await c.next(Int64(2)), Int64(3));
      expect(await c.next(Int64(10)), Int64(10));
      // A restart reads it again and skips past what a lost write may
      // have used; an older floor still gets a higher counter.
      final again = FileCounter(path);
      expect(await again.next(Int64(4)), Int64(10 + FileCounter.restartGap + 1));
      expect(await again.next(Int64(4)), Int64(10 + FileCounter.restartGap + 2));
      File(path).writeAsStringSync('nonsense');
      await expectLater(FileCounter(path).next(Int64(2)), throwsFormatException);
    });
  });

  group('pieces', () {
    test('a frame is cut at the piece size and joined again', () {
      final frame = Uint8List.fromList(List.generate(pieceDataMax * 2 + 5, (i) => i & 0xff));
      final ps = pieces(frame);
      expect(ps.map((p) => p.length), [pieceDataMax + 1, pieceDataMax + 1, 6]);
      expect(ps.map((p) => p[0]), [0, 0, 1]);
      final j = Joiner();
      expect(j.push(ps[0]), isNull);
      expect(j.push(ps[1]), isNull);
      expect(j.push(ps[2]), frame);
      expect(j.empty, isTrue);
      expect(pieces(Uint8List(0)).single, [1]);
    });

    test('a bad flag or a frame past the cap is refused', () {
      expect(() => Joiner().push(Uint8List.fromList([2, 0])), throwsFormatException);
      expect(() => Joiner().push(Uint8List(0)), throwsFormatException);
      final j = Joiner();
      final big = Uint8List(pieceDataMax + 1);
      expect(() {
        for (var i = 0; i < 20; i++) {
          j.push(big);
        }
      }, throwsFormatException);
    });
  });

  group('channel', () {
    // A channel to a computer played here: IK's responder in Dart, the
    // relay a list of frames.
    ({HostedChannel ch, _Events events, List<v2.Frame> sent, NoiseTransport Function() handshake}) open({Uint8List? list}) {
      final sent = <v2.Frame>[];
      final events = _Events();
      final ch = HostedChannel(
        e2e: e2e,
        channelKey: main.channel.secretKey,
        hostKey: Uint8List.fromList(computer.signingKey),
        hostChannelKey: computerChannel.publicKey,
        instanceId: 'i1',
        accountId: accountId,
        list: list ?? v1List,
        send: (f) {
          sent.add(f);
          return true;
        },
        events: events,
      );
      expect(ch.open(), isTrue);
      NoiseTransport handshake() {
        final r = e2e.noise.ikResponder(staticKey: computerChannel.secretKey, accountId: accountId);
        expect(r.readMessage(Uint8List.fromList(sent.single.openChannel.message)).ok, isTrue);
        final m2 = r.writeMessage();
        ch.opened(Int64(7));
        ch.message(m2.message!);
        return m2.transport!;
      }

      return (ch: ch, events: events, sent: sent, handshake: handshake);
    }

    List<ChannelFrame> read(NoiseTransport t, List<v2.Frame> sent, {int from = 0}) => [
          for (final f in sent.skip(from))
            if (f.hasChannelMessage()) ChannelFrame.fromBuffer(Uint8List.sublistView(t.receive(Uint8List.fromList(f.channelMessage.message)).plaintext!, 1)),
        ];

    Uint8List piece(NoiseTransport t, ChannelFrame f) => t.send(pieces(f.writeToBuffer()).single).message!;

    test('the list first, then the computer\'s list state, then sessions both ways', () {
      final c = open();
      final t = c.handshake();
      final first = read(t, c.sent);
      expect(first.single.list, v1List);
      expect(c.ch.ready, isFalse);
      // Nothing of the session goes before the list state.
      expect(c.ch.sendSession('s1', Uint8List.fromList([9])), isFalse);
      c.ch.message(piece(t, ChannelFrame(listState: ListState(counter: Int64(3), list: [5, 5]))));
      expect(c.ch.ready, isTrue);
      expect(c.events.states.single.$1, Int64(3));
      expect(c.events.states.single.$2, [5, 5]);
      final n = c.sent.length;
      expect(c.ch.sendSession('s1', Uint8List.fromList([9])), isTrue);
      expect(read(t, c.sent, from: n).single.session.message, [9]);
      c.ch.message(piece(t, ChannelFrame(session: SessionFrame(sessionId: 's1', announcement: [1]))));
      expect(c.events.sessions.single.announcement, [1]);
    });

    test('at most 16 messages in flight until the computer counts them', () {
      final c = open();
      final t = c.handshake();
      read(t, c.sent);
      c.ch.message(piece(t, ChannelFrame(listState: ListState(counter: Int64.ONE))));
      final n = c.sent.length;
      for (var i = 0; i < 30; i++) {
        c.ch.sendSession('s1', Uint8List.fromList([i]));
      }
      // The list was one message of the window.
      expect(c.sent.length - n, windowMessages - 1);
      c.ch.message(piece(t, ChannelFrame(received: Int64(10))));
      expect(c.sent.length - n, windowMessages - 1 + 10);
      // A count of more than was sent ends the channel.
      c.ch.message(piece(t, ChannelFrame(received: Int64(1000))));
      expect(c.ch.over, isTrue);
      expect(c.sent.last.closeChannel.code, ErrorCode.ERROR_CODE_INVALID);
    });

    test('the client counts what it takes, every 8 messages', () {
      final c = open();
      final t = c.handshake();
      read(t, c.sent);
      c.ch.message(piece(t, ChannelFrame(listState: ListState(counter: Int64.ONE))));
      final n = c.sent.length;
      for (var i = 0; i < 8; i++) {
        c.ch.message(piece(t, ChannelFrame(session: SessionFrame(sessionId: 's1', message: [i]))));
      }
      // The list state and seven of them: eight, counted.
      expect(read(t, c.sent, from: n).single.received, Int64(8));
    });

    test('anything out of place ends it', () {
      final c = open();
      final t = c.handshake();
      read(t, c.sent);
      c.ch.message(piece(t, ChannelFrame(session: SessionFrame(sessionId: 's1', message: [1]))));
      expect(c.ch.over, isTrue);
      expect(c.events.closes.single, contains('before its list state'));

      final d = open();
      final u = d.handshake();
      read(u, d.sent);
      d.ch.message(u.send(Uint8List.fromList([7, 1])).message!);
      expect(d.ch.over, isTrue);

      final e = open();
      e.handshake();
      e.ch.message(Uint8List(40));
      expect(e.ch.over, isTrue);
      expect(e.sent.last.closeChannel.code, ErrorCode.ERROR_CODE_PERMISSION_DENIED);
    });

    test('a computer that does not hold the channel key gets no list', () {
      final c = open();
      final r = e2e.noise.ikResponder(staticKey: sodium.crypto.box.keyPair().secretKey, accountId: accountId);
      expect(r.readMessage(Uint8List.fromList(c.sent.single.openChannel.message)).ok, isFalse);
    });
  });

  group('sessions', () {
    late HostedAccount account;
    late List<v2.Frame> relay;
    late List<v1.Frame> client;
    late List<RelayView> states;
    late HostedSessions s;

    setUp(() async {
      account = await HostedAccount.create(e2e, MemoryValues(),
          origin: 'wss://relay.test', accountId: accountId, phoneKey: main.signing.publicKey, self: self, first: v1List, newest: version(Int64(2), [self, computer]));
      relay = [];
      client = [];
      states = [];
      s = HostedSessions(
        e2e: e2e,
        account: account,
        main: main,
        sendRelay: (f) {
          relay.add(f);
          return true;
        },
        toClient: client.add,
        relayState: states.add,
      );
      addTearDown(s.dispose);
    });

    Future<void> ready({Int64? counter, List<int>? list}) async {
      s.onState(HostedReady(v2.Welcome(maxFrameBytes: 1 << 20, listCounter: counter ?? account.newest.counter, list: list)));
      await Future<void>.delayed(Duration.zero);
    }

    test('ready once the relay\'s list is taken; a relay behind is given the newer one', () async {
      await ready(counter: Int64.ONE);
      expect(states.last.state, 'ready');
      expect(relay.single.publishList.list, account.newest.bytes);
    });

    test('the Client\'s frames: what the hosted relay has, and nothing else', () async {
      expect(s.fromClient(v1.Frame(subscribeSessions: v1.SubscribeSessions())), isFalse);
      await ready();
      expect(s.fromClient(v1.Frame(subscribeSessions: v1.SubscribeSessions())), isTrue);
      expect(relay.last.hasSubscribeSessions(), isTrue);
      expect(s.fromClient(v1.Frame(watchKeys: v1.WatchKeys())), isTrue);
      expect(relay.last.hasWatchDevices(), isTrue);
      expect(client.last.keys.keys.map((k) => k.role), [v1.Role.ROLE_CLIENT, v1.Role.ROLE_HOST]);
      expect(s.fromClient(v1.Frame(watchPendingHosts: v1.WatchPendingHosts())), isTrue);
      for (final f in [
        v1.Frame(issueToken: v1.IssueToken(requestId: 't')),
        v1.Frame(removeKey: v1.RemoveKey(requestId: 'r')),
        v1.Frame(approveHost: v1.ApproveHost(requestId: 'a')),
      ]) {
        expect(s.fromClient(f), isFalse);
      }
      // A request to a computer not on the list is not sent.
      expect(s.fromClient(v1.Frame(routed: v1.Routed(session: common.SessionRef(hostKey: Uint8List(32), sessionId: 's', instanceId: 'i')))), isFalse);
    });

    test('push: registered and answered as the Client expects', () async {
      await ready();
      expect(s.fromClient(v1.Frame(registerPush: v1.RegisterPush(requestId: 'p1', handle: 'h'))), isTrue);
      expect(relay.last.registerPush.handle, 'h');
      s.onFrame(v2.Frame(done: v2.Done(requestId: 'p1')));
      expect(client.last.pushChanged.requestId, 'p1');
      s.onFrame(v2.Frame(done: v2.Done(requestId: 'p1')));
      expect(client.where((f) => f.hasPushChanged()).length, 1);
    });

    test('a request to a listed computer opens its channel and waits for it', () async {
      await ready();
      final ref = common.SessionRef(hostKey: computer.signingKey, sessionId: 's1', instanceId: 'i1');
      expect(s.fromClient(v1.Frame(routed: v1.Routed(session: ref, payload: [1]))), isTrue);
      expect(relay.last.openChannel.hostKey, computer.signingKey);
      expect(relay.last.openChannel.instanceId, 'i1');
    });

    test('a computer taken off the list: its channel closed here, its sessions ended', () async {
      await ready();
      final ref = common.SessionRef(hostKey: computer.signingKey, sessionId: 's1', instanceId: 'i1');
      s.fromClient(v1.Frame(routed: v1.Routed(session: ref, payload: [1])));
      s.onFrame(v2.Frame(channelOpened: v2.ChannelOpened(requestId: relay.last.openChannel.requestId, channelId: Int64(5))));
      s.onFrame(v2.Frame(list: v2.List_(list: version(Int64(3), [self]))));
      await Future<void>.delayed(Duration.zero);
      expect(relay.last.closeChannel.channelId, Int64(5));
      expect(relay.last.closeChannel.code, ErrorCode.ERROR_CODE_PERMISSION_DENIED);
      expect(s.fromClient(v1.Frame(routed: v1.Routed(session: ref, payload: [1]))), isFalse);
    });

    test('a newer list a computer gives is taken, and given to the relay', () async {
      await ready();
      final ref = common.SessionRef(hostKey: computer.signingKey, sessionId: 's1', instanceId: 'i1');
      s.fromClient(v1.Frame(routed: v1.Routed(session: ref, payload: [1])));
      final open = relay.last.openChannel;
      final r = e2e.noise.ikResponder(staticKey: computerChannel.secretKey, accountId: accountId);
      expect(r.readMessage(Uint8List.fromList(open.message)).ok, isTrue);
      final m2 = r.writeMessage();
      final t = m2.transport!;
      s.onFrame(v2.Frame(channelOpened: v2.ChannelOpened(requestId: open.requestId, channelId: Int64(9))));
      s.onFrame(v2.Frame(channelMessage: v2.ChannelMessage(channelId: Int64(9), message: m2.message)));
      final sentList = relay.last.channelMessage;
      expect(ChannelFrame.fromBuffer(Uint8List.sublistView(t.receive(Uint8List.fromList(sentList.message)).plaintext!, 1)).list, account.newest.bytes);
      final newer = version(Int64(3), [self, computer]);
      final state = ChannelFrame(listState: ListState(counter: Int64(3), list: newer));
      s.onFrame(v2.Frame(channelMessage: v2.ChannelMessage(channelId: Int64(9), message: t.send(pieces(state.writeToBuffer()).single).message)));
      await Future<void>.delayed(Duration.zero);
      expect(account.newest.counter, Int64(3));
      expect(relay.where((f) => f.hasPublishList()).single.publishList.list, newer);
      // The request held for the channel goes once it is ready.
      final sent = relay.where((f) => f.hasChannelMessage()).last.channelMessage;
      final req = ChannelFrame.fromBuffer(Uint8List.sublistView(t.receive(Uint8List.fromList(sent.message)).plaintext!, 1));
      expect(req.session.sessionId, 's1');
      expect(req.session.message, [1]);
      // A version newer than the computer's closes the channel, to give it
      // that version by the next one.
      s.onFrame(v2.Frame(list: v2.List_(list: version(Int64(4), [self, computer]))));
      await Future<void>.delayed(Duration.zero);
      expect(relay.where((f) => f.hasCloseChannel()).single.closeChannel.channelId, Int64(9));
    });

    test('a channel given up before the relay answered its open is closed when it does', () async {
      await ready();
      final ref = common.SessionRef(hostKey: computer.signingKey, sessionId: 's1', instanceId: 'i1');
      s.fromClient(v1.Frame(routed: v1.Routed(session: ref, payload: [1])));
      final open = relay.last.openChannel;
      s.onFrame(v2.Frame(list: v2.List_(list: version(Int64(3), [self]))));
      await Future<void>.delayed(Duration.zero);
      s.onFrame(v2.Frame(channelOpened: v2.ChannelOpened(requestId: open.requestId, channelId: Int64(4))));
      expect(relay.last.closeChannel.channelId, Int64(4));
    });

    test('sealed entries that do not open open no channel', () async {
      await ready();
      s.onFrame(v2.Frame(sessionList: v2.SessionList(sessions: [
        for (var i = 0; i < 20; i++) v2.SessionEntry(session: common.SessionRef(hostKey: computer.signingKey, sessionId: 's$i', instanceId: 'i$i'), sealed: Uint8List(80)),
      ])));
      expect(client.last.sessionList.sessions, isEmpty);
      expect(relay.where((f) => f.hasOpenChannel()), isEmpty);
    });

    test('once disposed, nothing is taken or sent', () async {
      await ready();
      s.dispose();
      final n = relay.length;
      s.onFrame(v2.Frame(sessionList: v2.SessionList(sessions: [v2.SessionEntry(session: common.SessionRef(hostKey: computer.signingKey, sessionId: 's', instanceId: 'i'), sealed: Uint8List(80))])));
      s.onState(HostedReady(v2.Welcome(maxFrameBytes: 1 << 20, listCounter: account.newest.counter)));
      expect(s.fromClient(v1.Frame(routed: v1.Routed(session: common.SessionRef(hostKey: computer.signingKey, sessionId: 's', instanceId: 'i'), payload: [1]))), isFalse);
      expect(relay.length, n);
    });

    test('a sealed entry from a computer not on the list is left out', () async {
      await ready();
      s.onFrame(v2.Frame(sessionList: v2.SessionList(sessions: [v2.SessionEntry(session: common.SessionRef(hostKey: Uint8List(32), sessionId: 's', instanceId: 'i'), sealed: Uint8List(80))])));
      expect(client.last.sessionList.sessions, isEmpty);
      expect(relay.where((f) => f.hasOpenChannel()), isEmpty);
    });

    test('an account already without this phone when it logs in is removed', () async {
      final other = phoneDevice(MainKeys.fromSeed(sodium, seed(7)), ReadKeys.fromSeed(sodium, seed(8)));
      final values = MemoryValues();
      final b = await HostedAccount.create(e2e, values,
          origin: 'wss://relay.test', accountId: accountId, phoneKey: main.signing.publicKey, self: other, first: v1List, newest: version(Int64(2), [self, other]));
      await b.take(version(Int64(3), [self]));
      final again = (await HostedAccount.load(e2e, values))!;
      var removed = false;
      final t = HostedSessions(e2e: e2e, account: again, main: MainKeys.fromSeed(sodium, seed(7)), sendRelay: (_) => true, toClient: (_) {}, relayState: states.add, onRemoved: () => removed = true);
      addTearDown(t.dispose);
      t.onState(HostedReady(v2.Welcome(maxFrameBytes: 1 << 20, listCounter: Int64(3))));
      await Future<void>.delayed(Duration.zero);
      expect(removed, isTrue);
      expect(states.last.state, 'refused');
    });

    test('a version without this phone ends everything, said as removed', () async {
      var removed = false;
      // A second phone of the account, which the phone takes off the list.
      final second = MainKeys.fromSeed(sodium, seed(7));
      final secondRead = ReadKeys.fromSeed(sodium, seed(8));
      final other = phoneDevice(second, secondRead);
      final b = await HostedAccount.create(e2e, MemoryValues(),
          origin: 'wss://relay.test', accountId: accountId, phoneKey: main.signing.publicKey, self: other, first: v1List, newest: version(Int64(2), [self, other, computer]));
      final t = HostedSessions(e2e: e2e, account: b, main: second, sendRelay: (_) => true, toClient: (_) {}, relayState: states.add, onRemoved: () => removed = true);
      addTearDown(t.dispose);
      t.onState(HostedReady(v2.Welcome(maxFrameBytes: 1 << 20, listCounter: Int64(2))));
      await Future<void>.delayed(Duration.zero);
      expect(removed, isFalse);
      t.onFrame(v2.Frame(list: v2.List_(list: version(Int64(3), [self, computer]))));
      await Future<void>.delayed(Duration.zero);
      expect(removed, isTrue);
      expect(states.last.state, 'refused');
      expect(t.fromClient(v1.Frame(subscribeSessions: v1.SubscribeSessions())), isFalse);
    });
  });
}
