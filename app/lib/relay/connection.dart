// The app's connection to the relay: login (relay.proto: Hello, Challenge,
// Auth, Welcome), keepalive and reconnection. A port of
// relay-client/connection.ts over dart:io's WebSocket.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import '../core/protocol.dart';
import 'keys.dart';

// Prefixes the challenge nonce in the signed bytes (relay.proto, Auth).
final _authContext = utf8.encode('pirc-auth-v1alpha1\x00');

sealed class ConnectionState {
  const ConnectionState();
}

class Connecting extends ConnectionState {
  const Connecting();
}

class Ready extends ConnectionState {
  const Ready(this.maxFrameBytes, {this.readOnly = false});
  final int maxFrameBytes;
  // Logged in with a client's read-only key: only the session list.
  final bool readOnly;
}

// Will retry; reason says why it is not connected.
class Offline extends ConnectionState {
  const Offline(this.reason);
  final String reason;
}

// Will retry: the relay holds this key for its operator to approve.
class AwaitingApproval extends ConnectionState {
  const AwaitingApproval(this.reason);
  final String reason;
}

// Will not retry: the relay refused this key. removed when it was
// connected and its key was removed from the relay.
class Refused extends ConnectionState {
  const Refused(this.code, this.reason, {this.removed = false});
  final ErrorCode code;
  final String reason;
  final bool removed;
}

class Stopped extends ConnectionState {
  const Stopped();
}

// The path a bare relay URL gets.
const protocolPath = '/v1alpha1';

Uri relayUri(String url) {
  final u = Uri.tryParse(url);
  if (u == null || !u.hasScheme) throw FormatException('not a relay URL: $url');
  if (u.scheme == 'http' || u.scheme == 'https') {
    final ws = u.scheme == 'http' ? 'ws' : 'wss';
    throw FormatException('relay URL must start with ws:// or wss://: $url (did you mean $ws://${url.substring(u.scheme.length + 3)}?)');
  }
  if (u.scheme != 'ws' && u.scheme != 'wss') throw FormatException('relay URL must start with ws:// or wss://: $url');
  return u.path.isEmpty || u.path == '/' ? u.replace(path: protocolPath) : u;
}

// The relay's limit on labels and software strings (relay.proto, Hello).
const _maxStringBytes = 128;

// Cuts s to at most max bytes of UTF-8, on a character boundary.
String cutUtf8(String s, [int max = _maxStringBytes]) {
  final bytes = utf8.encode(s);
  if (bytes.length <= max) return s;
  var end = max;
  while (end > 0 && (bytes[end] & 0xc0) == 0x80) {
    end--;
  }
  return utf8.decode(bytes.sublist(0, end));
}

// Login failures that retrying will not fix.
const _refusals = {
  ErrorCode.ERROR_CODE_UNAUTHENTICATED,
  ErrorCode.ERROR_CODE_PERMISSION_DENIED,
  ErrorCode.ERROR_CODE_TOKEN_INVALID,
  ErrorCode.ERROR_CODE_VERSION_UNSUPPORTED,
  ErrorCode.ERROR_CODE_INVALID,
};

class RelayConnection {
  RelayConnection({
    required String url,
    required this.key,
    required this.onFrame,
    this.onState,
    this.onRegistered,
    this.token,
    this.label = '',
    this.software = 'pirc-app',
    this.role = Role.ROLE_CLIENT,
    this.retryUsedToken = true,
    this.pingInterval = const Duration(seconds: 25),
    this.approvalRetry = const Duration(seconds: 10),
    this.loginTimeout = const Duration(seconds: 15),
    this.minBackoff = const Duration(seconds: 1),
    this.maxBackoff = const Duration(seconds: 30),
  }) : uri = relayUri(url);

  final Uri uri;
  final DeviceKey key;
  final Role role;
  // A one-time registration token, for a key not yet registered.
  String? token;
  final String label;
  final String software;
  // A token refused as used earns one retry with the key alone, for a host
  // whose other process redeemed it at the same moment. Joining, which has
  // no such twin, turns it off and is told the token is no good.
  final bool retryUsedToken;
  final void Function(Frame) onFrame;
  final void Function(ConnectionState)? onState;
  // Called once logged in with the token, which the relay has then either
  // redeemed or found the key already registered.
  final void Function()? onRegistered;
  final Duration pingInterval;
  final Duration approvalRetry;
  final Duration loginTimeout;
  final Duration minBackoff;
  final Duration maxBackoff;

  WebSocket? _ws;
  ConnectionState _state = const Stopped();
  var _stopped = true;
  var _attempt = 0;
  var _tokenRetried = false;
  Timer? _retryTimer;
  Timer? _loginTimer;
  final _random = Random();

  ConnectionState get current => _state;

  void start() {
    if (!_stopped) return;
    _stopped = false;
    _connect();
  }

  void stop() {
    _stopped = true;
    _retryTimer?.cancel();
    _teardown();
    _setState(const Stopped());
  }

