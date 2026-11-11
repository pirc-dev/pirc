// Notifications (docs/design.md, section 12, step 13): the phone's push
// token, given to the publisher's push gateway for a handle, which goes to
// the relay (RegisterPush), only while notifications are allowed; what was
// last shown, kept for the notification extension and Android's handler;
// and the notifications a person taps, which open their session.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';

// The publisher's gateway (docs/gateway.md); a test may point at a stub.
const gateway = String.fromEnvironment('PIRC_GATEWAY', defaultValue: 'https://push.pirc.dev');

// The app's ID, as the gateway serves it, and its version, only counted.
const appId = 'dev.pirc.app';
const appVersion = String.fromEnvironment('PIRC_VERSION', defaultValue: '0.1.0');

// Whether notifications may be shown.
enum Permission { granted, denied, undetermined }

// A push token: "apns" or "fcm", and for APNs whether it is for Apple's
// development servers or its real ones.
class PushToken {
  const PushToken(this.platform, this.token, {this.environment});
  final String platform;
  final String token;
  final String? environment;

  factory PushToken.fromJson(Map<String, Object?> j) => PushToken(j['platform'] as String, j['token'] as String, environment: j['environment'] as String?);

  Json toJson() => {'platform': platform, 'token': token, 'environment': ?environment};

  @override
  bool operator ==(Object other) => other is PushToken && other.platform == platform && other.token == token && other.environment == environment;
  @override
  int get hashCode => Object.hash(platform, token, environment);
}

typedef Json = Map<String, Object?>;

// What was last shown, as PircNotices' Shown: for each session the number
// of its latest notice, and when the list was last read, in milliseconds.
class Shown {
  const Shown({this.numbers = const {}, this.since});
  final Map<String, int> numbers;
  final int? since;

  factory Shown.fromJson(Json j) => Shown(
        numbers: {for (final MapEntry(:key, :value) in ((j['numbers'] as Map?) ?? const {}).entries) key as String: (value as num).toInt()},
        since: (j['since'] as num?)?.toInt(),
      );

  Json toJson() => {'numbers': numbers, 'since': ?since};

  static Shown parse(String? s) {
    if (s == null) return const Shown();
    try {
      return Shown.fromJson(jsonDecode(s) as Json);
    } on FormatException {
      return const Shown();
    }
  }
}

// The platform's side, over 'dev.pirc.app/push' (packages/pirc_platform).
class PushPlatform {
  PushPlatform([this.channel = const MethodChannel('dev.pirc.app/push')]) {
    channel.setMethodCallHandler((call) async {
      switch (call.method) {
        case 'opened':
          _opened.add((call.arguments as Map)['session'] as String);
        case 'token':
          final t = _token(call.arguments);
          if (t != null) _tokens.add(t);
      }
    });
  }

  final MethodChannel channel;
  final _opened = StreamController<String>.broadcast();
  final _tokens = StreamController<PushToken>.broadcast();

  // The sessions of the notifications the person taps.
  Stream<String> get opened => _opened.stream;
  // A token the push service replaced.
  Stream<PushToken> get tokens => _tokens.stream;

  Future<Permission> permission() async => Permission.values.byName(await channel.invokeMethod<String>('permission') ?? 'undetermined');

  // Asks the person, by the system's prompt; whether they allowed.
  Future<bool> ask() async => await channel.invokeMethod<bool>('ask') ?? false;

  // The phone's token; null when the push service gave none.
  Future<PushToken?> token() async => _token(await channel.invokeMethod<Object?>('token'));

  // Posts a notification for a session, or with none the fixed text
  // (Android; on iOS the notification extension writes them).
  Future<void> post(String? session, String title, String body) => channel.invokeMethod('post', {'session': session, 'title': title, 'body': body});

  // Opens the phone's Settings at the app's notifications.
  Future<void> openSettings() => channel.invokeMethod('settings');

  // The session of the notification the app was opened by, if any.
  Future<String?> launchedFor() => channel.invokeMethod<String>('launchedFor');

  PushToken? _token(Object? v) => v is Map ? PushToken.fromJson(v.cast<String, Object?>()) : null;
}

// Why a registration did not happen, to try again later or not.
class GatewayRefused implements Exception {
  const GatewayRefused(this.status, this.message, {this.retryAfter});
  final int status;
  final String message;
  final Duration? retryAfter;
  @override
  String toString() => 'GatewayRefused($status): $message';
}

// POST /v1/register: the handle for a token.
Future<String> registerToken(PushToken t, {String base = gateway, HttpClient? client}) async {
  final http = client ?? HttpClient();
  try {
    final req = await http.postUrl(Uri.parse('$base/v1/register')).timeout(const Duration(seconds: 15));
    req.headers.contentType = ContentType.json;
    req.write(jsonEncode({...t.toJson(), 'app': appId, 'version': appVersion}));
    final res = await req.close().timeout(const Duration(seconds: 15));
    final body = await res.transform(utf8.decoder).join();
    if (res.statusCode == 200) return (jsonDecode(body) as Json)['handle'] as String;
    final after = int.tryParse(res.headers.value('retry-after') ?? '');
    String message;
    try {
      message = ((jsonDecode(body) as Json)['error'] as String?) ?? body;
    } on FormatException {
      message = body;
    }
    throw GatewayRefused(res.statusCode, message, retryAfter: after == null ? null : Duration(seconds: after));
  } finally {
    if (client == null) http.close(force: true);
  }
}
