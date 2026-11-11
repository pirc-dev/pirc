// The app as a PiRC client: the live sessions, each one's chat from history
// and live events, and requests to sessions with their replies. A port of
// web/core/client.ts, held to the same cases (cases/README.md). It reads
// and writes relay frames but holds no connection.
import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';

import 'images.dart';
import 'protocol.dart';
import 'view.dart';

// How long a process may be without a session before it is gone.
const endGraceMs = 3000;
// How long a request may wait for its answer.
const requestMs = 45000;
// History asked for on attach and after a gap.
const historyLimit = 200;
// The images of user messages kept, all sessions together.
const imageBytes = 32 << 20;

abstract class Clock {
  Object setTimeout(void Function() fn, int ms);
  void clearTimeout(Object? t);
}

class _RealClock implements Clock {
  @override
  Object setTimeout(void Function() fn, int ms) => Timer(Duration(milliseconds: ms), fn);
  @override
  void clearTimeout(Object? t) => (t as Timer?)?.cancel();
}

// The relay's answer to one of its own requests, or a token it issued.
class RelayAnswer {
  const RelayAnswer.ok({this.token, this.expiresAt})
      : ok = true,
        code = '',
        message = '';
  const RelayAnswer.failed(this.code, this.message)
      : ok = false,
        token = null,
        expiresAt = null;

  final bool ok;
  final String code;
  final String message;
  final String? token;
  final int? expiresAt;
}

class _Live {
  _Live(this.view, this.ref, this.chat);

  SessionView view;
  SessionRef ref;
  ChatView chat;
  // The last event applied; null until history arrives.
  Int64? lastSeq;
  // Events that came while history was being fetched.
  List<SessionEvent>? buffered = [];
  // The history request in flight, if any, and the entry it asked for what
  // follows.
  String? historyId;
  String? historyAfter;
  Object? endTimer;
  // Numbers items that have no ID of their own yet.
  int unsaved = 0;
}

class _Pending {
  _Pending(this.to, this.resolve, this.extend);

  final SessionRef to;
  void Function(SessionMessage) resolve;
  Object? timer;
  final bool Function()? extend;
}

class _Deciding {
  _Deciding(this.resolve, this.timer);
  final void Function(RelayAnswer) resolve;
  final Object timer;
}

// A process's ID: its host and instance, the same across its sessions.
String viewId(SessionRef s) => '${hex(s.hostKey).substring(0, 16)}-${s.instanceId}';

const _stop = {
  StopReason.STOP_REASON_STOP: 'stop',
  StopReason.STOP_REASON_LENGTH: 'length',
  StopReason.STOP_REASON_TOOL_USE: 'tool_use',
  StopReason.STOP_REASON_ABORTED: 'aborted',
  StopReason.STOP_REASON_ERROR: 'error',
  StopReason.STOP_REASON_DEFERRED: 'deferred',
};

const _question = {
  QuestionKind.QUESTION_KIND_SELECT: 'select',
  QuestionKind.QUESTION_KIND_CONFIRM: 'confirm',
  QuestionKind.QUESTION_KIND_INPUT: 'input',
  QuestionKind.QUESTION_KIND_EDITOR: 'editor',
  QuestionKind.QUESTION_KIND_CUSTOM: 'custom',
};

const _notice = {
  NoticeKind.NOTICE_KIND_FINISHED: 'finished',
  NoticeKind.NOTICE_KIND_FAILED: 'failed',
  NoticeKind.NOTICE_KIND_QUESTION: 'question',
};

int _ms(Timestamp t) => timestampMs(t);

ModelView? _modelView(Model m) => ModelView(provider: m.provider, id: m.id, name: m.name);

PlaceView? _placeView(SessionAnnouncement a) {
  if (!a.hasPlace()) return null;
  final p = a.place;
  String? s(String x) => x.isEmpty ? null : x;
  final v = PlaceView(
    kind: p.kind,
    group: s(p.group),
    groupNumber: p.hasGroupNumber() ? p.groupNumber : null,
    window: s(p.window),
    windowNumber: p.hasWindowNumber() ? p.windowNumber : null,
    pane: s(p.pane),
    display: s(p.display),
  );
  return v.group != null || v.window != null || v.pane != null || v.display != null ? v : null;
}

