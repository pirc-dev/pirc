// Notifications while the app runs: the relay's registration kept in step
// with the phone's permission and token, once the relay has listed this
// client (sync.dart); what is on screen kept as shown, so that a later push
// does not announce it (news, core/notices.dart); and a tapped notification
// opening its session.
import 'dart:async';

import '../app/app.dart';
import '../app/model.dart';
import '../core/notices.dart';
import '../gen/pirc/v1alpha1/relay.pb.dart';
import 'push.dart';
import 'sync.dart';

class Notifications {
  Notifications({required this.platform, required this.prefs, required this.open}) {
    _opened = platform.opened.listen(_open);
  }

  final PushPlatform platform;
  final AppPrefs prefs;
  // Opens a session's chat.
  final void Function(String id) open;

  late final StreamSubscription<String> _opened;
  PircModel? _model;
  RelayAsks? _asks;
  PushSync? _sync;
  // Synced on this connection.
  var _synced = false;
  Map<String, int>? _shownNumbers;
  String? _waitingFor;
  Timer? _giveUp;

  // A connection, with its model: from now on its frames come here first.
  void attach(PircModel model, bool Function(Frame) send) {
    detach();
    _model = model;
    final asks = _asks = RelayAsks(send);
    _sync = PushSync(platform: platform, prefs: prefs, ask: asks.ask, missed: answered);
    model.addListener(_changed);
    platform.launchedFor().then((s) {
      if (s != null) _open(s);
    }, onError: (_) {});
  }

  void detach() {
    _model?.removeListener(_changed);
    _asks?.lost();
    _sync?.dispose();
    _model = null;
    _asks = null;
    _sync = null;
    _synced = false;
  }

  void onFrame(Frame f) => _asks?.onFrame(f);

  // The connection went or came back: sync again once it is listed.
  void onState(bool ready) {
    if (!ready) {
      _asks?.lost();
      _synced = false;
    }
  }

  // Back from the background, where the person may have changed the
  // permission in Settings.
  void resumed() => _synced = false;

  // The person was asked, and answered, or changed the switch in Settings:
  // in step at once.
  Future<void> answered() async {
    _synced = false;
    _changed();
  }

  void _changed() {
    final model = _model;
    if (model == null || model.relay.state != 'ready') return;
    final self = model.client.snapshot().devices.where((d) => d.self).firstOrNull;
    if (self != null && !_synced) {
      _synced = true;
      _sync?.sync(registered: self.push);
    }
    _keepShown(model);
    final waiting = _waitingFor;
    if (waiting != null && model.session(waiting) != null) {
      _waitingFor = null;
      _giveUp?.cancel();
      open(waiting);
    }
  }

  // What is listed is seen: its notices are shown.
  Future<void> _keepShown(PircModel model) async {
    final sessions = model.sessions;
    final numbers = {for (final s in sessions) s.id: s.notice?.number ?? 0};
    if (_mapEquals(numbers, _shownNumbers)) return;
    _shownNumbers = numbers;
    final shown = await prefs.notices();
    final next = news(shown.numbers, sessions, shown.since).shown;
    await prefs.setNotices(Shown(numbers: next, since: model.now()));
  }

  // A notification tapped: its session, once it is listed.
  void _open(String id) {
    if (_model?.session(id) != null) return open(id);
    _waitingFor = id;
    _giveUp?.cancel();
    _giveUp = Timer(const Duration(seconds: 15), () => _waitingFor = null);
  }

  void dispose() {
    detach();
    _opened.cancel();
    _giveUp?.cancel();
  }
}

bool _mapEquals(Map<String, int> a, Map<String, int>? b) => b != null && a.length == b.length && a.entries.every((e) => b[e.key] == e.value);
