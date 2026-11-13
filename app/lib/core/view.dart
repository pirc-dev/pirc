// What the app shows, shaped for the screen: the sessions and their chats,
// and the changes to them. A port of web/core/view.ts; each type's JSON is
// the TypeScript's, absent fields left out, so that both pass the shared
// cases (cases/README.md).

typedef Json = Map<String, Object?>;

// Builds a JSON object, leaving out the fields that are null.
Json _json(Map<String, Object?> fields) => {
      for (final e in fields.entries)
        if (e.value != null) e.key: e.value,
    };

int? _int(Object? v) => v == null ? null : (v as num).toInt();
List<T>? _list<T>(Object? v, T Function(Json) f) => v == null ? null : [for (final x in v as List) f(x as Json)];

// One pi process's session. The ID stays the same when the process moves
// to another session (/new, resume, fork): the chat is reset instead.
class SessionView {
  const SessionView({
    required this.id,
    required this.sessionId,
    required this.hostLabel,
    required this.hostname,
    required this.name,
    this.first,
    required this.cwd,
    this.model,
    this.thinking,
    required this.working,
    required this.compacting,
    this.startedAt,
    required this.piVersion,
    required this.extensionVersion,
    this.requests,
    this.place,
    this.launcher,
    this.launchId,
    this.last,
    this.questions,
    this.notice,
    this.usage,
  });

  final String id;
  // pi's ID for the session the process has now.
  final String sessionId;
  // The label the host's key is registered under on the relay.
  final String hostLabel;
  // The host's own name for itself.
  final String hostname;
  // pi's session name; empty when it has none.
  final String name;
  // The first line of the user's first message; absent before one.
  final String? first;
  final String cwd;
  final ModelView? model;
  // "off", "minimal", "low", "medium", "high", "xhigh" or "max".
  final String? thinking;
  final bool working;
  final bool compacting;
  // Milliseconds since the epoch.
  final int? startedAt;
  final String piVersion;
  final String extensionVersion;
  // The requests the session takes; absent when its extension does not say.
  final List<String>? requests;
  final PlaceView? place;
  final String? launcher;
  final String? launchId;
  // The chat's latest message, for the session list; absent before one.
  final LastView? last;
  // The dialogs pi shows in its terminal, oldest first; absent when none.
  final List<QuestionView>? questions;
  // The latest notice the host raised; absent before the first.
  final NoticeView? notice;
  // What the session has cost and how full its context is (session.proto,
  // SessionAnnouncement); absent from extensions before 0.3.3.
  final SessionUsageView? usage;

  SessionView withLast(LastView? last) => SessionView(
        id: id, sessionId: sessionId, hostLabel: hostLabel, hostname: hostname, name: name, first: first, cwd: cwd,
        model: model, thinking: thinking, working: working, compacting: compacting, startedAt: startedAt,
        piVersion: piVersion, extensionVersion: extensionVersion, requests: requests, place: place,
        launcher: launcher, launchId: launchId, last: last, questions: questions, notice: notice, usage: usage,
      );

  factory SessionView.fromJson(Json j) => SessionView(
        id: j['id'] as String,
        sessionId: j['sessionId'] as String,
        hostLabel: j['hostLabel'] as String,
        hostname: j['hostname'] as String,
        name: j['name'] as String,
        first: j['first'] as String?,
        cwd: j['cwd'] as String,
        model: j['model'] == null ? null : ModelView.fromJson(j['model'] as Json),
        thinking: j['thinking'] as String?,
        working: j['working'] as bool,
        compacting: j['compacting'] as bool,
        startedAt: _int(j['startedAt']),
        piVersion: j['piVersion'] as String,
        extensionVersion: j['extensionVersion'] as String,
        requests: (j['requests'] as List?)?.cast<String>(),
        place: j['place'] == null ? null : PlaceView.fromJson(j['place'] as Json),
        launcher: j['launcher'] as String?,
        launchId: j['launchId'] as String?,
        last: j['last'] == null ? null : LastView.fromJson(j['last'] as Json),
        questions: _list(j['questions'], QuestionView.fromJson),
        notice: j['notice'] == null ? null : NoticeView.fromJson(j['notice'] as Json),
        usage: j['usage'] == null ? null : SessionUsageView.fromJson(j['usage'] as Json),
      );

