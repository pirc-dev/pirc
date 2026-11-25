// A hosted account's sessions for the app's Client (core/client.dart),
// which speaks v1alpha1: this turns the account's v1alpha2 frames and its
// channels (docs/e2e.md, sections 4 and 5) into the v1alpha1 frames the
// Client already reads, and the Client's frames into channel messages, so
// that the screens change little.
//
//   - The session list is the relay's sealed announcements, each opened
//     with this phone's box key and checked (the computer on the newest
//     list, the slot, the ordering value), and shown from what it holds:
//     name, folder, model and the computer's name.
//   - For every pi process with a session, a channel: its first frames are
//     the sessions' whole announcements, which replace the sealed ones, and
//     then each session's messages both ways, as Routed.
//   - The newest list from wherever it comes, checked by HostedAccount; a
//     newer one from a computer is given to the relay too, and channels to
//     computers no longer on it are closed.
//   - Devices and the names the account's phone sealed, as Keys.
//
// What the relay could do in v1alpha1 and cannot here (approve hosts,
// rename or remove a key, issue tokens, leave) is not sent: the Client
// then says it could not.
import 'dart:async';
import 'dart:convert' show utf8;
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:protobuf/well_known_types/google/protobuf/timestamp.pb.dart';

import '../core/view.dart' show RelayView;
import '../e2e/bytes.dart';
import '../e2e/list.dart';
import '../e2e/names.dart';
import '../e2e/sealed.dart';
import '../gen/pirc/v1alpha1/common.pb.dart' as common;
import '../gen/pirc/v1alpha1/common.pbenum.dart';
import '../gen/pirc/v1alpha1/relay.pb.dart' as v1;
import '../gen/pirc/v1alpha1/session.pb.dart' as sp;
import '../gen/pirc/v1alpha2/account.pb.dart';
import '../gen/pirc/v1alpha2/channel.pb.dart';
import '../gen/pirc/v1alpha2/relay.pb.dart' as v2;
import 'account.dart';
import 'channel.dart';
import 'connection.dart';
import 'keys.dart';

/// How long a process's channel stays open after its last session ends.
const idleClose = Duration(seconds: 10);

/// A process's channel is opened again after this, doubling to a minute.
const reopenMin = Duration(seconds: 1);
const reopenMax = Duration(minutes: 1);

/// Requests held for a channel not ready yet, per process.
const heldMax = 64;

String _processId(List<int> hostKey, String instanceId) => '${hexOf(hostKey)} $instanceId';

class _Session {
  _Session(this.ref);
  final common.SessionRef ref;

  /// What the sealed copy said, and whether the channel's whole
  /// announcement has replaced it.
  AnnouncementText? sealed;
  Timestamp? announcedAt;
  Uint8List? whole;
}

class _Process {
  _Process(this.hostKey, this.instanceId);
  final Uint8List hostKey;
  final String instanceId;
  final sessions = <String, _Session>{};
  HostedChannel? channel;
  final held = <(String, Uint8List)>[];
  Timer? reopen;
  Timer? idle;
  var backoff = reopenMin;
}

class HostedSessions implements ChannelEvents {
  HostedSessions({
    required this.e2e,
    required this.account,
    required this.main,
    required this.sendRelay,
    required this.toClient,
    required this.relayState,
    this.onRemoved,
    Int64 Function()? now,
  }) : _now = now ?? (() => Int64(DateTime.now().millisecondsSinceEpoch)) {
    _boxSecret = main.box.secretKey.extractBytes();
    _listSub = account.changes.listen(_newer);
  }

  final E2e e2e;
  final HostedAccount account;
  final MainKeys main;

  /// Sends a frame to the relay; false when it could not.
  final bool Function(v2.Frame f) sendRelay;

  /// Each frame for the Client, in order.
  final void Function(v1.Frame f) toClient;

  /// The connection's state, for the Client.
  final void Function(RelayView r) relayState;

  /// The newest list no longer has this phone.
  final void Function()? onRemoved;
  final Int64 Function() _now;

