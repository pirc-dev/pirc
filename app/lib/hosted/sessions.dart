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

/// The relay's Error for a request.
class HostedRefusal implements Exception {
  const HostedRefusal(this.code, this.message);
  final ErrorCode code;
  final String message;
  @override
  String toString() => message.isEmpty ? 'the relay refused (${code.name})' : 'the relay refused: $message';
}

/// Where every client keeps the highest names ordering it has seen.
const namesSeenKey = 'hosted.names.seen';

class HostedSessions implements ChannelEvents {
  HostedSessions({
    required this.e2e,
    required this.account,
    required this.main,
    required this.sendRelay,
    required this.toClient,
    required this.relayState,
    this.onRemoved,
    this.values,
    this.onWelcome,
    this.onRefused,
    Int64 Function()? now,
  }) : _now = now ?? (() => Int64(DateTime.now().millisecondsSinceEpoch)) {
    _boxSecret = main.box.secretKey.extractBytes();
    _listSub = account.changes.listen(_newer);
    _names0 = _loadSeen();
  }

  /// Where the highest names ordering seen is kept, so that the relay
  /// cannot bring back older names after a restart either.
  final KeyValues? values;

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

  /// Each login's Welcome, for the account's state: locked, and its
  /// subscriptions.
  final void Function(v2.Welcome w)? onWelcome;

  /// A login the relay refused, by its code: once deleting the account was
  /// asked for, that is how the phone learns it is done.
  final void Function(ErrorCode code)? onRefused;
  final Int64 Function() _now;

  late final Uint8List _boxSecret;
  late final StreamSubscription<HeldList> _listSub;
  final _processes = <String, _Process>{};
  // The highest ordering value seen per computer, session and kind.
  final _highest = <String, Int64>{};
  Int64? _namesHighest;
  // The kept highest read, before any names are opened; then each Devices
  // in turn.
  late Future<void> _names0;
  // Each computer's list counter, as its channels last said, by signing key
  // in hex: the highest it has confirmed.
  final _confirmed = <String, Int64>{};
  // Channels opened only to give computers a newer list, and to hear their
  // counter back (the account's phone, after a change).
  final _probes = <HostedChannel>[];
  Map<String, String> _names = {};
  // Each computer's own name, from what it sealed, by signing key in hex.
  final _computerNames = <String, String>{};
  // Frames for whoever else reads them (a join), and requests waiting for
  // their Done or Error.
  final _frames = StreamController<v2.Frame>.broadcast(sync: true);
  final _waiting = <String, Completer<void>>{};
  var _requests = 0;
  v2.Devices? _devices;
  // v1alpha1 push requests, answered by Done in v1alpha2.
  final _pushIds = <String>{};
  var _ready = false;
  var _removed = false;
  var _disposed = false;
  // Opens given up before the relay answered them: closed when it does.
  final _abandoned = <String>{};
  var _publishes = 0;
  final _welcomes = StreamController<void>.broadcast();

  /// Each login that reached Welcome, after this phone's newest was given
  /// to a relay behind it.
  Stream<void> get welcomes => _welcomes.stream;

  bool get _connected => _ready && !_removed && !_disposed;

  /// Stopped for good: nothing more is sent.
  bool get disposed => _disposed;

  /// Ends every channel and stops taking frames; the keys may be disposed
  /// after it.
  void dispose() {
    if (_disposed) return;
    _listSub.cancel();
    _closeAll('stopped', tell: true);
    _disposed = true;
    _ready = false;
    _abandoned.clear();
    _failWaiting('stopped');
    _frames.close();
    _welcomes.close();
    _boxSecret.fillRange(0, _boxSecret.length, 0);
  }

  // --- From the connection -------------------------------------------------