  Json toJson() => _json({
        'id': id,
        'sessionId': sessionId,
        'hostLabel': hostLabel,
        'hostname': hostname,
        'name': name,
        'first': first,
        'cwd': cwd,
        'model': model?.toJson(),
        'thinking': thinking,
        'working': working,
        'compacting': compacting,
        'startedAt': startedAt,
        'piVersion': piVersion,
        'extensionVersion': extensionVersion,
        'requests': requests,
        'place': place?.toJson(),
        'launcher': launcher,
        'launchId': launchId,
        'last': last?.toJson(),
        'questions': questions?.map((q) => q.toJson()).toList(),
        'notice': notice?.toJson(),
        'usage': usage?.toJson(),
      });
}

class SessionUsageView {
  const SessionUsageView({required this.cost, this.contextTokens, required this.contextWindow});

  // In US dollars, the session's whole total.
  final double cost;
  // Absent when pi does not know it, as right after a compaction.
  final int? contextTokens;
  // 0 when there is no model.
  final int contextWindow;

  factory SessionUsageView.fromJson(Json j) =>
      SessionUsageView(cost: (j['cost'] as num).toDouble(), contextTokens: _int(j['contextTokens']), contextWindow: _int(j['contextWindow'])!);

  Json toJson() => _json({'cost': cost, 'contextTokens': contextTokens, 'contextWindow': contextWindow});
}

// A dialog pi shows for an extension. select, confirm and input can be
// answered from the app; an editor or a custom dialog only in pi's terminal.
class QuestionView {
  const QuestionView({
    required this.id,
    required this.kind,
    required this.title,
    this.message,
    this.options,
    this.placeholder,
    required this.answerable,
    required this.askedAt,
  });

  final String id;
  // "select", "confirm", "input", "editor" or "custom".
  final String kind;
  final String title;
  final String? message;
  final List<String>? options;
  final String? placeholder;
  final bool answerable;
  // Milliseconds since the epoch, by the host's clock.
  final int askedAt;

  factory QuestionView.fromJson(Json j) => QuestionView(
        id: j['id'] as String,
        kind: j['kind'] as String,
        title: j['title'] as String,
        message: j['message'] as String?,
        options: (j['options'] as List?)?.cast<String>(),
        placeholder: j['placeholder'] as String?,
        answerable: j['answerable'] as bool,
        askedAt: _int(j['askedAt'])!,
      );

  Json toJson() => _json({
        'id': id,
        'kind': kind,
        'title': title,
        'message': message,
        'options': options,
        'placeholder': placeholder,
        'answerable': answerable,
        'askedAt': askedAt,
      });
}

// session.proto, Notice: the latest thing worth a notification.
class NoticeView {
  const NoticeView({required this.number, required this.kind, required this.text});

  // Goes up with each notice of the session: the time it was raised in
  // milliseconds since the epoch, by the host's clock, or one past the last.
  final int number;
  // "finished", "failed" or "question".
  final String kind;
  final String text;

  factory NoticeView.fromJson(Json j) =>
      NoticeView(number: _int(j['number'])!, kind: j['kind'] as String, text: j['text'] as String);

  Json toJson() => {'number': number, 'kind': kind, 'text': text};
}

class LastView {
  const LastView({required this.who, required this.text, required this.at});

  // "user" or "assistant".
  final String who;
  // Its first line, cut short.
  final String text;
  // Milliseconds since the epoch, by the host's clock.
  final int at;

  factory LastView.fromJson(Json j) => LastView(who: j['who'] as String, text: j['text'] as String, at: _int(j['at'])!);

  Json toJson() => {'who': who, 'text': text, 'at': at};

  @override
  bool operator ==(Object other) => other is LastView && other.who == who && other.text == text && other.at == at;

