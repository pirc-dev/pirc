// Notifications in Dart (lib/push): registering with the gateway, keeping
// the relay's registration in step with the phone's permission, and a wake
// reading the list with the read-only key, against the Go relay. The relay
// test is skipped, saying so, without go on PATH.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:fake_async/fake_async.dart';
import 'package:fixnum/fixnum.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/app/app.dart';
import 'package:pirc/app/store.dart';
import 'package:pirc/core/client.dart';
import 'package:pirc/core/protocol.dart';
import 'package:pirc/join.dart';
import 'package:pirc/keys/key_store.dart';
import 'package:pirc/push/push.dart';
import 'package:pirc/push/sync.dart';
import 'package:pirc/push/wake.dart';
import 'package:pirc/relay/connection.dart';
import 'package:pirc/relay/keys.dart';

import 'support/relay.dart';

// A platform that answers as told, over a mocked channel.
PushPlatform platform({required String permission, Object? token}) {
  const channel = MethodChannel('test/push');
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
    switch (call.method) {
      case 'permission':
        return permission;
      case 'token':
        return token;
    }
    return null;
  });
  return PushPlatform(channel);
}

const apns = {'platform': 'apns', 'token': 'abababababababababababababababababababababababababababababababab', 'environment': 'development'};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test("only the publisher's app has notifications: the gateway wakes no other", () {
    expect(pushes('dev.pirc.app'), isTrue);
    for (final id in ['org.example.pirc', 'dev.pirc.app.debug', 'dev.pirc', '', null]) {
      expect(pushes(id), isFalse, reason: '$id');
    }
  });

  group('keeping the registration in step', () {
    late List<Frame> asked;
    late List<PushToken> registered;
    late MemoryPrefs prefs;
    Future<void> ask(Frame Function(String) frame) async => asked.add(frame('r1'));

    setUp(() {
      asked = [];
      registered = [];
      prefs = MemoryPrefs();
    });

    PushSync sync(PushPlatform p, {Future<String> Function(PushToken)? register}) =>
        PushSync(platform: p, prefs: prefs, ask: ask, register: register ?? (t) async {
          registered.add(t);
          return 'handle-${registered.length}';
        });

    test('allowed: the token goes to the gateway, its handle to the relay', () async {
      await sync(platform(permission: 'granted', token: apns)).sync(registered: false);
      expect(registered.single.toJson(), apns);
      expect(asked.single.registerPush.handle, 'handle-1');
      expect((await prefs.pushed())?.toJson(), apns);
    });

    test('allowed and registered with the same token: nothing is sent', () async {
      await prefs.setPushed(const PushToken('apns', 'abababababababababababababababababababababababababababababababab', environment: 'development'));
      await sync(platform(permission: 'granted', token: apns)).sync(registered: true);
      expect(registered, isEmpty);
      expect(asked, isEmpty);
    });

    test('a new token is registered again', () async {
      await prefs.setPushed(const PushToken('apns', 'old', environment: 'development'));
      await sync(platform(permission: 'granted', token: apns)).sync(registered: true);
      expect(registered, hasLength(1));
      expect(asked.single.hasRegisterPush(), isTrue);
    });

    test('registered on the relay but not here (another install): registered again', () async {
      await sync(platform(permission: 'granted', token: apns)).sync(registered: true);
      expect(asked.single.hasRegisterPush(), isTrue);
    });

    test('refused, and the relay has a registration: it is undone', () async {
      await prefs.setPushed(const PushToken('apns', 'x'));
      await sync(platform(permission: 'denied', token: apns)).sync(registered: true);
      expect(registered, isEmpty);
      expect(asked.single.hasUnregisterPush(), isTrue);
      expect(await prefs.pushed(), isNull);
    });

    test('refused, or not yet asked, and nothing registered: nothing is sent', () async {
      for (final p in ['denied', 'undetermined']) {
        await sync(platform(permission: p, token: apns)).sync(registered: false);
      }
      expect(registered, isEmpty);
      expect(asked, isEmpty);
    });

    test("allowed but turned off in the app's Settings: the registration is undone", () async {
      await prefs.setPushed(const PushToken('apns', 'x'));
      await prefs.setNotifies(false);
      await sync(platform(permission: 'granted', token: apns)).sync(registered: true);
      expect(registered, isEmpty);
      expect(asked.single.hasUnregisterPush(), isTrue);
      expect(await prefs.pushed(), isNull);
    });

    test('a sync asked for while one is under way is made after it', () async {
      var missed = 0;
      final s = PushSync(platform: platform(permission: 'granted', token: apns), prefs: prefs, ask: ask, register: (t) async => 'h', missed: () => missed++);
      final first = s.sync(registered: false);
      await s.sync(registered: true);
      expect(missed, 0);
      await first;
      expect(missed, 1);
    });

    test('no token from the push service: nothing is sent', () async {
      await sync(platform(permission: 'granted')).sync(registered: false);
      expect(asked, isEmpty);
    });

    test("the gateway's Retry-After is kept, and it is tried again then", () {
      fakeAsync((time) {
        var tries = 0;
        final s = sync(platform(permission: 'granted', token: apns), register: (t) async {
          if (++tries == 1) throw const GatewayRefused(503, 'no credentials yet', retryAfter: Duration(seconds: 30));
          return 'later';
        });
        s.sync(registered: false);
        time.flushMicrotasks();
        expect(asked, isEmpty);
        time.elapse(const Duration(seconds: 31));
        expect(tries, 2);
        expect(asked.single.registerPush.handle, 'later');
      });
    });
  });

  group("the gateway's /v1/register", () {
    late HttpServer server;
    late List<Map<String, Object?>> bodies;
    var answer = (200, '{"handle":"h-1"}', <String, String>{});

    HttpOverrides? was;
    setUp(() async {
      // The test binding answers every request 400; this one is real, to
      // a stub on loopback.
      was = HttpOverrides.current;
      HttpOverrides.global = null;
      bodies = [];
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((req) async {
        bodies.add(jsonDecode(await utf8.decoder.bind(req).join()) as Map<String, Object?>);
        req.response.statusCode = answer.$1;
        answer.$3.forEach(req.response.headers.set);
        req.response.write(answer.$2);
        await req.response.close();
      });
    });

    tearDown(() async {
      HttpOverrides.global = was;
      await server.close(force: true);
    });

    String base() => 'http://127.0.0.1:${server.port}';

    test('sends the token, the app and its version, and gives back the handle', () async {
      answer = (200, '{"handle":"h-1"}', {});
      expect(await registerToken(PushToken.fromJson(apns), base: base()), 'h-1');
      expect(bodies.single, {...apns, 'app': 'dev.pirc.app', 'version': appVersion});
    });

    test('FCM sends no environment', () async {
      answer = (200, '{"handle":"h-2"}', {});
      await registerToken(const PushToken('fcm', 'f-token'), base: base());
      expect(bodies.single.containsKey('environment'), isFalse);
    });

    test('a refusal says its status, its reason and when to try again', () async {
      answer = (503, '{"error":"no credentials for apns development"}', {'retry-after': '60'});
      await expectLater(
        registerToken(PushToken.fromJson(apns), base: base()),
        throwsA(isA<GatewayRefused>()
            .having((e) => e.status, 'status', 503)
            .having((e) => e.message, 'message', 'no credentials for apns development')
            .having((e) => e.retryAfter, 'retryAfter', const Duration(seconds: 60))),
      );
    });
  });

  group('a wake and the subscription', () {
    // Not joined: a wake that goes on to the relay throws Unreachable.
    Object? woken(Store subscription, {DateTime? until, String? relay}) {
      Object? got;
      fakeAsync((async) {
        final prefs = MemoryPrefs(relay);
        prefs.setAllowedUntil(until);
        wake(prefs: prefs, store: MemoryKeyStore(), subscription: subscription, now: DateTime.utc(2026, 11, 9).millisecondsSinceEpoch).then<void>((v) => got = v, onError: (Object e) => got = e);
        async.elapse(const Duration(seconds: 4));
      });
      return got;
    }

    test('not allowed, nothing: not even the fixed text', () {
      for (final access in [Access.payment, Access.ended, Access.never]) {
        expect(woken(_Status(StoreStatus(access))), isEmpty, reason: access.name);
      }
    });

    test('allowed, the relay is read', () {
      expect(woken(_Status(const StoreStatus(Access.allowed, renews: true))), isA<Unreachable>());
    });

    test('joined to the review relay, the relay is read whatever the store says', () {
      // It has no key here: Unreachable, past the store.
      for (final access in [Access.ended, Access.never]) {
        expect(woken(_Status(StoreStatus(access)), relay: reviewRelay), isA<Unreachable>(), reason: access.name);
      }
      expect(woken(_Status(const StoreStatus(Access.ended)), relay: 'wss://relay.example'), isEmpty, reason: 'another relay');
    });

    test('the store not answering in 3 seconds: the time the app left', () {
      expect(woken(_Status(), until: DateTime.utc(2026, 11, 12)), isA<Unreachable>(), reason: 'still allowed');
      expect(woken(_Status(), until: DateTime.utc(2026, 11, 8)), isEmpty, reason: 'past it');
      expect(woken(_Status()), isEmpty, reason: 'never allowed');
    });
  });

  group('a wake, against the relay', () {
    late Directory dir;
    late Relay relay;
    const skip = 'skipped: needs go on PATH';

    setUpAll(() async {
      if (!hasGo) return;
      dir = await Directory.systemTemp.createTemp('pirc-app-wake-');
      relay = await Relay.start(dir);
    });

    tearDownAll(() async {
      if (!hasGo) return;
      relay.kill();
      await dir.delete(recursive: true);
    });

    test('a notice newer than what was shown is a note, once', () async {
      // A host with a session that finished.
      final hostKey = await DeviceKey.generate();
      final host = RelayConnection(url: relay.url, key: hostKey, role: Role.ROLE_HOST, token: relay.cmd('add-host', ['--label', 'laptop']), onFrame: (_) {});
      host.start();
      final ref = SessionRef(hostKey: hostKey.publicKey, sessionId: 's1', instanceId: 'i1');
      final announcement = SessionAnnouncement(
        name: 'release',
        cwd: '/src/app',
        hostname: 'laptop.local',
        notice: Notice(number: Int64(1793700000250), kind: NoticeKind.NOTICE_KIND_FINISHED, text: 'Tagged 0.2.'),
      );
      for (var i = 0; i < 50 && !host.send(Frame(sessionAnnounce: SessionAnnounce(session: ref, payload: announcement.writeToBuffer(), push: true))); i++) {
        await Future<void>.delayed(const Duration(milliseconds: 100));
      }

      // The phone, joined; it last looked before the notice.
      final store = MemoryKeyStore();
      await join(JoinLink(relay.url, relay.cmd('add-client', ['--label', 'phone'])), store, protect: false);
      final prefs = MemoryPrefs(relay.url);
      await prefs.setNotices(const Shown(since: 1793700000000));

      final notes = await wake(prefs: prefs, store: store, now: 1793700001000);
      expect([for (final n in notes) (n.session, n.title, n.body)], [(viewId(ref), 'release · laptop', 'Tagged 0.2.')]);
      expect((await prefs.notices()).toJson(), {'numbers': {viewId(ref): 1793700000250}, 'since': 1793700001000});
      expect(await wake(prefs: prefs, store: store, now: 1793700002000), isEmpty, reason: 'shown already');
      host.stop();
    }, skip: hasGo ? false : skip);

    test('no relay joined, or a relay that does not answer: unreachable', () async {
      await expectLater(wake(prefs: MemoryPrefs(), store: MemoryKeyStore(), now: 0), throwsA(isA<Unreachable>()));
      final store = MemoryKeyStore();
      await store.store('ws://127.0.0.1:9', KeyKind.read, (await DeviceKey.generate()).seed, protect: false);
      await expectLater(
        wake(prefs: MemoryPrefs('ws://127.0.0.1:9'), store: store, now: 0, deadline: const Duration(seconds: 2)),
        throwsA(isA<Unreachable>()),
      );
    });
  });
}

// A store whose status is the one given, or that never answers.
class _Status implements Store {
  _Status([this.answer]);
  final StoreStatus? answer;

  @override
  Future<StoreStatus> status() => answer == null ? Completer<StoreStatus>().future : Future.value(answer);
  @override
  Future<StoreProduct?> product() async => null;
  @override
  Future<Bought> buy() async => Bought.cancelled;
  @override
  Future<void> restore() async {}
  @override
  Future<void> manage() async {}
  @override
  Stream<void> get changed => const Stream.empty();
}
