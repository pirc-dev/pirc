// One connection to a hosted relay (relay.proto v1alpha2; docs/e2e.md,
// section 7), logged in: Hello with the key and the account (none to sign up
// or to wait for a join), the Challenge signed with the relay's origin, then
// Welcome. Frames in and out after that, and nothing else: no reconnection,
// since a join lost with its connection is started again.
import 'dart:async';
import 'dart:convert' show utf8;
import 'dart:io';
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';

import '../e2e/framed.dart';
import '../gen/pirc/v1alpha2/relay.pb.dart';

/// What the login signs (relay.proto, Auth).
const authContext = 'pirc-auth-v1alpha2';
const hostedPath = '/v1alpha2';

/// A login the relay refused, or a connection that ended before Welcome.
class LinkError implements Exception {
  const LinkError(this.message, {this.refused = false});
  final String message;

  /// The relay answered the login with an Error, rather than the
  /// connection failing.
  final bool refused;
  @override
  String toString() => message;
}

class HostedLink {
  HostedLink._(this._ws, this.welcome, this._frames, this.nonce);

  final WebSocket _ws;
  final Welcome welcome;

  /// The login's nonce, which an attestation for this login binds.
  final Uint8List nonce;
  final StreamController<Frame> _frames;

  /// Frames from the relay after Welcome, until the connection closes.
  Stream<Frame> get frames => _frames.stream;

  /// Logs in to [origin] with [publicKey], signing with [sign]; to
  /// [accountId], or without an account when it is empty.
  static Future<HostedLink> connect({
    required String origin,
    required Uint8List publicKey,
    required Future<Uint8List> Function(Uint8List message) sign,
    Uint8List? accountId,
    Int64? listCounter,
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final account = accountId ?? Uint8List(0);
    final ws = await WebSocket.connect('$origin$hostedPath').timeout(timeout);
    final frames = StreamController<Frame>();
    final login = Completer<Welcome>();
    var phase = 0;
    var nonce = Uint8List(0);
    ws.listen(
      (m) async {
        if (m is! List<int>) {
          ws.close(1003);
          return;
        }
        final Frame f;
        try {
          f = Frame.fromBuffer(m);
        } catch (_) {
          ws.close(1002);
          return;
        }
        if (phase == 2) return frames.add(f);
        if (f.hasError()) {
          if (!login.isCompleted) login.completeError(LinkError(f.error.message.isEmpty ? 'the relay refused the login' : f.error.message, refused: true));
          return;
        }
        if (phase == 0 && f.hasChallenge()) {
          phase = 1;
          nonce = Uint8List.fromList(f.challenge.nonce);
          final signed = framed(authContext, [account, utf8.encode(origin), f.challenge.nonce]);
          ws.add(Frame(auth: Auth(signature: await sign(signed))).writeToBuffer());
        } else if (phase == 1 && f.hasWelcome()) {
          phase = 2;
          login.complete(f.welcome);
        }
      },
      onDone: () {
        if (!login.isCompleted) login.completeError(LinkError('the relay closed the connection (${ws.closeCode ?? ''} ${ws.closeReason ?? ''})'.trim()));
        frames.close();
      },
      onError: (Object e) {
        if (!login.isCompleted) login.completeError(LinkError('the connection failed: $e'));
      },
      cancelOnError: false,
    );
    ws.add(Frame(
      hello: Hello(
        protocolVersion: ProtocolVersion.PROTOCOL_VERSION_V1ALPHA2,
        publicKey: publicKey,
        accountId: account.isEmpty ? null : account,
        listCounter: listCounter,
      ),
    ).writeToBuffer());
    try {
      final welcome = await login.future.timeout(timeout);
      return HostedLink._(ws, welcome, frames, nonce);
    } catch (_) {
      await ws.close();
      rethrow;
    }
  }

  void send(Frame f) => _ws.add(f.writeToBuffer());

  Future<void> close() => _ws.close();
}
