// A device's connection to a hosted relay (relay.proto v1alpha2;
// docs/e2e.md, section 7): login with the account and the relay's origin
// signed, keepalive and reconnection. A port of relay-client/hosted.ts
// over dart:io's WebSocket, which pings.
//
// A close never removes the device: 1008 means only that the relay refuses
// its key now. A refused login is tried again, slowly; a removal is learnt
// from a checked version of the list, never from the relay's word.
import 'dart:async';
import 'dart:convert' show utf8;
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';

import '../e2e/framed.dart';
import '../gen/pirc/v1alpha1/common.pbenum.dart';
import '../gen/pirc/v1alpha2/relay.pb.dart';
import 'link.dart' show authContext, hostedPath;

sealed class HostedState {
  const HostedState();
}

class HostedConnecting extends HostedState {
  const HostedConnecting();
}

class HostedReady extends HostedState {
  const HostedReady(this.welcome);
  final Welcome welcome;
}

/// Will retry; [reason] says why it is not connected.
class HostedOffline extends HostedState {
  const HostedOffline(this.reason);
  final String reason;
}

/// Will retry, slowly: the relay refuses this key now, or for this account.
class HostedRefused extends HostedState {
  const HostedRefused(this.code, this.reason);
  final ErrorCode code;
  final String reason;
}

/// Will not retry: the relay does not speak v1alpha2.
class HostedUnsupported extends HostedState {
  const HostedUnsupported(this.reason);
  final String reason;
}

class HostedStopped extends HostedState {
  const HostedStopped();
}

/// A hosted relay's origin as devices sign it: ws:// or wss:// and a host,
/// nothing after it; throws FormatException for anything else.
String hostedOrigin(String s) {
  final u = Uri.tryParse(s);
  if (u == null || (u.scheme != 'ws' && u.scheme != 'wss') || u.host.isEmpty || u.userInfo.isNotEmpty || u.hasQuery || u.hasFragment || (u.path != '' && u.path != '/')) {
    throw FormatException('a relay origin is ws:// or wss:// and a host, with nothing after it: $s');
  }
  return '${u.scheme}://${u.authority}';
}

class HostedConnection {
  HostedConnection({
    required String origin,
    required Uint8List accountId,
    required this.publicKey,
    required this.sign,
    required this.onFrame,
    this.onState,
    this.listCounter,
    this.pingInterval = const Duration(seconds: 25),
    this.loginTimeout = const Duration(seconds: 15),
    this.minBackoff = const Duration(seconds: 1),
    this.maxBackoff = const Duration(seconds: 30),
    this.refusedRetry = const Duration(minutes: 5),
  })  : origin = hostedOrigin(origin),
        // A named parameter cannot be private.
        // ignore: prefer_initializing_formals
        _accountId = accountId;

  final String origin;
  final Uint8List publicKey;
  final Future<Uint8List> Function(Uint8List message) sign;
  final void Function(Frame f) onFrame;
  final void Function(HostedState s)? onState;

  /// The highest version of the list the device holds, read at each login.
  final Int64 Function()? listCounter;
  final Duration pingInterval;
  final Duration loginTimeout;
  final Duration minBackoff;
  final Duration maxBackoff;
  final Duration refusedRetry;

  Uint8List _accountId;
  WebSocket? _ws;
  HostedState _state = const HostedStopped();
  var _stopped = true;
  var _attempt = 0;
  Timer? _retryTimer;
  Timer? _loginTimer;
  final _random = Random();

  HostedState get current => _state;
  Uint8List get accountId => _accountId;

  void start() {
    if (!_stopped) return;
    _stopped = false;
    _connect();
  }

  void stop() {
    _stopped = true;
    _retryTimer?.cancel();
    _teardown();
    _setState(const HostedStopped());
  }

  /// Logs in again, to another account: after signing up.
  void switchAccount(Uint8List accountId) {
    _accountId = accountId;
    _attempt = 0;
    _retryTimer?.cancel();
    _teardown();
    if (!_stopped) _connect();
  }