  late final Uint8List _boxSecret;
  late final StreamSubscription<HeldList> _listSub;
  final _processes = <String, _Process>{};
  // The highest ordering value seen per computer, session and kind.
  final _highest = <String, Int64>{};
  Int64? _namesHighest;
  Map<String, String> _names = {};
  v2.Devices? _devices;
  // v1alpha1 push requests, answered by Done in v1alpha2.
  final _pushIds = <String>{};
  var _ready = false;
  var _removed = false;
  var _publishes = 0;

  bool get _connected => _ready && !_removed;

  void dispose() {
    _listSub.cancel();
    _closeAll('stopped', tell: true);
    _boxSecret.fillRange(0, _boxSecret.length, 0);
  }

  // --- From the connection -------------------------------------------------

  void onState(HostedState s) {
    if (_removed) return;
    if (s is! HostedReady) {
      _ready = false;
      _closeAll('the connection went', tell: false);
      relayState(switch (s) {
        HostedConnecting() => const RelayView(state: 'connecting'),
        HostedOffline(:final reason) => RelayView(state: 'offline', reason: reason),
        HostedRefused(:final reason) => RelayView(state: 'offline', reason: reason),
        HostedUnsupported(:final reason) => RelayView(state: 'refused', reason: reason),
        HostedStopped() => const RelayView(state: 'stopped'),
        HostedReady() => const RelayView(state: 'ready'),
      });
      return;
    }
    _ready = true;
    final w = s.welcome;
    unawaited(_welcomed(w));
  }

  Future<void> _welcomed(v2.Welcome w) async {
    if (w.list.isNotEmpty) await _take(w.list, fromRelay: true);
    if (!_connected) return;
    // The relay is behind this phone: it is given the newer version.
    if (w.listCounter < account.newest.counter) _publish(account.newest.bytes);
    relayState(const RelayView(state: 'ready'));
  }

  void onFrame(v2.Frame f) {
    if (_removed) return;
    switch (f.whichBody()) {
      case v2.Frame_Body.list:
        unawaited(_take(f.list.list, fromRelay: true));
      case v2.Frame_Body.sessionList:
        final entries = <v1.SessionEntry>[];
        for (final e in f.sessionList.sessions) {
          final entry = _sealedEntry(e);
          if (entry != null) entries.add(entry);
        }
        toClient(v1.Frame(sessionList: v1.SessionList(sessions: entries, more: f.sessionList.more)));
      case v2.Frame_Body.sessionUpdated:
        if (!f.sessionUpdated.hasEntry()) return;
        final entry = _sealedEntry(f.sessionUpdated.entry);
        if (entry != null) toClient(v1.Frame(sessionUpdated: v1.SessionUpdated(entry: entry)));
      case v2.Frame_Body.sessionEnded:
        if (!f.sessionEnded.hasSession()) return;
        _ended(f.sessionEnded.session);
      case v2.Frame_Body.devices:
        _devices = f.devices;
        if (f.devices.names.isNotEmpty) _openNames(f.devices.names);
        _sendKeys();
      case v2.Frame_Body.channelOpened:
        for (final p in _processes.values) {
          final ch = p.channel;
          if (ch != null && ch.requestId == f.channelOpened.requestId) ch.opened(f.channelOpened.channelId);
        }
      case v2.Frame_Body.channelMessage:
        _byId(f.channelMessage.channelId)?.message(Uint8List.fromList(f.channelMessage.message));
      case v2.Frame_Body.closeChannel:
        _byId(f.closeChannel.channelId)?.close(f.closeChannel.code, 'the relay closed it (${f.closeChannel.code.name})', tell: false);
      case v2.Frame_Body.done:
        if (_pushIds.remove(f.done.requestId)) toClient(v1.Frame(pushChanged: v1.PushChanged(requestId: f.done.requestId)));
      case v2.Frame_Body.error:
        final e = f.error;
        if (e.requestId.isEmpty) return debugPrint('hosted: relay: ${e.message}');
        _pushIds.remove(e.requestId);
        for (final p in _processes.values) {
          final ch = p.channel;
          if (ch != null && ch.requestId == e.requestId && ch.id == null) ch.refused('the relay: ${e.message}');
        }
        toClient(v1.Frame(error: e));
      default:
        return;
    }
  }

  HostedChannel? _byId(Int64 id) {
    for (final p in _processes.values) {
      final ch = p.channel;
      if (ch != null && ch.id == id) return ch;
    }
    return null;
  }