// The questions a client can make sense of; one of a kind it does not
// know is shown as a dialog in the terminal.
List<QuestionView> _questionViews(SessionAnnouncement a) => [
      for (final q in a.questions)
        QuestionView(
          id: q.id,
          kind: _question[q.kind] ?? 'custom',
          title: q.title,
          message: q.message.isEmpty ? null : q.message,
          options: q.options.isEmpty ? null : List.of(q.options),
          placeholder: q.placeholder.isEmpty ? null : q.placeholder,
          answerable: q.answerable && _question.containsKey(q.kind),
          askedAt: q.hasAskedAt() ? _ms(q.askedAt) : 0,
        ),
    ];

NoticeView? _noticeView(SessionAnnouncement a) {
  if (!a.hasNotice()) return null;
  final kind = _notice[a.notice.kind];
  return kind == null ? null : NoticeView(number: a.notice.number.toInt(), kind: kind, text: a.notice.text);
}

SessionView _sessionView(String id, SessionEntry e, SessionAnnouncement a) {
  final questions = _questionViews(a);
  return SessionView(
    id: id,
    sessionId: e.hasSession() ? e.session.sessionId : '',
    hostLabel: e.hostLabel,
    hostname: a.hostname,
    name: a.name,
    first: a.firstPrompt.isEmpty ? null : a.firstPrompt,
    cwd: a.cwd,
    model: a.hasModel() ? _modelView(a.model) : null,
    thinking: thinkingName(a.thinkingLevel),
    working: a.working,
    compacting: a.compacting,
    startedAt: a.hasStartedAt() && _ms(a.startedAt) != 0 ? _ms(a.startedAt) : null,
    piVersion: a.piVersion,
    extensionVersion: a.extensionVersion,
    requests: a.requests.isEmpty ? null : List.of(a.requests),
    place: _placeView(a),
    launcher: a.launcher.isEmpty ? null : a.launcher,
    launchId: a.launchId.isEmpty ? null : a.launchId,
    questions: questions.isEmpty ? null : questions,
    notice: _noticeView(a),
  );
}

// A key as the relay shows it, base64url without padding, and back.
String keyText(List<int> b) => base64Url.encode(b).replaceAll('=', '');

Uint8List? keyBytes(String s) {
  if (!RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(s)) return null;
  return base64Url.decode('$s=');
}

RelayAnswer _failed(ErrorCode code, String message) => RelayAnswer.failed(errorName(code), message);

// Found when a chat has no saved item.
const _noItem = BranchSummaryItem(id: '', turnId: '', at: 0, summary: '');

ChatView _emptyChat(bool loading) => ChatView(items: const [], truncated: false, loading: loading);