  // Sends a frame if logged in; false when it could not be sent.
  bool send(Frame frame) {
    final s = _state;
    final ws = _ws;
    if (s is! Ready || ws == null || ws.readyState != WebSocket.open) return false;
    final bytes = frame.writeToBuffer();
    if (bytes.length > s.maxFrameBytes) return false;
    ws.add(bytes);
    return true;
  }

  void _setState(ConnectionState s) {
    _state = s;
    onState?.call(s);
  }

  void _teardown() {
    _loginTimer?.cancel();
    final ws = _ws;
    _ws = null;
    ws?.close();
  }

  void _retry(String reason, [Duration? delay]) {
    _teardown();
    if (_stopped) return;
    _setState(Offline(reason));
    final backoff = min(maxBackoff.inMilliseconds, minBackoff.inMilliseconds * pow(2, _attempt++).toInt());
    // Jitter, so a relay restart does not bring every client back at once.
    final wait = delay ?? Duration(milliseconds: backoff ~/ 2 + _random.nextInt(backoff ~/ 2 + 1));
    _retryTimer = Timer(wait, _connect);
  }

  // Asks again in a while, without backing off: approval comes from a
  // person, who expects it to work soon after.
  void _await(String reason) {
    _teardown();
    if (_stopped) return;
    _attempt = 0;
    _setState(AwaitingApproval(reason));
    _retryTimer = Timer(approvalRetry, _connect);
  }

  void _refuse(ErrorCode code, String reason, {bool removed = false}) {
    _teardown();
    _stopped = true;
    _setState(Refused(code, reason, removed: removed));
  }

  Future<void> _connect() async {
    if (_stopped) return;
    if (_state is! AwaitingApproval) _setState(const Connecting());
    var phase = 'hello';
    // Covers the WebSocket handshake too.
    WebSocket? mine;
    _loginTimer = Timer(loginTimeout, () {
      if (_ws == mine && phase != 'ready') _retry('relay did not finish the login in time');
    });
    final timer = _loginTimer;
    final WebSocket ws;
    try {
      ws = await WebSocket.connect(uri.toString()).timeout(loginTimeout);
    } catch (e) {
      if (_loginTimer == timer && !_stopped) _retry(e is TimeoutException ? 'relay did not finish the login in time' : '$e');
      return;
    }
    if (_stopped || _loginTimer != timer) {
      ws.close();
      return;
    }
    mine = ws;
    _ws = ws;
    void write(Frame f) {
      if (ws.readyState == WebSocket.open) ws.add(f.writeToBuffer());
    }

    write(Frame(
      hello: Hello(
        protocolVersion: ProtocolVersion.PROTOCOL_VERSION_V1ALPHA1,
        role: role,
        publicKey: key.publicKey,
        registrationToken: token ?? '',
        label: cutUtf8(label),
        software: cutUtf8(software),
      ),
    ));
    ws.listen(
      (data) async {
        if (_ws != ws) return;
        if (data is! List<int>) return _retry('relay sent a text frame');
        final Frame frame;
        try {
          frame = Frame.fromBuffer(data);
        } catch (_) {
          return _retry('relay sent an undecodable frame');
        }
        if (phase == 'ready') {
          onFrame(frame);
          return;
        }
        switch (frame.whichBody()) {
          case Frame_Body.error:
            final code = frame.error.code;
            final message = frame.error.message;
            if (code == ErrorCode.ERROR_CODE_TOKEN_INVALID && token != null && retryUsedToken && !_tokenRetried) {
              _tokenRetried = true;
              token = null;
              return _retry('registration token already used; retrying with the key alone', const Duration(seconds: 1));
            }
            if (code == ErrorCode.ERROR_CODE_APPROVAL_PENDING) return _await(message);
            if (_refusals.contains(code)) return _refuse(code, message);
            return _retry(message.isNotEmpty ? message : 'login failed');
          case Frame_Body.challenge when phase == 'hello':
            phase = 'auth';
            final signature = await key.sign([..._authContext, ...frame.challenge.nonce]);
            write(Frame(auth: Auth(signature: signature)));
          case Frame_Body.welcome when phase == 'auth':
            phase = 'ready';
            _loginTimer?.cancel();
            _attempt = 0;
            if (token != null) {
              token = null;
              onRegistered?.call();
            }
            // dart:io pings the relay, and closes the socket when a pong
            // does not come back in time.
            ws.pingInterval = pingInterval;
            _setState(Ready(frame.welcome.maxFrameBytes, readOnly: frame.welcome.readOnly));
          default:
            return _retry('unexpected ${frame.whichBody().name} during login');
        }
      },
      onDone: () {
        if (_ws != ws) return;
        // Asking again would only ask to join.
        if (phase == 'ready' && ws.closeCode == 1008 && ws.closeReason == 'key revoked') {
          return _refuse(ErrorCode.ERROR_CODE_UNAUTHENTICATED, 'this key was removed from the relay', removed: true);
        }
        final code = ws.closeCode;
        _retry(code == null
            ? 'relay stopped answering'
            : 'connection closed ($code${(ws.closeReason ?? '').isNotEmpty ? ' ${ws.closeReason}' : ''})');
      },
      onError: (Object e) {
        if (_ws != ws) return;
        _retry('$e');
      },
      cancelOnError: true,
    );
  }
}