  /// Sends a frame if logged in; false when it could not be sent.
  bool send(Frame frame) {
    final s = _state;
    final ws = _ws;
    if (s is! HostedReady || ws == null || ws.readyState != WebSocket.open) return false;
    final bytes = frame.writeToBuffer();
    if (bytes.length > s.welcome.maxFrameBytes) return false;
    ws.add(bytes);
    return true;
  }

  void _setState(HostedState s) {
    _state = s;
    onState?.call(s);
  }

  void _teardown() {
    _loginTimer?.cancel();
    final ws = _ws;
    _ws = null;
    ws?.close();
  }

  void _retry(String reason, {ErrorCode? refused}) {
    _teardown();
    if (_stopped) return;
    _setState(refused != null ? HostedRefused(refused, reason) : HostedOffline(reason));
    if (_stopped) return;
    final backoff = min(maxBackoff.inMilliseconds, minBackoff.inMilliseconds * pow(2, min(_attempt++, 20)).toInt());
    final wait = refused != null ? refusedRetry : Duration(milliseconds: backoff ~/ 2 + _random.nextInt(backoff ~/ 2 + 1));
    _retryTimer = Timer(wait, _connect);
  }

  Future<void> _connect() async {
    if (_stopped) return;
    _setState(const HostedConnecting());
    var phase = 'hello';
    final account = _accountId;
    WebSocket? mine;
    _loginTimer = Timer(loginTimeout, () {
      if (_ws == mine && phase != 'ready') _retry('relay did not finish the login in time');
    });
    final timer = _loginTimer;
    final WebSocket ws;
    try {
      ws = await WebSocket.connect('$origin$hostedPath').timeout(loginTimeout);
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

    final counter = listCounter?.call() ?? Int64.ZERO;
    write(Frame(
      hello: Hello(
        protocolVersion: ProtocolVersion.PROTOCOL_VERSION_V1ALPHA2,
        publicKey: publicKey,
        accountId: account.isEmpty ? null : account,
        listCounter: counter == Int64.ZERO ? null : counter,
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
        if (phase == 'ready') return onFrame(frame);
        // A key the account's list removed is given the newest version
        // before its refusal, so that the device learns of its removal.
        if (phase == 'auth' && frame.hasList()) return onFrame(frame);
        switch (frame.whichBody()) {
          case Frame_Body.error:
            final code = frame.error.code;
            final message = frame.error.message;
            if (code == ErrorCode.ERROR_CODE_VERSION_UNSUPPORTED) {
              _teardown();
              _stopped = true;
              return _setState(HostedUnsupported(message));
            }
            if (code == ErrorCode.ERROR_CODE_UNAUTHENTICATED || code == ErrorCode.ERROR_CODE_PERMISSION_DENIED) return _retry(message, refused: code);
            return _retry(message.isNotEmpty ? message : 'login failed');
          case Frame_Body.challenge when phase == 'hello':
            phase = 'auth';
            final signed = framed(authContext, [account, utf8.encode(origin), frame.challenge.nonce]);
            final Uint8List signature;
            try {
              signature = await sign(signed);
            } catch (e) {
              if (_ws == ws) _retry('signing failed: $e');
              return;
            }
            if (_ws == ws) write(Frame(auth: Auth(signature: signature)));
          case Frame_Body.welcome when phase == 'auth':
            phase = 'ready';
            _loginTimer?.cancel();
            _attempt = 0;
            ws.pingInterval = pingInterval;
            _setState(HostedReady(frame.welcome));
          default:
            return _retry('unexpected ${frame.whichBody().name} during login');
        }
      },
      onDone: () {
        if (_ws != ws) return;
        final code = ws.closeCode;
        _retry(code == null ? 'relay stopped answering' : 'connection closed ($code${(ws.closeReason ?? '').isNotEmpty ? ' ${ws.closeReason}' : ''})');
      },
      onError: (Object e) {
        if (_ws != ws) return;
        _retry('$e');
      },
      cancelOnError: true,
    );
  }
}