  @override
  int get hashCode => Object.hash(who, text, at);
}

// The terminal pi runs in: its tmux or herdr names, or an extension's.
class PlaceView {
  const PlaceView({required this.kind, this.group, this.groupNumber, this.window, this.windowNumber, this.pane, this.display});

  final String kind;
  final String? group;
  final int? groupNumber;
  final String? window;
  final int? windowNumber;
  final String? pane;
  // Shown as it is, in place of the names, when given.
  final String? display;

  factory PlaceView.fromJson(Json j) => PlaceView(
        kind: j['kind'] as String,
        group: j['group'] as String?,
        groupNumber: _int(j['groupNumber']),
        window: j['window'] as String?,
        windowNumber: _int(j['windowNumber']),
        pane: j['pane'] as String?,
        display: j['display'] as String?,
      );

  Json toJson() => _json({
        'kind': kind,
        'group': group,
        'groupNumber': groupNumber,
        'window': window,
        'windowNumber': windowNumber,
        'pane': pane,
        'display': display,
      });
}

class ModelView {
  const ModelView({required this.provider, required this.id, required this.name});

  final String provider;
  final String id;
  final String name;

  factory ModelView.fromJson(Json j) => ModelView(provider: j['provider'] as String, id: j['id'] as String, name: j['name'] as String);

  Json toJson() => {'provider': provider, 'id': id, 'name': name};
}

// An item of a chat. Each kind's JSON has its "kind".
sealed class ChatItem {
  const ChatItem({required this.id, this.entryId, required this.turnId, required this.at});

  final String id;
  // pi's ID for the entry, when it has saved one.
  final String? entryId;
  final String turnId;
  // Milliseconds since the epoch, by the host's clock.
  final int at;

  static ChatItem fromJson(Json j) => switch (j['kind']) {
        'user' => UserItem.fromJson(j),
        'assistant' => AssistantItem.fromJson(j),
        'tool' => ToolItem.fromJson(j),
        'compaction' => CompactionItem.fromJson(j),
        'branchSummary' => BranchSummaryItem.fromJson(j),
        _ => throw FormatException('unknown chat item kind ${j['kind']}'),
      };

  Json toJson();

  Json _base(String kind) => _json({'kind': kind, 'id': id, 'entryId': entryId, 'turnId': turnId, 'at': at});
}

class UserItem extends ChatItem {
  const UserItem({required super.id, super.entryId, required super.turnId, required super.at, required this.text, this.requestId, required this.images});

  final String text;
  // The request that sent it, when a client did.
  final String? requestId;
  final List<ImageView> images;

  factory UserItem.fromJson(Json j) => UserItem(
        id: j['id'] as String,
        entryId: j['entryId'] as String?,
        turnId: j['turnId'] as String,
        at: _int(j['at'])!,
        text: j['text'] as String,
        requestId: j['requestId'] as String?,
        images: _list(j['images'], ImageView.fromJson)!,
      );

  @override
  Json toJson() => {
        ..._base('user'),
        'text': text,
        if (requestId != null) 'requestId': requestId,
        'images': images.map((i) => i.toJson()).toList(),
      };
}

class ImageView {
  const ImageView({required this.mimeType, this.key});

  final String mimeType;
  // Its key in the client's images; absent when it came without its data.
  final String? key;

  factory ImageView.fromJson(Json j) => ImageView(mimeType: j['mimeType'] as String, key: j['key'] as String?);

  Json toJson() => _json({'mimeType': mimeType, 'key': key});
}

class Block {
  const Block({required this.kind, required this.text});

  // "text" or "thinking".
  final String kind;
  final String text;

  factory Block.fromJson(Json j) => Block(kind: j['kind'] as String, text: j['text'] as String);

  Json toJson() => {'kind': kind, 'text': text};
}

class AssistantItem extends ChatItem {
  const AssistantItem({
    required super.id,
    super.entryId,
    required super.turnId,
    required super.at,
    required this.blocks,
    required this.streaming,
    this.stop,
    this.error,
    this.model,
    this.usage,
  });