  // --- The list ------------------------------------------------------------

  Future<void> _take(List<int> bytes, {required bool fromRelay}) async {
    final t = await account.take(bytes);
    if (t is TakenRefused) debugPrint('hosted: a list was refused: ${t.reason}');
    // A version a computer had and the relay did not is given to the relay.
    if (t is TakenNewer && !fromRelay) _publish(t.list.bytes);
  }

  void _publish(Uint8List list) {
    sendRelay(v2.Frame(publishList: v2.PublishList(requestId: 'l${++_publishes}', list: list)));
  }

  // A newer version taken, from anywhere.
  void _newer(HeldList list) {
    if (!account.listed) {
      _removed = true;
      _closeAll('this phone was removed from the account', tell: true);
      relayState(const RelayView(state: 'refused', reason: 'this phone was removed from the account'));
      onRemoved?.call();
      return;
    }
    // Channels to computers no longer on it, and their sessions, go.
    for (final p in [..._processes.values]) {
      if (_computer(p.hostKey) == null) _dropProcess(p, 'its computer is no longer on the list');
    }
    _sendKeys();
  }

  Device? _computer(List<int> hostKey) {
    for (final d in account.newest.body.devices) {
      if (d.role == roleComputer && bytesEqual(d.signingKey, hostKey)) return d;
    }
    return null;
  }

  // --- Sessions ------------------------------------------------------------

  // A sealed entry opened and checked, as the Client's entry; null when it
  // does not check out, which leaves the session out.
  v1.SessionEntry? _sealedEntry(v2.SessionEntry e) {
    if (!e.hasSession() || e.sealed.isEmpty) return null;
    final ref = e.session;
    if (_computer(ref.hostKey) == null) return null;
    final sessionId = utf8.encode(ref.sessionId);
    if (!goodSessionId(sessionId)) return null;
    final key = '${hexOf(ref.hostKey)}/${ref.sessionId}/a';
    final r = e2e.openAnnouncement(
      sealed: e.sealed,
      slot: Slot(accountId: account.accountId, computerKey: ref.hostKey, sessionId: sessionId),
      recipientSecretKey: _boxSecret,
      list: account.newest.body,
      highest: _highest[key],
      now: _now(),
    );
    final p = _process(ref.hostKey, ref.instanceId);
    final s = p.sessions.putIfAbsent(ref.sessionId, () => _Session(common.SessionRef(hostKey: ref.hostKey, sessionId: ref.sessionId, instanceId: ref.instanceId)));
    if (r.result == 'accepted') {
      _highest[key] = r.ordering!;
      s.sealed = r.body;
      s.announcedAt = e.hasAnnouncedAt() ? e.announcedAt : null;
    } else if (r.reason != 'ordering' || s.sealed == null) {
      // An older copy than one seen keeps the one seen; anything else is
      // left out.
      debugPrint('hosted: an announcement was refused: ${r.reason}');
      if (s.sealed == null && s.whole == null) {
        p.sessions.remove(ref.sessionId);
        _idleSoon(p);
      }
      return null;
    }
    return _entry(s);
  }

  v1.SessionEntry _entry(_Session s) {
    final sealed = s.sealed;
    final payload = s.whole ??
        sp.SessionAnnouncement(
          name: sealed?.sessionName,
          cwd: sealed?.folder,
          hostname: sealed?.computerName,
          model: sealed == null || sealed.model.isEmpty ? null : sp.Model(name: sealed.model),
        ).writeToBuffer();
    return v1.SessionEntry(session: s.ref, hostLabel: _hostLabel(s.ref.hostKey, sealed?.computerName), payload: payload, announcedAt: s.announcedAt);
  }

  // The name the account's phone gave the computer, or the computer's own.
  String _hostLabel(List<int> hostKey, String? own) => _names[hexOf(hostKey)] ?? own ?? '';

  void _ended(common.SessionRef ref) {
    final p = _processes[_processId(ref.hostKey, ref.instanceId)];
    p?.sessions.remove(ref.sessionId);
    toClient(v1.Frame(sessionEnded: v1.SessionEnded(session: ref)));
    if (p != null) _idleSoon(p);
  }

