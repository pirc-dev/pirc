// What the screens show and do: the client logic's sessions and chats, the
// messages sent and not yet shown, and the requests the core version makes
// (prompt, stop, pi's questions). The relay connection feeds it frames and
// states; the screens listen to it.
import 'package:flutter/foundation.dart';

import '../core/client.dart';
import '../core/images.dart';
import '../core/names.dart';
import '../core/order.dart';
import '../core/pending.dart';
import '../core/protocol.dart';
import '../core/results.dart';
import '../core/view.dart';
import 'chat_cache.dart';

// A prompt to an idle pi is answered once its run starts, which a question
// shown first holds up until the person answers (web/server/app.ts).
const askingMaxMs = 30 * 60 * 1000;

class PircModel extends ChangeNotifier {
  // publicKey: this phone's, so that the relay's list of keys marks its own.
  PircModel({required bool Function(Frame) send, String Function()? newId, Clock? clock, this.now = _now, this.cache, List<int>? publicKey}) {
    client = Client(send: send, onEvent: _onEvent, newId: newId, clock: clock, publicKey: publicKey);
    cache?.prune(now());
  }

  static int _now() => DateTime.now().millisecondsSinceEpoch;

  late final Client client;
  // The chats opened lately, seeded into the client (restore) and kept as
  // they change.
  final ChatCache? cache;
  // When each chat was opened, for those kept.
  final _openedAt = <String, int>{};
  // The sessions whose kept thumbnails were looked for, by pi's session ID.
  final _thumbsSought = <String>{};
  // Milliseconds since the epoch; a test's clock in tests.
  final int Function() now;
  final _starts = Starts();
  var _turnStarts = <String, int>{};
  final _pending = <String, List<Pending<StoredImage>>>{};
  // Sessions finished since the reader last opened them.
  final news = <String>{};
  var _nextKey = 0;

  RelayView get relay => client.snapshot().relay;

  // The sessions in the list's order: the most recent first.
  List<SessionView> get sessions {
    final list = client.snapshot().sessions;
    final starts = _turnStarts = _starts.update(list);
    return list..sort(compare(starts, title));
  }

  SessionView? session(String id) => client.snapshot().sessions.where((s) => s.id == id).firstOrNull;

  // The hosts asking to join, oldest first, for any client to approve or
  // reject (docs/design.md, 5.3).
  List<PendingHostView> get pendingHosts => client.snapshot().pendingHosts;

  ChatView? chat(String id) => client.chat(id);

  // Seeds the client with the chats kept on the phone, before connecting,
  // so that each shows at once and only what is new is fetched.
  Future<void> restore() async {
    final kept = await cache?.loadAll() ?? const {};
    for (final MapEntry(key: sessionId, value: chat) in kept.entries) {
      client.seed(sessionId, chat);
    }
  }

  // When a working session's turn started, by the host's clock, as the list
  // last saw it.
  int? turnStart(String id) {
    sessions;
    return _turnStarts[id];
  }

  List<Pending<StoredImage>> pending(String id) => _pending[id] ?? const [];

  void _onEvent(ViewEvent e) {
    switch (e) {
      case SessionChanged(:final session):
        final was = _working[session.id];
        _working[session.id] = session.working;
        if (was == true && !session.working) news.add(session.id);
        _settle(session.id);
      case ChatReset(:final id) || ChatItemChanged(:final id):
        _settle(id);
        _keep(id);
      case SessionGone(:final id):
        _openedAt.remove(id);
        _pending.remove(id);
        news.remove(id);
        _working.remove(id);
      default:
    }
    notifyListeners();
  }

  final _working = <String, bool>{};

  void _settle(String id) {
    final ps = _pending[id];
    final items = client.chat(id)?.items;
    if (ps == null || items == null) return;
    final next = settle(ps, items);
    if (!identical(next, ps)) _pending[id] = next;
  }