  void onState(HostedState s) {
    if (_removed || _disposed) return;
    if (s is! HostedReady) {
      _ready = false;
      _abandoned.clear();
      _failWaiting('the connection to the relay was lost');
      // A removed key is given the newest list, then refused: this phone
      // learns of its removal from that list, which it may hold already.
      if (s is HostedRefused && !account.listed) return _removedNow();
      if (s is HostedRefused) onRefused?.call(s.code);
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
    if (_disposed || _removed) return;
    // Removed by a version taken before this login, by this app before it
    // stopped or by the notification extension.
    if (!account.listed) return _removedNow();
    if (!_connected) return;
    // The relay is behind this phone: it is given the newer version.
    if (w.listCounter < account.newest.counter) _publish(account.newest.bytes);
    onWelcome?.call(w);
    _welcomes.add(null);
    // Locked, the relay takes only a renewal or a deletion: the sessions
    // are not asked for.
    if (w.locked) return relayState(const RelayView(state: 'offline', reason: 'the account is locked'));
    relayState(const RelayView(state: 'ready'));
  }

  void onFrame(v2.Frame f) {
    if (_removed || _disposed) return;
    _frames.add(f);
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
        final d = f.devices;
        _names0 = _names0.then((_) async {
          if (_disposed) return;
          _devices = d;
          try {
            if (d.names.isNotEmpty) await _openNames(d.names);
          } on Object catch (e) {
            // A failed write of the ordering: these names wait for the next.
            debugPrint('hosted: names not taken: $e');
          }
          if (!_disposed) _sendKeys();
        });
      case v2.Frame_Body.channelOpened:
        if (_abandoned.remove(f.channelOpened.requestId)) {
          sendRelay(v2.Frame(closeChannel: v2.CloseChannel(channelId: f.channelOpened.channelId, code: ErrorCode.ERROR_CODE_SESSION_GONE)));
          return;
        }
        for (final ch in _channels) {
          if (ch.requestId == f.channelOpened.requestId) ch.opened(f.channelOpened.channelId);
        }
      case v2.Frame_Body.channelMessage:
        _byId(f.channelMessage.channelId)?.message(Uint8List.fromList(f.channelMessage.message));
      case v2.Frame_Body.closeChannel:
        _byId(f.closeChannel.channelId)?.close(f.closeChannel.code, 'the relay closed it (${f.closeChannel.code.name})', tell: false);
      case v2.Frame_Body.done:
        _waiting.remove(f.done.requestId)?.complete();
        if (_pushIds.remove(f.done.requestId)) toClient(v1.Frame(pushChanged: v1.PushChanged(requestId: f.done.requestId)));
      case v2.Frame_Body.error:
        final e = f.error;
        if (e.requestId.isEmpty) return debugPrint('hosted: relay: ${e.message}');
        _pushIds.remove(e.requestId);
        _abandoned.remove(e.requestId);
        _waiting.remove(e.requestId)?.completeError(HostedRefusal(e.code, e.message));
        for (final ch in _channels) {
          if (ch.requestId == e.requestId && ch.id == null) ch.refused('the relay: ${e.message}');
        }
        toClient(v1.Frame(error: e));
      default:
        return;
    }
  }

  // Every channel: the processes' and the probes.
  List<HostedChannel> get _channels => [
        for (final p in _processes.values) ?p.channel,
        ..._probes,
      ];

  HostedChannel? _byId(Int64 id) {
    for (final ch in _channels) {
      if (ch.id == id) return ch;
    }
    return null;
  }

  // --- The list ------------------------------------------------------------

  Future<void> _take(List<int> bytes, {required bool fromRelay}) async {
    final t = await account.take(bytes);
    if (t is TakenRefused) debugPrint('hosted: a list was refused: ${t.reason}');
    if (_disposed || _removed) return;
    // A version held already that does not have this phone: a removal
    // taken before, by this app or the notification extension.
    if (t is TakenOld && !account.listed) return _removedNow();
    // A version a computer had and the relay did not is given to the relay.
    if (t is TakenNewer && !fromRelay) _publish(t.list.bytes);
  }