  // A process with no session left closes its channel after a while.
  void _idleSoon(_Process p) {
    if (p.sessions.isNotEmpty) return;
    p.idle?.cancel();
    p.idle = Timer(idleClose, () => _dropProcess(p, 'no sessions left'));
  }

  // --- Processes and their channels -------------------------------------

  _Process _process(List<int> hostKey, String instanceId) {
    final id = _processId(hostKey, instanceId);
    final p = _processes.putIfAbsent(id, () => _Process(Uint8List.fromList(hostKey), instanceId));
    p.idle?.cancel();
    p.idle = null;
    if (p.channel == null && p.reopen == null) _open(p);
    return p;
  }

  void _open(_Process p) {
    p.reopen = null;
    if (!_connected) return;
    final computer = _computer(p.hostKey);
    if (computer == null) return;
    if (_processes.values.where((q) => q.channel != null).length >= maxChannels) {
      debugPrint('hosted: $maxChannels channels open; ${p.instanceId} waits');
      return _later(p);
    }
    final ch = p.channel = HostedChannel(
      e2e: e2e,
      channelKey: main.channel.secretKey,
      hostKey: p.hostKey,
      hostChannelKey: Uint8List.fromList(computer.channelKey),
      instanceId: p.instanceId,
      accountId: account.accountId,
      list: account.newest.bytes,
      send: sendRelay,
      events: this,
    );
    ch.open();
  }

  void _later(_Process p) {
    p.reopen?.cancel();
    p.reopen = Timer(p.backoff, () => _open(p));
    final next = p.backoff * 2;
    p.backoff = next > reopenMax ? reopenMax : next;
  }

  _Process? _of(HostedChannel ch) {
    for (final p in _processes.values) {
      if (identical(p.channel, ch)) return p;
    }
    return null;
  }

  @override
  void listState(HostedChannel ch, Int64 counter, Uint8List? newer) {
    final p = _of(ch);
    if (p == null) return;
    p.backoff = reopenMin;
    if (newer != null) unawaited(_take(newer, fromRelay: false));
    for (final (sessionId, m) in p.held) {
      ch.sendSession(sessionId, m);
    }
    p.held.clear();
    _idleSoon(p);
    _sendKeys();
  }

  @override
  void session(HostedChannel ch, SessionFrame f) {
    final p = _of(ch);
    if (p == null) return;
    final ref = common.SessionRef(hostKey: p.hostKey, sessionId: f.sessionId, instanceId: p.instanceId);
    switch (f.whichBody()) {
      case SessionFrame_Body.announcement:
        try {
          sp.SessionAnnouncement.fromBuffer(f.announcement);
        } catch (_) {
          return ch.close(ErrorCode.ERROR_CODE_INVALID, 'an announcement did not parse');
        }
        final s = p.sessions.putIfAbsent(f.sessionId, () => _Session(ref));
        s.whole = Uint8List.fromList(f.announcement);
        p.idle?.cancel();
        p.idle = null;
        toClient(v1.Frame(sessionUpdated: v1.SessionUpdated(entry: _entry(s))));
      case SessionFrame_Body.message:
        toClient(v1.Frame(routed: v1.Routed(session: ref, payload: f.message)));
      default:
        ch.close(ErrorCode.ERROR_CODE_INVALID, 'an empty session frame');
    }
  }

  @override
  void closed(HostedChannel ch, String why) {
    final p = _of(ch);
    if (p == null) return;
    debugPrint('hosted: channel to ${p.instanceId} closed: $why');
    p.channel = null;
    if (!_connected || !identical(_processes[_processId(p.hostKey, p.instanceId)], p)) return;
    if (p.sessions.isNotEmpty || p.held.isNotEmpty) _later(p);
  }

  // Ends a process's channel and its sessions.
  void _dropProcess(_Process p, String why) {
    p.idle?.cancel();
    p.reopen?.cancel();
    _processes.remove(_processId(p.hostKey, p.instanceId));
    final ch = p.channel;
    p.channel = null;
    ch?.close(ErrorCode.ERROR_CODE_PERMISSION_DENIED, why);
    for (final s in p.sessions.values) {
      toClient(v1.Frame(sessionEnded: v1.SessionEnded(session: s.ref)));
    }
    p.sessions.clear();
  }