String _randomId() {
  final r = Random.secure();
  final b = [for (var i = 0; i < 16; i++) r.nextInt(256)];
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = hex(b);
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

class Client {
  Client({
    required this.send,
    required this.onEvent,
    String Function()? newId,
    Clock? clock,
    int? imageBytes,
    this.publicKey,
  })  : _newId = newId ?? _randomId,
        _clock = clock ?? _RealClock(),
        _images = ImageStore(imageBytes ?? imageBytes_);

  static const imageBytes_ = imageBytes;

  // Sends a frame to the relay; false when it could not.
  final bool Function(Frame) send;
  // Every change, in order.
  final void Function(ViewEvent) onEvent;
  // This client's own public key, to mark it in the devices.
  final List<int>? publicKey;
  final String Function() _newId;
  final Clock _clock;
  final ImageStore _images;

  final _sessions = <String, _Live>{};
  final _pending = <String, _Pending>{};
  final _deciding = <String, _Deciding>{};
  List<PendingHostView> _pendingHosts = [];
  List<DeviceView> _devices = [];
  RelayView _relay = const RelayView(state: 'connecting');
  // Sessions seen in the list arriving after a (re)connect.
  Set<String>? _listing;
  // Chats kept from before, by pi's session ID (seed).
  final _seeds = <String, ChatView>{};

  Snapshot snapshot() => Snapshot(
        relay: _relay,
        sessions: [for (final s in _sessions.values) s.view],
        pendingHosts: _pendingHosts,
        devices: _devices,
      );

  ChatView? chat(String id) => _sessions[id]?.chat;

  // An image of a user message, by its key; null when no longer kept.
  StoredImage? image(String key) => _images.get(key);

  // A kept thumbnail of an image, by the image's key, for a chat seeded
  // from the phone: the relay sends only what follows it. The image itself
  // replaces it if it comes.
  void seedImage(String key, StoredImage thumb) => _images.putSmall(key, thumb);

  // --- The relay connection -------------------------------------------------

  // The connection's state changed. "ready" is a fresh login: the relay
  // remembers no subscription or attachment from before.
  void onState(RelayView relay) {
    _relay = relay;
    onEvent(RelayChanged(relay));
    if (relay.state == 'ready') {
      _listing = {};
      _send(Frame(subscribeSessions: SubscribeSessions()));
      _send(Frame(watchPendingHosts: WatchPendingHosts()));
      _send(Frame(watchKeys: WatchKeys()));
      return;
    }
    if (relay.state == 'connecting') return;
    if (_pendingHosts.isNotEmpty) _setPendingHosts([]);
    if (_devices.isNotEmpty) _setDevices([]);
    for (final d in _deciding.values) {
      _clock.clearTimeout(d.timer);
      d.resolve(_failed(ErrorCode.ERROR_CODE_SESSION_GONE, 'lost the connection to the relay'));
    }
    _deciding.clear();
    for (final MapEntry(key: id, value: p) in _pending.entries) {
      _clock.clearTimeout(p.timer);
      p.resolve(errorReply(id, ErrorCode.ERROR_CODE_SESSION_GONE, 'lost the connection to the relay'));
    }
    _pending.clear();
    for (final s in _sessions.values) {
      s.historyId = null;
    }
  }

  void onFrame(Frame f) {
    switch (f.whichBody()) {
      case Frame_Body.sessionList:
        final seen = _listing ??= {};
        for (final e in f.sessionList.sessions) {
          final id = _upsert(e);
          if (id != null) seen.add(id);
        }
        if (!f.sessionList.more) {
          for (final MapEntry(key: id, value: s) in _sessions.entries.toList()) {
            if (!seen.contains(id)) _endSoon(s);
          }
          _listing = null;
        }
      case Frame_Body.sessionUpdated:
        if (f.sessionUpdated.hasEntry()) _upsert(f.sessionUpdated.entry);
      case Frame_Body.sessionEnded:
        if (!f.sessionEnded.hasSession()) return;
        final ref = f.sessionEnded.session;
        _failPending(ref, 'the session has ended');
        final s = _sessions[viewId(ref)];
        if (s != null && s.ref.sessionId == ref.sessionId) _endSoon(s);
      case Frame_Body.routed:
        if (f.routed.hasSession()) _onRouted(f.routed.session, f.routed.payload);
      case Frame_Body.pendingHosts:
        _setPendingHosts([
          for (final h in f.pendingHosts.hosts)
            PendingHostView(
              key: keyText(h.publicKey),
              label: h.label,
              software: h.software,
              remote: h.remote,
              firstSeen: h.hasFirstSeen() ? _ms(h.firstSeen) : 0,
            ),
        ]);
      case Frame_Body.keys:
        final own = publicKey == null ? null : keyText(publicKey!);
        _setDevices([
          for (final k in f.keys.keys)
            DeviceView(
              key: keyText(k.publicKey),
              role: k.role == Role.ROLE_HOST ? 'host' : 'client',
              label: k.label,
              addedAt: k.hasAddedAt() ? _ms(k.addedAt) : 0,
              online: k.online,
              self: keyText(k.publicKey) == own,
              push: k.push,
            ),
        ]);
      case Frame_Body.hostDecided:
        _decided(f.hostDecided.requestId, const RelayAnswer.ok());
      case Frame_Body.keyChanged:
        _decided(f.keyChanged.requestId, const RelayAnswer.ok());
      case Frame_Body.tokenIssued:
        final t = f.tokenIssued;
        _decided(t.requestId, RelayAnswer.ok(token: t.token, expiresAt: t.hasExpiresAt() ? _ms(t.expiresAt) : 0));
      case Frame_Body.error:
        // Only the relay's own requests end here; the others end by
        // sessionEnded or their deadline.
        _decided(f.error.requestId, _failed(f.error.code, f.error.message));
      default:
        return;
    }
  }

  void _setPendingHosts(List<PendingHostView> hosts) {
    _pendingHosts = hosts;
    onEvent(PendingHostsChanged(hosts));
  }

  void _setDevices(List<DeviceView> devices) {
    _devices = devices;
    onEvent(DevicesChanged(devices));
  }

  void _decided(String requestId, RelayAnswer d) {
    final w = _deciding.remove(requestId);
    if (w == null) return;
    _clock.clearTimeout(w.timer);
    w.resolve(d);
  }

  // Approves or rejects a waiting host, by its key as the relay shows it.
  Future<RelayAnswer> decide(String key, bool approve, [String label = '']) {
    final publicKey = keyBytes(key);
    if (publicKey == null) return Future.value(_failed(ErrorCode.ERROR_CODE_INVALID, 'not a host key'));
    final requestId = _newId();
    final sent = approve
        ? _send(Frame(approveHost: ApproveHost(requestId: requestId, publicKey: publicKey, label: label)))
        : _send(Frame(rejectHost: RejectHost(requestId: requestId, publicKey: publicKey)));
    return _answered(requestId, sent);
  }

  // Renames a registered device, by its key as the relay shows it.
  Future<RelayAnswer> rename(String key, String label) {
    final publicKey = keyBytes(key);
    if (publicKey == null) return Future.value(_failed(ErrorCode.ERROR_CODE_INVALID, "not a host's or an app's key"));
    final requestId = _newId();
    return _answered(requestId, _send(Frame(renameKey: RenameKey(requestId: requestId, publicKey: publicKey, label: label))));
  }

  // Removes a registered device. The relay refuses this client's own.
  Future<RelayAnswer> remove(String key) {
    final publicKey = keyBytes(key);
    if (publicKey == null) return Future.value(_failed(ErrorCode.ERROR_CODE_INVALID, "not a host's or an app's key"));
    final requestId = _newId();
    return _answered(requestId, _send(Frame(removeKey: RemoveKey(requestId: requestId, publicKey: publicKey))));
  }

  // A one-time token for registering a new device of role ("host" or
  // "client").
  Future<RelayAnswer> issueToken(String role, String label) {
    final requestId = _newId();
    return _answered(
      requestId,
      _send(Frame(issueToken: IssueToken(requestId: requestId, role: role == 'host' ? Role.ROLE_HOST : Role.ROLE_CLIENT, label: label))),
    );
  }

  Future<RelayAnswer> _answered(String requestId, bool sent) {
    if (!sent) return Future.value(_failed(ErrorCode.ERROR_CODE_BUSY, 'not connected to the relay'));
    final c = Completer<RelayAnswer>();
    final timer = _clock.setTimeout(() => _decided(requestId, _failed(ErrorCode.ERROR_CODE_TIMEOUT, 'no answer from the relay')), requestMs);
    _deciding[requestId] = _Deciding(c.complete, timer);
    return c.future;
  }

  bool _send(Frame f) => send(f);

  String? _upsert(SessionEntry e) {
    if (!e.hasSession()) return null;
    final ref = e.session;
    final SessionAnnouncement a;
    try {
      a = SessionAnnouncement.fromBuffer(e.payload);
    } catch (_) {
      return null;
    }
    final id = viewId(ref);
    final s = _sessions[id];
    final last = s != null && s.ref.sessionId == ref.sessionId ? s.view.last : null;
    final view = _sessionView(id, e, a).withLast(last);
    if (s == null) {
      final live = _Live(view, ref, _seeded(ref.sessionId));
      _sessions[id] = live;
      onEvent(SessionChanged(view));
      if (live.chat.items.isNotEmpty) onEvent(ChatReset(id, live.chat));
      _attach(live);
      return id;
    }
    _clock.clearTimeout(s.endTimer);
    s.endTimer = null;
    if (jsonEncode(view.toJson()) != jsonEncode(s.view.toJson())) {
      s.view = view;
      onEvent(SessionChanged(view));
    }
    if (s.ref.sessionId != ref.sessionId) {
      // The process moved to another session: its chat starts again.
      _failPending(s.ref, 'the session was replaced');
      s.ref = ref;
      s.chat = _seeded(ref.sessionId);
      s.lastSeq = null;
      s.buffered = [];
      s.historyId = null;
      onEvent(ChatReset(id, s.chat));
      _attach(s);
    } else if (_listing != null && s.historyId == null) {
      // After a reconnect: attach again, and catch up on what was missed.
      s.ref = ref;
      _attach(s);
    }
    return id;
  }

  // A chat this client kept from before, by pi's session ID, for when a
  // process with that session is first seen: the chat starts from it, still
  // loading, and its history is asked for only after its last saved item.
  // Each seed is used once. The app seeds the chats it keeps on the phone.
  void seed(String sessionId, ChatView chat) => _seeds[sessionId] = chat;

  ChatView _seeded(String sessionId) => _seeds.remove(sessionId)?.copyWith(loading: true) ?? _emptyChat(true);

  void _attach(_Live s) {
    _send(Frame(attach: Attach(session: s.ref)));
    _fetchHistory(s);
  }

  void _endSoon(_Live s) {
    _clock.clearTimeout(s.endTimer);
    s.endTimer = _clock.setTimeout(() {
      if (_sessions[s.view.id] != s) return;
      _sessions.remove(s.view.id);
      _failPending(s.ref, 'the session has ended');
      onEvent(SessionGone(s.view.id));
    }, endGraceMs);
  }

  // --- History and events --------------------------------------------------

  void _fetchHistory(_Live s) {
    if (s.historyId != null) return;
    s.buffered ??= [];
    if (!s.chat.loading) s.chat = s.chat.copyWith(loading: true);
    final requestId = _newId();
    s.historyId = requestId;
    // A chat it has already is caught up from its last saved item, which the
    // session answers with only what follows, when it can.
    final after = s.chat.items.lastWhere((x) => (x.entryId ?? '').isNotEmpty, orElse: () => _noItem).entryId;
    s.historyAfter = after;
    final req = HistoryRequest(requestId: requestId, limit: historyLimit);
    if (after != null) req.afterEntryId = after;
    _request(s.ref, SessionMessage(historyRequest: req), requestId).then((m) {
      if (_sessions[s.view.id] != s || s.historyId != requestId) return;
      s.historyId = null;
      if (m.whichBody() != SessionMessage_Body.history) {
        // Asked again on the next gap or reconnect.
        s.chat = s.chat.copyWith(loading: false);
        s.buffered = null;
        onEvent(ChatReset(s.view.id, s.chat));
        return;
      }
      _applyHistory(s, m.history);
    });
  }

  void _applyHistory(_Live s, History h) {
    // What follows the entry asked after: the chat up to that entry's items
    // stays, what came after it goes. Else the history replaces it.
    final at = h.fromEntry && s.historyAfter != null ? s.chat.items.lastIndexWhere((x) => x.entryId == s.historyAfter) : -1;
    s.chat = at >= 0
        ? ChatView(items: s.chat.items.sublist(0, at + 1), truncated: s.chat.truncated, loading: false)
        : ChatView(items: const [], truncated: h.truncated, loading: false);
    for (final it in h.items) {
      _applyItem(s, it, false);
    }
    s.lastSeq = h.seq;
    onEvent(ChatReset(s.view.id, s.chat));
    _updateLast(s);
    // Those the history already reflects are dropped by their seq.
    final later = s.buffered ?? [];
    s.buffered = null;
    for (final ev in later) {
      _applyEvent(s, ev);
    }
  }

  void _onRouted(SessionRef ref, List<int> payload) {
    final SessionMessage m;
    try {
      m = SessionMessage.fromBuffer(payload);
    } catch (_) {
      return;
    }
    if (m.whichBody() == SessionMessage_Body.event) {
      final s = _sessions[viewId(ref)];
      if (s == null || s.ref.sessionId != ref.sessionId) return;
      if (s.buffered != null) {
        s.buffered!.add(m.event);
        return;
      }
      _applyEvent(s, m.event);
      return;
    }
    final requestId = requestIdOf(bodyOf(m));
    if (requestId.isEmpty) return;
    final p = _pending[requestId];
    if (p == null || !sameRef(p.to, ref)) return;
    _pending.remove(requestId);
    _clock.clearTimeout(p.timer);
    p.resolve(m);
  }

  void _applyEvent(_Live s, SessionEvent ev) {
    final last = s.lastSeq;
    if (last != null && ev.seq <= last) return;
    if (last != null && ev.seq != last + 1) {
      // Missed events: fetch history, keeping what comes meanwhile.
      s.lastSeq = null;
      s.buffered = [ev];
      _fetchHistory(s);
      return;
    }
    s.lastSeq = ev.seq;
    switch (ev.whichBody()) {
      case SessionEvent_Body.item:
        _applyItem(s, ev.item, true);
      case SessionEvent_Body.assistantDelta:
        final d = ev.assistantDelta;
        final String kind;
        final String text;
        switch (d.whichBody()) {
          case AssistantDelta_Body.text:
            (kind, text) = ('text', d.text);
          case AssistantDelta_Body.thinking:
            (kind, text) = ('thinking', d.thinking);
          default:
            return;
        }
        _emitChat(s, ChatDelta(
          id: s.view.id, itemId: d.messageId, turnId: d.turnId, at: ev.hasAt() ? _ms(ev.at) : 0,
          block: d.blockIndex, kind: kind, text: text,
        ));
      case SessionEvent_Body.toolProgress:
        _emitChat(s, ToolProgressChanged(id: s.view.id, itemId: ev.toolProgress.toolCallId, text: ev.toolProgress.text));
      case SessionEvent_Body.branchChanged:
        // The session moved in its tree: the conversation is another one.
        _fetchHistory(s);
      default:
        // Working and announcement changes come with the session list.
        return;
    }
  }

  // An item as the chat's: a tool result joins its call.
  void _applyItem(_Live s, ConversationItem it, bool emit) {
    final at = it.hasAt() ? _ms(it.at) : 0;
    final entryId = it.entryId.isEmpty ? null : it.entryId;
    final ChatItem item;
    switch (it.whichBody()) {
      case ConversationItem_Body.userMessage:
        final v = it.userMessage;
        item = UserItem(
          id: entryId != null ? 'e-$entryId' : v.requestId.isNotEmpty ? 'r-${v.requestId}' : 'u-${s.unsaved++}',
          entryId: entryId,
          turnId: it.turnId,
          at: at,
          text: v.text,
          images: [
            for (final i in v.images)
              ImageView(mimeType: i.mimeType, key: i.data.isNotEmpty ? _images.put(i.mimeType, Uint8List.fromList(i.data)) : null),
          ],
          requestId: v.requestId.isEmpty ? null : v.requestId,
        );
      case ConversationItem_Body.assistantMessage:
        final v = it.assistantMessage;
        item = AssistantItem(
          id: v.messageId.isNotEmpty ? v.messageId : 'e-${it.entryId}',
          entryId: entryId,
          turnId: it.turnId,
          at: at,
          blocks: [
            for (final c in v.content)
              if (c.whichBody() == ContentBlock_Body.text)
                Block(kind: 'text', text: c.text)
              else if (c.whichBody() == ContentBlock_Body.thinking)
                Block(kind: 'thinking', text: c.thinking),
          ],
          streaming: false,
          stop: _stop[v.stopReason],
          error: v.errorMessage.isEmpty ? null : v.errorMessage,
          model: v.hasModel() ? _modelView(v.model) : null,
          usage: v.hasUsage()
              ? UsageView(
                  input: v.usage.inputTokens.toInt(),
                  output: v.usage.outputTokens.toInt(),
                  cacheRead: v.usage.cacheReadTokens.toInt(),
                  cacheWrite: v.usage.cacheWriteTokens.toInt(),
                  cost: v.usage.cost,
                )
              : null,
        );
      case ConversationItem_Body.toolCall:
        final v = it.toolCall;
        item = ToolItem(id: v.toolCallId, entryId: entryId, turnId: it.turnId, at: at, name: v.toolName, args: v.argumentsJson);
      case ConversationItem_Body.toolResult:
        final v = it.toolResult;
        final result = ToolResultView(
          text: v.text,
          isError: v.isError,
          durationMs: v.hasDurationMs() ? v.durationMs : null,
          exitCode: v.hasExitCode() ? v.exitCode : null,
          diff: v.diff.isEmpty ? null : v.diff,
        );
        final call = s.chat.items.whereType<ToolItem>().where((x) => x.id == v.toolCallId).firstOrNull;
        item = call != null
            ? call.withResult(result)
            : ToolItem(id: v.toolCallId, entryId: entryId, turnId: it.turnId, at: at, name: '', args: '', result: result);
      case ConversationItem_Body.compaction:
        item = CompactionItem(
          id: entryId != null ? 'e-$entryId' : 'c-${s.unsaved++}',
          entryId: entryId,
          turnId: it.turnId,
          at: at,
          summary: it.compaction.summary,
          tokensBefore: it.compaction.tokensBefore.toInt(),
        );
      case ConversationItem_Body.branchSummary:
        item = BranchSummaryItem(
          id: entryId != null ? 'e-$entryId' : 'b-${s.unsaved++}',
          entryId: entryId,
          turnId: it.turnId,
          at: at,
          summary: it.branchSummary.summary,
        );
      default:
        return;
    }
    final e = ChatItemChanged(s.view.id, item);
    if (emit) {
      _emitChat(s, e);
    } else {
      s.chat = applyToChat(s.chat, e);
    }
  }

  void _emitChat(_Live s, ViewEvent e) {
    s.chat = applyToChat(s.chat, e);
    onEvent(e);
    if (e is ChatItemChanged) _updateLast(s);
  }

  // The session's latest message, for the list, when it changed.
  void _updateLast(_Live s) {
    final last = lastOf(s.chat.items);
    if (last == s.view.last) return;
    s.view = s.view.withLast(last);
    onEvent(SessionChanged(s.view));
  }

  // --- Requests ----------------------------------------------------------------

  // Sends a request, the body of request, to a session and completes with
  // its answer, or an error made here (SESSION_GONE, BUSY, TIMEOUT, INVALID).
  // It never fails.
  Future<SessionMessage> ask(String id, SessionMessage request, [bool Function()? extend]) {
    final s = _sessions[id];
    final requestId = requestIdOf(bodyOf(request));
    if (s == null || s.endTimer != null) {
      return Future.value(errorReply(requestId, ErrorCode.ERROR_CODE_SESSION_GONE, 'the session has ended'));
    }
    // A request the session says it does not take would go unanswered.
    final name = requestName(request);
    final takes = s.view.requests;
    if (takes != null && !takes.contains(name)) {
      return Future.value(errorReply(
        requestId,
        ErrorCode.ERROR_CODE_INVALID,
        "this session's extension (${s.view.extensionVersion}) does not take $name; update it",
      ));
    }
    return _request(s.ref, request, requestId, extend);
  }

  // A fresh request ID.
  String id() => _newId();

  // Whether the session is compacting, for a compaction's deadline.
  bool compacting(String id) => _sessions[id]?.view.compacting ?? false;

  // Whether the session is asking a question, for a prompt's deadline.
  bool asking(String id) => (_sessions[id]?.view.questions ?? const []).isNotEmpty;

  Future<SessionMessage> _request(SessionRef to, SessionMessage request, String requestId, [bool Function()? extend]) {
    if (requestId.isEmpty) return Future.value(errorReply('', ErrorCode.ERROR_CODE_INVALID, 'a request needs an ID'));
    // A repeat waits for the same answer; the same ID to another session is
    // a mistake.
    final inFlight = _pending[requestId];
    if (inFlight != null && !sameRef(inFlight.to, to)) {
      return Future.value(errorReply(requestId, ErrorCode.ERROR_CODE_INVALID, 'a request with this ID is in flight to another session'));
    }
    if (inFlight != null) {
      final c = Completer<SessionMessage>();
      final first = inFlight.resolve;
      inFlight.resolve = (m) {
        first(m);
        c.complete(m);
      };
      return c.future;
    }
    // The ID beside the body too, for a session that does not know this
    // kind of request.
    final message = request.deepCopy()..requestId = requestId;
    if (!_send(Frame(routed: Routed(session: to, payload: message.writeToBuffer())))) {
      return Future.value(errorReply(requestId, ErrorCode.ERROR_CODE_BUSY, 'not connected to the relay, or the request is too large'));
    }
    final c = Completer<SessionMessage>();
    final p = _Pending(to, c.complete, extend);
    void expire() {
      final p = _pending[requestId];
      if (p == null) return;
      if (p.extend?.call() ?? false) {
        p.timer = _clock.setTimeout(expire, requestMs);
        return;
      }
      _pending.remove(requestId);
      p.resolve(errorReply(requestId, ErrorCode.ERROR_CODE_TIMEOUT, 'no answer from the session'));
    }

    p.timer = _clock.setTimeout(expire, requestMs);
    _pending[requestId] = p;
    return c.future;
  }

  void _failPending(SessionRef ref, String why) {
    for (final MapEntry(key: id, value: p) in _pending.entries.toList()) {
      if (!sameRef(p.to, ref)) continue;
      _pending.remove(id);
      _clock.clearTimeout(p.timer);
      p.resolve(errorReply(id, ErrorCode.ERROR_CODE_SESSION_GONE, why));
    }
  }
}