  final List<Block> blocks;
  // Still being written.
  final bool streaming;
  // pi's stop reason: "stop", "length", "tool_use", "aborted", "error" or
  // "deferred".
  final String? stop;
  final String? error;
  final ModelView? model;
  final UsageView? usage;

  AssistantItem copyWith({List<Block>? blocks, bool? streaming}) => AssistantItem(
        id: id, entryId: entryId, turnId: turnId, at: at, blocks: blocks ?? this.blocks,
        streaming: streaming ?? this.streaming, stop: stop, error: error, model: model, usage: usage,
      );

  factory AssistantItem.fromJson(Json j) => AssistantItem(
        id: j['id'] as String,
        entryId: j['entryId'] as String?,
        turnId: j['turnId'] as String,
        at: _int(j['at'])!,
        blocks: _list(j['blocks'], Block.fromJson)!,
        streaming: j['streaming'] as bool,
        stop: j['stop'] as String?,
        error: j['error'] as String?,
        model: j['model'] == null ? null : ModelView.fromJson(j['model'] as Json),
        usage: j['usage'] == null ? null : UsageView.fromJson(j['usage'] as Json),
      );

  @override
  Json toJson() => {
        ..._base('assistant'),
        'blocks': blocks.map((b) => b.toJson()).toList(),
        'streaming': streaming,
        ..._json({'stop': stop, 'error': error, 'model': model?.toJson(), 'usage': usage?.toJson()}),
      };
}

class ToolResultView {
  const ToolResultView({required this.text, required this.isError, this.durationMs, this.exitCode, this.diff});

  final String text;
  final bool isError;
  final int? durationMs;
  final int? exitCode;
  final String? diff;

  factory ToolResultView.fromJson(Json j) => ToolResultView(
        text: j['text'] as String,
        isError: j['isError'] as bool,
        durationMs: _int(j['durationMs']),
        exitCode: _int(j['exitCode']),
        diff: j['diff'] as String?,
      );

  Json toJson() => _json({'text': text, 'isError': isError, 'durationMs': durationMs, 'exitCode': exitCode, 'diff': diff});
}

class ToolItem extends ChatItem {
  const ToolItem({required super.id, super.entryId, required super.turnId, required super.at, required this.name, required this.args, this.progress, this.result});

  final String name;
  // Its arguments, as JSON.
  final String args;
  // A running tool's output so far.
  final String? progress;
  final ToolResultView? result;

  ToolItem withProgress(String? progress) =>
      ToolItem(id: id, entryId: entryId, turnId: turnId, at: at, name: name, args: args, progress: progress, result: result);

  ToolItem withResult(ToolResultView result) =>
      ToolItem(id: id, entryId: entryId, turnId: turnId, at: at, name: name, args: args, result: result);

  factory ToolItem.fromJson(Json j) => ToolItem(
        id: j['id'] as String,
        entryId: j['entryId'] as String?,
        turnId: j['turnId'] as String,
        at: _int(j['at'])!,
        name: j['name'] as String,
        args: j['args'] as String,
        progress: j['progress'] as String?,
        result: j['result'] == null ? null : ToolResultView.fromJson(j['result'] as Json),
      );

  @override
  Json toJson() => {
        ..._base('tool'),
        'name': name,
        'args': args,
        ..._json({'progress': progress, 'result': result?.toJson()}),
      };
}

class CompactionItem extends ChatItem {
  const CompactionItem({required super.id, super.entryId, required super.turnId, required super.at, required this.summary, required this.tokensBefore});

  final String summary;
  final int tokensBefore;

  factory CompactionItem.fromJson(Json j) => CompactionItem(
        id: j['id'] as String,
        entryId: j['entryId'] as String?,
        turnId: j['turnId'] as String,
        at: _int(j['at'])!,
        summary: j['summary'] as String,
        tokensBefore: _int(j['tokensBefore'])!,
      );

  @override
  Json toJson() => {..._base('compaction'), 'summary': summary, 'tokensBefore': tokensBefore};
}