  // Every channel ends, and every process is forgotten: after a new login
  // the session list brings them back.
  void _closeAll(String why, {required bool tell}) {
    for (final p in _processes.values) {
      p.idle?.cancel();
      p.reopen?.cancel();
      final ch = p.channel;
      p.channel = null;
      ch?.close(ErrorCode.ERROR_CODE_SESSION_GONE, why, tell: tell);
    }
    _processes.clear();
  }

  // --- Devices and names -------------------------------------------------

  void _openNames(List<int> sealed) {
    final r = e2e.openNames(
      sealed: sealed,
      accountId: account.accountId,
      list: account.newest.body,
      phoneKey: account.phoneKey,
      recipientSecretKey: _boxSecret,
      highest: _namesHighest,
      now: _now(),
    );
    if (r.result != 'accepted') {
      if (r.reason != 'ordering') debugPrint('hosted: names ${r.result} ${r.reason ?? ''}');
      return;
    }
    _namesHighest = r.ordering;
    _names = {for (final n in r.names) hexOf(n.signingKey): n.name};
  }

  void _sendKeys() {
    final status = <String, v2.DeviceStatus>{for (final d in _devices?.devices ?? <v2.DeviceStatus>[]) hexOf(d.publicKey): d};
    toClient(v1.Frame(
      keys: v1.Keys(keys: [
        for (final d in account.newest.body.devices)
          v1.RegisteredKey(
            publicKey: d.signingKey,
            role: d.role == roleComputer ? v1.Role.ROLE_HOST : v1.Role.ROLE_CLIENT,
            label: _names[hexOf(d.signingKey)] ?? '',
            online: status[hexOf(d.signingKey)]?.online ?? false,
            push: status[hexOf(d.signingKey)]?.push ?? false,
            readKey: d.readOnlyKey.isNotEmpty,
          ),
      ]),
    ));
  }

  /// The computers' list counters, as their channels said, by signing key:
  /// a computer behind the newest has not yet confirmed its changes.
  Map<String, Int64> get hostCounters => {
        for (final p in _processes.values)
          if (p.channel?.hostCounter != null) hexOf(p.hostKey): p.channel!.hostCounter!,
      };

  // --- From the Client -----------------------------------------------------

  /// A frame the Client sends; false when it could not be sent.
  bool fromClient(v1.Frame f) {
    if (!_connected) return false;
    switch (f.whichBody()) {
      case v1.Frame_Body.subscribeSessions:
        return sendRelay(v2.Frame(subscribeSessions: v2.SubscribeSessions()));
      case v1.Frame_Body.watchKeys:
        _sendKeys();
        return sendRelay(v2.Frame(watchDevices: v2.WatchDevices()));
      case v1.Frame_Body.watchPendingHosts:
        // No host waits for approval: the list is the account.
        return true;
      case v1.Frame_Body.attach:
        // The computer sends every channel each session's events.
        final ref = f.attach.session;
        if (_computer(ref.hostKey) != null) _process(ref.hostKey, ref.instanceId);
        return true;
      case v1.Frame_Body.detach:
        return true;
      case v1.Frame_Body.routed:
        final ref = f.routed.session;
        if (_computer(ref.hostKey) == null) return false;
        final p = _process(ref.hostKey, ref.instanceId);
        final ch = p.channel;
        final m = Uint8List.fromList(f.routed.payload);
        if (ch != null && ch.ready) return ch.sendSession(ref.sessionId, m);
        if (p.held.length >= heldMax) return false;
        p.held.add((ref.sessionId, m));
        return true;
      case v1.Frame_Body.registerPush:
        _pushIds.add(f.registerPush.requestId);
        return sendRelay(v2.Frame(registerPush: v2.RegisterPush(requestId: f.registerPush.requestId, handle: f.registerPush.handle)));
      case v1.Frame_Body.unregisterPush:
        _pushIds.add(f.unregisterPush.requestId);
        return sendRelay(v2.Frame(unregisterPush: v2.UnregisterPush(requestId: f.unregisterPush.requestId)));
      default:
        return false;
    }
  }
}
