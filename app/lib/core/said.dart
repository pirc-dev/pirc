// What a screen reader is told of an open chat as it changes: pi's reply
// when a turn ends, that it failed, or what it asks, by the session's
// latest notice; an extension's warning or error; a message not sent. Only
// what happens while the chat is open: not what it showed when it opened,
// nor earlier items loaded later. A port of web/page/src/said.ts.
import 'notices.dart';
import 'pending.dart';
import 'view.dart';

class Heard {
  const Heard({required this.notice, required this.last, required this.failed});
  // The session's latest notice, by number; 0 for none.
  final int notice;
  // The last item, by ID: those after it are new.
  final String? last;
  // Messages from here that failed to send, by key.
  final Set<int> failed;
}

typedef Saying = ({String text, bool urgent});

({Heard heard, List<Saying> say}) said(Heard? was, SessionView? s, List<ChatItem> items, List<Pending<Object?>> pending) {
  final failed = {for (final x in pending) if (x.state == 'failed' || x.state == 'lost') x.key};
  final heard = Heard(notice: s?.notice?.number ?? 0, last: items.lastOrNull?.id ?? was?.last, failed: failed);
  if (was == null) return (heard: heard, say: const []);
  final say = <Saying>[];
  final n = s?.notice;
  if (n != null && n.number > was.notice) {
    say.add(switch (n.kind) {
      'failed' => (text: 'pi failed: ${n.text.isNotEmpty ? n.text : 'it gave no reason'}', urgent: true),
      'question' => (text: 'pi asks: ${n.text.isNotEmpty ? n.text : 'a question in its terminal'}', urgent: false),
      _ => (text: n.text.isNotEmpty ? 'pi: ${n.text}' : 'pi finished', urgent: false),
    });
  }
  final from = was.last == null ? -1 : items.indexWhere((x) => x.id == was.last);
  if (from >= 0 || was.last == null) {
    for (final it in items.skip(from + 1)) {
      if (it is NotificationItem && it.level != 'info') {
        say.add((text: '${it.level == 'error' ? 'Error' : 'Warning'}: ${cut(it.text, 200)}', urgent: it.level == 'error'));
      }
    }
  }
  for (final x in pending) {
    if (!failed.contains(x.key) || was.failed.contains(x.key)) continue;
    say.add((text: x.state == 'lost' ? 'Not sent: pi stopped first' : 'Not sent: ${x.error?.isNotEmpty == true ? x.error : 'no answer'}', urgent: true));
  }
  return (heard: heard, say: say);
}