class BranchSummaryItem extends ChatItem {
  const BranchSummaryItem({required super.id, super.entryId, required super.turnId, required super.at, required this.summary});

  final String summary;

  factory BranchSummaryItem.fromJson(Json j) => BranchSummaryItem(
        id: j['id'] as String,
        entryId: j['entryId'] as String?,
        turnId: j['turnId'] as String,
        at: _int(j['at'])!,
        summary: j['summary'] as String,
      );

  @override
  Json toJson() => {..._base('branchSummary'), 'summary': summary};
}

class UsageView {
  const UsageView({required this.input, required this.output, required this.cacheRead, required this.cacheWrite, required this.cost});

  final int input;
  final int output;
  final int cacheRead;
  final int cacheWrite;
  final double cost;

  factory UsageView.fromJson(Json j) => UsageView(
        input: _int(j['input'])!,
        output: _int(j['output'])!,
        cacheRead: _int(j['cacheRead'])!,
        cacheWrite: _int(j['cacheWrite'])!,
        cost: (j['cost'] as num).toDouble(),
      );

  Json toJson() => {'input': input, 'output': output, 'cacheRead': cacheRead, 'cacheWrite': cacheWrite, 'cost': cost};
}

class ChatView {
  const ChatView({required this.items, required this.truncated, required this.loading});

  final List<ChatItem> items;
  // Older items were dropped.
  final bool truncated;
  // Its history is being fetched.
  final bool loading;

  ChatView copyWith({List<ChatItem>? items, bool? truncated, bool? loading}) =>
      ChatView(items: items ?? this.items, truncated: truncated ?? this.truncated, loading: loading ?? this.loading);

  factory ChatView.fromJson(Json j) =>
      ChatView(items: _list(j['items'], ChatItem.fromJson)!, truncated: j['truncated'] as bool, loading: j['loading'] as bool);

  Json toJson() => {'items': items.map((i) => i.toJson()).toList(), 'truncated': truncated, 'loading': loading};
}

class RelayView {
  const RelayView({required this.state, this.reason});

  // "connecting", "ready", "offline", "refused" or "stopped".
  final String state;
  final String? reason;

  factory RelayView.fromJson(Json j) => RelayView(state: j['state'] as String, reason: j['reason'] as String?);

  Json toJson() => _json({'state': state, 'reason': reason});
}

// A device registered with the relay: a host, or a client.
class DeviceView {
  const DeviceView({required this.key, required this.role, required this.label, required this.addedAt, required this.online, required this.self, required this.push});

  // Its public key, as the relay shows it (base64url).
  final String key;
  // "host" or "client".
  final String role;
  final String label;
  final int addedAt;
  final bool online;
  // This client's own.
  final bool self;
  // A client the relay wakes through the push gateway (RegisterPush).
  final bool push;

  factory DeviceView.fromJson(Json j) => DeviceView(
        key: j['key'] as String,
        role: j['role'] as String,
        label: j['label'] as String,
        addedAt: _int(j['addedAt'])!,
        online: j['online'] as bool,
        self: j['self'] as bool,
        push: j['push'] as bool,
      );

  Json toJson() => {'key': key, 'role': role, 'label': label, 'addedAt': addedAt, 'online': online, 'self': self, 'push': push};
}

// A host asking the relay to register its key, waiting for approval.
class PendingHostView {
  const PendingHostView({required this.key, required this.label, required this.software, required this.remote, required this.firstSeen});

  final String key;
  final String label;
  final String software;
  final String remote;
  final int firstSeen;

  factory PendingHostView.fromJson(Json j) => PendingHostView(
        key: j['key'] as String,
        label: j['label'] as String,
        software: j['software'] as String,
        remote: j['remote'] as String,
        firstSeen: _int(j['firstSeen'])!,
      );

  Json toJson() => {'key': key, 'label': label, 'software': software, 'remote': remote, 'firstSeen': firstSeen};
}

// A change, in the order it happened. Each kind's JSON has its "type".
sealed class ViewEvent {
  const ViewEvent();

