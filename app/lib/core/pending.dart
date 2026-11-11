// Messages sent from this client that pi has not yet shown in the chat. A
// port of web/core/pending.ts; images are the app's own kind (I).
import 'view.dart';

class Pending<I> {
  const Pending({
    required this.key,
    required this.requestId,
    required this.text,
    this.images,
    this.delivery,
    required this.state,
    this.error,
    this.unsure = false,
    required this.before,
  });

  final int key;
  // Made when it is first sent and sent again with a retry; pi's copy
  // carries it.
  final String requestId;
  final String text;
  final List<I>? images;
  // "steer" or "followUp".
  final String? delivery;
  // "sending", "sent", "queued", "failed" or "lost".
  final String state;
  final String? error;
  // Failed with no answer: pi may have it after all.
  final bool unsure;
  // The user messages in the chat when it was sent.
  final Set<String> before;

  Pending<I> copyWith({String? state, String? error, bool? unsure}) => Pending(
        key: key, requestId: requestId, text: text, images: images, delivery: delivery,
        state: state ?? this.state, error: error ?? this.error, unsure: unsure ?? this.unsure, before: before,
      );
}

Set<String> userIds(List<ChatItem> items) => {for (final x in items) if (x is UserItem) x.id};

// Drops the pending messages that pi's user messages now show, each
// claiming one: the one with its request ID, else, for a copy without one,
// the same text, then one it starts with. Returns the same list when
// nothing goes.
List<Pending<I>> settle<I>(List<Pending<I>> pending, List<ChatItem> items) {
  final claimed = <String>{};
  final gone = <int>{};
  for (final how in const ['id', 'text', 'prefix']) {
    for (final p in pending) {
      if (gone.contains(p.key) || (p.state == 'failed' && !p.unsure)) continue;
      final echo = items.whereType<UserItem>().where((x) =>
          !p.before.contains(x.id) &&
          !claimed.contains(x.id) &&
          (how == 'id'
              ? x.requestId == p.requestId
              : x.requestId == null && (how == 'text' ? x.text == p.text : p.text.isNotEmpty && x.text.startsWith(p.text))));
      if (echo.isEmpty) continue;
      claimed.add(echo.first.id);
      gone.add(p.key);
    }
  }
  return gone.isEmpty ? pending : pending.where((p) => !gone.contains(p.key)).toList();
}

// pi's answer to a sent message: refused, or no answer at all (unsure). A
// "/" command gets no copy in the chat; anything else waits for its copy.
Pending<I>? answered<I>(Pending<I> p, bool ok, [String? error, bool unsure = false]) {
  if (!ok) return p.copyWith(state: 'failed', error: error, unsure: unsure ? true : null);
  if (p.text.startsWith('/')) return null;
  return p.copyWith(state: p.delivery != null ? 'queued' : 'sent');
}

// Whether the end of the chat should say that pi is working: nothing there
// is moving already, a reply being written or a tool of the current turn
// running.
bool quiet(List<ChatItem> items) {
  if (items.isEmpty) return true;
  final last = items.last;
  if (last is AssistantItem && last.streaming) return false;
  for (var i = items.length - 1; i >= 0 && items[i].turnId == last.turnId; i--) {
    final x = items[i];
    if (x is ToolItem && x.result == null) return false;
  }
  return true;
}