  void _publish(Uint8List list) {
    sendRelay(v2.Frame(publishList: v2.PublishList(requestId: 'list${++_publishes}', list: list)));
  }

  // A newer version taken, from anywhere.
  void _removedNow() {
    _removed = true;
    _closeAll('this phone was removed from the account', tell: true);
    relayState(const RelayView(state: 'refused', reason: 'this phone was removed from the account'));
    onRemoved?.call();
  }

  void _newer(HeldList list) {
    if (_disposed) return;
    if (!account.listed) return _removedNow();
    // Channels to computers no longer on it, and their sessions, go.
    for (final p in [..._processes.values]) {
      if (_computer(p.hostKey) == null) _dropProcess(p, 'its computer is no longer on the list');
    }
    // The account's phone, which shows which computers have confirmed the
    // change, gives it to each running process by a channel of its own,
    // and hears its counter back; the channels in use stay as they are.
    if (account.isPhone) {
      for (final p in _processes.values) {
        _probe(p);
      }
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
    final known = _processes[_processId(ref.hostKey, ref.instanceId)]?.sessions[ref.sessionId];
    if (r.result != 'accepted') {
      // An older copy than one seen keeps the one seen; anything else is
      // left out, and opens nothing.
      if (r.reason == 'ordering' && known != null && (known.sealed != null || known.whole != null)) return _entry(known);
      debugPrint('hosted: an announcement was refused: ${r.reason}');
      return null;
    }
    _highest[key] = r.ordering!;
    final p = _process(ref.hostKey, ref.instanceId);
    final s = p.sessions.putIfAbsent(ref.sessionId, () => _Session(common.SessionRef(hostKey: ref.hostKey, sessionId: ref.sessionId, instanceId: ref.instanceId)));
    s.sealed = r.body;
    final own = r.body!.computerName;
    if (own.isNotEmpty && _computerNames[hexOf(ref.hostKey)] != own) {
      _computerNames[hexOf(ref.hostKey)] = own;
      if (_devices != null) _sendKeys();
    }
    s.announcedAt = e.hasAnnouncedAt() ? e.announcedAt : null;
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
    if (_channels.length >= maxChannels) {
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

  void _probe(_Process p) {
    // Probes and the processes' channels share one cap.
    if (!_connected || _channels.length >= maxChannels) return;
    final computer = _computer(p.hostKey);
    if (computer == null) return;
    final ch = HostedChannel(
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
    _probes.add(ch);
    ch.open();
  }

  void _confirm(List<int> hostKey, Int64 counter) {
    final k = hexOf(hostKey);
    final had = _confirmed[k];
    if (had == null || counter > had) _confirmed[k] = counter;
  }

  @override
  void listState(HostedChannel ch, Int64 counter, Uint8List? newer) {
    _confirm(ch.hostKey, counter);
    if (_probes.contains(ch)) {
      if (newer != null) unawaited(_take(newer, fromRelay: false));
      ch.close(ErrorCode.ERROR_CODE_SESSION_GONE, 'heard its counter');
      _sendKeys();
      return;
    }
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
    if (_probes.contains(ch)) return;
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
    // Opened, and not answered yet: the relay's answer is closed when it comes.
    if (ch.id == null && ch.sentOpen && _ready) _abandoned.add(ch.requestId);
    if (_probes.remove(ch)) return;
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
    for (final ch in [..._probes]) {
      ch.close(ErrorCode.ERROR_CODE_SESSION_GONE, why, tell: tell);
    }
    _probes.clear();
  }

  // --- Devices and names -------------------------------------------------

  Future<void> _loadSeen() async {
    final kept = await values?.get(namesSeenKey);
    if (kept == null) return;
    final Int64 v;
    try {
      v = Int64.parseInt(kept);
    } on FormatException {
      return;
    }
    if (!v.isNegative && (_namesHighest == null || v > _namesHighest!)) _namesHighest = v;
  }

  Future<void> _openNames(List<int> sealed) async {
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
    await values?.set(namesSeenKey, '${r.ordering}');
    if (_disposed) return;
    final before = _names;
    _names = {for (final n in r.names) hexOf(n.signingKey): n.name};
    // A computer's sessions show under its name: given again when it changed.
    for (final p in _processes.values) {
      final k = hexOf(p.hostKey);
      if (before[k] == _names[k]) continue;
      for (final s in p.sessions.values) {
        toClient(v1.Frame(sessionUpdated: v1.SessionUpdated(entry: _entry(s))));
      }
    }
  }

  void _sendKeys() {
    final status = <String, v2.DeviceStatus>{for (final d in _devices?.devices ?? <v2.DeviceStatus>[]) hexOf(d.publicKey): d};
    toClient(v1.Frame(
      keys: v1.Keys(keys: [
        for (final d in account.newest.body.devices)
          v1.RegisteredKey(
            publicKey: d.signingKey,
            role: d.role == roleComputer ? v1.Role.ROLE_HOST : v1.Role.ROLE_CLIENT,
            label: _names[hexOf(d.signingKey)] ?? _computerNames[hexOf(d.signingKey)] ?? '',
            online: status[hexOf(d.signingKey)]?.online ?? false,
            push: status[hexOf(d.signingKey)]?.push ?? false,
            readKey: d.readOnlyKey.isNotEmpty,
          ),
      ]),
    ));
  }

  /// The highest list counter each computer's channels said, by signing
  /// key in hex.
  Map<String, Int64> get hostCounters => Map.unmodifiable(_confirmed);

  // --- For the account's screens ----------------------------------------

  /// Every frame from the relay, as it comes, for a join (AddDevice).
  Stream<v2.Frame> get frames => _frames.stream;

  /// Sends a frame to the relay as it is; false when it could not.
  bool sendRaw(v2.Frame f) => _connected && sendRelay(f);

  /// The names the account's phone sealed, as last opened, by signing key
  /// in hex; and the highest ordering seen, for the phone's next.
  Map<String, String> get names => Map.unmodifiable(_names);
  Int64? get namesOrdering => _namesHighest;

  /// The computers on the newest list that have not confirmed it: no
  /// channel of theirs has said its counter, or one said a lower one. By
  /// signing key in hex.
  Set<String> get behind => {
        for (final d in account.newest.body.devices)
          if (d.role == roleComputer && (_confirmed[hexOf(d.signingKey)] ?? Int64.ZERO) < account.newest.counter) hexOf(d.signingKey),
      };

  /// A fresh request ID.
  String requestId(String kind) => '$kind${++_requests}';

  /// Sends [f], whose request ID is [id], and completes on its Done; with
  /// HostedRefusal on its Error, StateError when not sent or the
  /// connection goes, TimeoutException after [timeout].
  Future<void> request(String id, v2.Frame f, {Duration timeout = const Duration(seconds: 20)}) {
    if (!sendRaw(f)) return Future.error(StateError('not connected to the relay'));
    final c = _waiting[id] = Completer<void>();
    return c.future.timeout(timeout, onTimeout: () {
      _waiting.remove(id);
      throw TimeoutException('the relay did not answer');
    });
  }

  void _failWaiting(String why) {
    final all = [..._waiting.values];
    _waiting.clear();
    for (final c in all) {
      c.completeError(StateError(why));
    }
  }

  // --- From the Client -----------------------------------------------------

  /// The bytes held back on their way to a session's computer: queued for
  /// its channel's window, or held until the channel opens.
  int backlog(common.SessionRef ref) {
    final p = _processes[_processId(ref.hostKey, ref.instanceId)];
    if (p == null) return 0;
    return (p.channel?.backlog ?? 0) + p.held.fold(0, (n, h) => n + h.$2.length);
  }

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