  static ViewEvent fromJson(Json j) => switch (j['type']) {
        'relay' => RelayChanged(RelayView.fromJson(j['relay'] as Json)),
        'pendingHosts' => PendingHostsChanged(_list(j['hosts'], PendingHostView.fromJson)!),
        'devices' => DevicesChanged(_list(j['devices'], DeviceView.fromJson)!),
        'session' => SessionChanged(SessionView.fromJson(j['session'] as Json)),
        'sessionGone' => SessionGone(j['id'] as String),
        'chatReset' => ChatReset(j['id'] as String, ChatView.fromJson(j['chat'] as Json)),
        'chatItem' => ChatItemChanged(j['id'] as String, ChatItem.fromJson(j['item'] as Json)),
        'chatDelta' => ChatDelta(
            id: j['id'] as String,
            itemId: j['itemId'] as String,
            turnId: j['turnId'] as String,
            at: _int(j['at'])!,
            block: _int(j['block'])!,
            kind: j['kind'] as String,
            text: j['text'] as String,
          ),
        'toolProgress' => ToolProgressChanged(id: j['id'] as String, itemId: j['itemId'] as String, text: j['text'] as String),
        _ => throw FormatException('unknown event type ${j['type']}'),
      };

  Json toJson();
}

class RelayChanged extends ViewEvent {
  const RelayChanged(this.relay);
  final RelayView relay;
  @override
  Json toJson() => {'type': 'relay', 'relay': relay.toJson()};
}

// The hosts awaiting approval, all of them, oldest first.
class PendingHostsChanged extends ViewEvent {
  const PendingHostsChanged(this.hosts);
  final List<PendingHostView> hosts;
  @override
  Json toJson() => {'type': 'pendingHosts', 'hosts': hosts.map((h) => h.toJson()).toList()};
}

class DevicesChanged extends ViewEvent {
  const DevicesChanged(this.devices);
  final List<DeviceView> devices;
  @override
  Json toJson() => {'type': 'devices', 'devices': devices.map((d) => d.toJson()).toList()};
}

// A session appeared or changed; replaces what was known of it.
class SessionChanged extends ViewEvent {
  const SessionChanged(this.session);
  final SessionView session;
  @override
  Json toJson() => {'type': 'session', 'session': session.toJson()};
}

class SessionGone extends ViewEvent {
  const SessionGone(this.id);
  final String id;
  @override
  Json toJson() => {'type': 'sessionGone', 'id': id};
}

// The chat is replaced: from history, or emptied for a new session.
class ChatReset extends ViewEvent {
  const ChatReset(this.id, this.chat);
  final String id;
  final ChatView chat;
  @override
  Json toJson() => {'type': 'chatReset', 'id': id, 'chat': chat.toJson()};
}

// An item appeared or changed; replaces any with the same ID.
class ChatItemChanged extends ViewEvent {
  const ChatItemChanged(this.id, this.item);
  final String id;
  final ChatItem item;
  @override
  Json toJson() => {'type': 'chatItem', 'id': id, 'item': item.toJson()};
}

// Text appended to a block of an assistant item still being written, which
// is created if it is not there yet.
class ChatDelta extends ViewEvent {
  const ChatDelta({required this.id, required this.itemId, required this.turnId, required this.at, required this.block, required this.kind, required this.text});
  final String id;
  final String itemId;
  final String turnId;
  final int at;
  final int block;
  // "text" or "thinking".
  final String kind;
  final String text;
  @override
  Json toJson() => {'type': 'chatDelta', 'id': id, 'itemId': itemId, 'turnId': turnId, 'at': at, 'block': block, 'kind': kind, 'text': text};
}

// A running tool's output so far, replacing its earlier progress.
class ToolProgressChanged extends ViewEvent {
  const ToolProgressChanged({required this.id, required this.itemId, required this.text});
  final String id;
  final String itemId;
  final String text;
  @override
  Json toJson() => {'type': 'toolProgress', 'id': id, 'itemId': itemId, 'text': text};
}

