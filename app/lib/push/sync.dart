// Keeping the relay's push registration in step with the phone: registered
// while notifications are allowed and on in the app's Settings, for the
// phone's current token, and not otherwise, since a wake the phone may not
// show is wasted (iOS runs no notification extension for an app whose
// alerts are off).
import 'dart:async';

import 'package:flutter/foundation.dart';

import '../app/app.dart';
import '../gen/pirc/v1alpha1/relay.pb.dart';
import 'push.dart';

// A request to the relay, answered by PushChanged or an Error with its ID.
typedef Ask = Future<void> Function(Frame Function(String requestId) frame);

// Sends what frame makes and waits for its answer.
class RelayAsks {
  RelayAsks(this.send);
  final bool Function(Frame) send;
  final _waiting = <String, Completer<void>>{};
  var _n = 0;

  Future<void> ask(Frame Function(String requestId) frame) {
    final id = 'push-${++_n}';
    final done = _waiting[id] = Completer<void>();
    if (!send(frame(id))) {
      _waiting.remove(id);
      return Future.error(StateError('not connected'));
    }
    return done.future.timeout(const Duration(seconds: 15), onTimeout: () {
      _waiting.remove(id);
      throw TimeoutException('no answer from the relay');
    });
  }

  // Each frame from the relay, before the client has it.
  void onFrame(Frame f) {
    switch (f.whichBody()) {
      case Frame_Body.pushChanged:
        _waiting.remove(f.pushChanged.requestId)?.complete();
      case Frame_Body.error:
        final e = f.error;
        _waiting.remove(e.requestId)?.completeError(StateError('${e.code.name}: ${e.message}'));
      default:
    }
  }

  // The connection went: nothing will be answered.
  void lost() {
    for (final c in _waiting.values) {
      c.completeError(StateError('lost the connection to the relay'));
    }
    _waiting.clear();
  }
}

class PushSync {
  PushSync({required this.platform, required this.prefs, required this.ask, this.register = _gateway, this.missed});

  final PushPlatform platform;
  final AppPrefs prefs;
  final Ask ask;
  // The gateway's /v1/register (push.dart); a test's stand-in.
  final Future<String> Function(PushToken) register;
  // Called when a sync asked for meanwhile was not made, as when Settings
  // turns notifications off while a registration is under way, to make it
  // with what the relay now says.
  final void Function()? missed;

  var _busy = false;
  var _missed = false;
  Timer? _again;

  // Brings the registration in step, given whether the relay has one for
  // this client (DeviceView.push). Quiet: a failure waits for the next
  // connection, or the gateway's Retry-After.
  Future<void> sync({required bool registered}) async {
    if (_busy) {
      _missed = true;
      return;
    }
    _busy = true;
    _again?.cancel();
    try {
      final permission = await platform.permission();
      final wanted = await prefs.notifies();
      if (permission != Permission.granted || !wanted) {
        debugPrint('push: notifications ${wanted ? permission.name : 'off in Settings'}; registered on the relay: $registered');
        if (registered) await ask((id) => Frame(unregisterPush: UnregisterPush(requestId: id)));
        await prefs.setPushed(null);
        return;
      }
      final token = await platform.token();
      if (token == null) return debugPrint('push: no token from the push service');
      if (registered && await prefs.pushed() == token) return;
      final handle = await register(token);
      await ask((id) => Frame(registerPush: RegisterPush(requestId: id, handle: handle)));
      await prefs.setPushed(token);
      debugPrint('push: registered (${token.platform}${token.environment == null ? '' : ' ${token.environment}'})');
    } on GatewayRefused catch (e) {
      debugPrint('push: the gateway refused: $e');
      // 429, 503: later, as the gateway says; anything else, at the next
      // connection.
      if (e.retryAfter != null) _again = Timer(e.retryAfter!, () => sync(registered: registered));
    } on Object catch (e) {
      // At the next connection.
      debugPrint('push: not registered: $e');
    } finally {
      _busy = false;
      if (_missed) {
        _missed = false;
        missed?.call();
      }
    }
  }

  void dispose() => _again?.cancel();
}

Future<String> _gateway(PushToken t) => registerToken(t);