  // The reader opened the chat: it is no longer news, and it is kept; the
  // thumbnails kept with it shown, for the images the relay sends no more.
  void opened(String id) {
    _openedAt[id] = now();
    _keep(id);
    if (news.remove(id)) notifyListeners();
    final s = session(id);
    if (cache != null && s != null && _thumbsSought.add(s.sessionId)) {
      cache!.images(s.sessionId).then((thumbs) {
        if (thumbs.isEmpty) {
          // None, or not readable now (the phone locked): sought again.
          _thumbsSought.remove(s.sessionId);
          return;
        }
        for (final MapEntry(:key, :value) in thumbs.entries) {
          client.seedImage(key, value);
        }
        notifyListeners();
      });
    }
  }

  // Keeps an opened chat once its history has come.
  void _keep(String id) {
    final at = _openedAt[id];
    final live = client.chat(id);
    final s = session(id);
    if (cache == null || at == null || live == null || live.loading || s == null) return;
    cache!.save(s.sessionId, live, at, image: client.image);
  }

  // --- Requests -----------------------------------------------------------

  // Sends a message; it shows until pi's copy of it does. delivery is
  // "steer" or "followUp" while pi works.
  // Sends a message, with images (each within pi's limits, attach.dart).
  Future<Outcome> prompt(String id, String text, {List<StoredImage> images = const [], String? delivery, int? retryKey}) async {
    final items = client.chat(id)?.items ?? const [];
    final key = retryKey ?? _nextKey++;
    final requestId = client.id();
    final sent = Pending<StoredImage>(key: key, requestId: requestId, text: text, images: images.isEmpty ? null : images, delivery: delivery, state: 'sending', before: userIds(items));
    _pending[id] = [...pending(id).where((p) => p.key != key), sent];
    notifyListeners();
    final asked = now();
    final m = SessionMessage(
      prompt: Prompt(
        requestId: requestId,
        text: text,
        images: [for (final i in images) Image(mimeType: i.mimeType, data: i.data)],
        delivery: delivery == 'steer'
            ? Delivery.DELIVERY_STEER
            : delivery == 'followUp'
                ? Delivery.DELIVERY_FOLLOW_UP
                : Delivery.DELIVERY_UNSPECIFIED,
      ),
    );
    final reply = await client.ask(id, m, () => client.compacting(id) || (client.asking(id) && now() - asked < askingMaxMs));
    final o = outcome(reply);
    _pending[id] = [
      for (final p in pending(id))
        if (p.key != key) p else ?answered(p, o.ok, o.message, !o.ok && o.code == 'TIMEOUT'),
    ];
    _settle(id);
    notifyListeners();
    return o;
  }

  // Sends a failed message again, in its place.
  Future<Outcome> retry(String id, Pending<StoredImage> p) => prompt(id, p.text, images: p.images ?? const [], delivery: p.delivery, retryKey: p.key);

  void dismiss(String id, Pending<StoredImage> p) {
    _pending[id] = [for (final x in pending(id)) if (x.key != p.key) x];
    notifyListeners();
  }

  // One of the session's actions (the web page's, web/server/app.ts's
  // COMMANDS): the request, made with a fresh request ID, answered. A
  // compaction, which takes minutes, is waited for while the session says
  // it compacts, up to 15 minutes.
  Future<Outcome> act(String id, SessionMessage Function(String requestId) request, {bool compacts = false}) async {
    final until = now() + 15 * 60 * 1000;
    return outcome(await client.ask(id, request(client.id()), compacts ? () => client.compacting(id) && now() < until : null));
  }

  // Stops pi's turn, as Esc in its terminal.
  Future<Outcome> stop(String id) async => outcome(await client.ask(id, SessionMessage(abort: Abort(requestId: client.id()))));

  // Answers one of the session's questions: an option's index for a select,
  // yes or no for a confirm, text for an input, or dismissed for any.
  Future<Outcome> answer(String id, String questionId, {int? option, bool? confirmed, String? text, bool dismissed = false}) async {
    final a = Answer(requestId: client.id(), questionId: questionId);
    if (option != null) {
      a.option = option;
    } else if (confirmed != null) {
      a.confirmed = confirmed;
    } else if (text != null) {
      a.text = text;
    } else {
      a.dismissed = dismissed;
    }
    return outcome(await client.ask(id, SessionMessage(answer: a)));
  }
}