class Snapshot {
  const Snapshot({required this.relay, required this.sessions, required this.pendingHosts, required this.devices});

  final RelayView relay;
  final List<SessionView> sessions;
  final List<PendingHostView> pendingHosts;
  final List<DeviceView> devices;

  Json toJson() => {
        'relay': relay.toJson(),
        'sessions': sessions.map((s) => s.toJson()).toList(),
        'pendingHosts': pendingHosts.map((h) => h.toJson()).toList(),
        'devices': devices.map((d) => d.toJson()).toList(),
      };
}

// The most items a chat keeps; older ones are dropped, as a history fetch
// drops them, so a session that runs for days does not grow without end.
const chatLimit = 1000;

ChatView _capped(ChatView chat, List<ChatItem> items) {
  if (items.length <= chatLimit) return chat.copyWith(items: items);
  return chat.copyWith(items: items.sublist(items.length - chatLimit), truncated: true);
}

// Applies an event to a chat.
ChatView applyToChat(ChatView chat, ViewEvent e) {
  switch (e) {
    case ChatReset(:final chat):
      return chat;
    case ChatItemChanged(:final item):
      final i = chat.items.indexWhere((x) => x.id == item.id);
      return _capped(chat, i < 0 ? [...chat.items, item] : [for (final (j, x) in chat.items.indexed) j == i ? item : x]);
    case ChatDelta():
      final i = chat.items.indexWhere((x) => x.id == e.itemId);
      final old = i >= 0 ? chat.items[i] : null;
      final base = old is AssistantItem ? old : AssistantItem(id: e.itemId, turnId: e.turnId, at: e.at, blocks: const [], streaming: true);
      final blocks = [...base.blocks];
      while (blocks.length <= e.block) {
        blocks.add(Block(kind: e.kind, text: ''));
      }
      blocks[e.block] = Block(kind: e.kind, text: blocks[e.block].text + e.text);
      final item = base.copyWith(blocks: blocks, streaming: true);
      return _capped(chat, i < 0 ? [...chat.items, item] : [for (final (j, x) in chat.items.indexed) j == i ? item : x]);
    case ToolProgressChanged():
      return chat.copyWith(items: [for (final x in chat.items) x.id == e.itemId && x is ToolItem ? x.withProgress(e.text) : x]);
    default:
      return chat;
  }
}

const _lastChars = 160;
final _lineMark = RegExp(r'^\s*(#+|>|[-*]|\d+\.)\s+');
final _inlineMark = RegExp(r'\*\*|__|`');

// The latest message in a chat, the user's or a finished reply, as the
// session list shows it: its first line with text in it, without
// markdown's commonest marks, cut short.
LastView? lastOf(List<ChatItem> items) {
  for (var i = items.length - 1; i >= 0; i--) {
    final x = items[i];
    String? text;
    if (x is UserItem) {
      // A message of images alone says so.
      text = x.text.trim().isNotEmpty || x.images.isEmpty
          ? x.text
          : x.images.length > 1
              ? '${x.images.length} images'
              : 'An image';
    } else if (x is AssistantItem && !x.streaming) {
      final texts = x.blocks.where((b) => b.kind == 'text' && b.text.trim().isNotEmpty);
      text = texts.isNotEmpty
          ? texts.last.text
          : x.stop == 'error'
              ? '⚠ ${(x.error ?? '').isNotEmpty ? x.error : 'the model failed'}'
              : x.stop == 'aborted'
                  ? 'Stopped.'
                  : null;
    }
    if (text == null) continue;
    final line = text
        .split('\n')
        .firstWhere((l) => l.trim().isNotEmpty, orElse: () => '')
        .replaceFirst(_lineMark, '')
        .replaceAll(_inlineMark, '')
        .trim();
    return LastView(
      who: x is UserItem ? 'user' : 'assistant',
      text: line.length > _lastChars ? '${line.substring(0, _lastChars - 1)}…' : line,
      at: x.at,
    );
  }
  return null;
}
