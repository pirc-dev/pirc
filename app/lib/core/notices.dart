// Notifications, written from the latest notice the host put in a
// session's announcement. A port of web/core/notices.ts; the iOS
// notification extension's Swift does the same, held to the same cases.
import 'names.dart';
import 'view.dart';

class Notification {
  const Notification(this.title, this.body);
  final String title;
  final String body;

  Map<String, Object?> toJson() => {'title': title, 'body': body};
}

// Cut to n Unicode code points, "…" included, as the host cuts a notice.
String cut(String s, int n) {
  final points = s.runes.toList();
  return points.length > n ? '${String.fromCharCodes(points.sublist(0, n - 1)).trimRight()}…' : s;
}

// The session's title and host, and what its notice says; null when it has
// no notice. The text is the host's, already cut.
Notification? notification(SessionView s) {
  final n = s.notice;
  if (n == null) return null;
  final body = switch (n.kind) {
    'failed' => 'Failed: ${n.text.isNotEmpty ? n.text : 'pi gave no reason'}',
    'question' => 'Asks: ${n.text.isNotEmpty ? n.text : "a question in pi's terminal"}',
    _ => n.text.isNotEmpty ? n.text : 'Finished',
  };
  final host = s.hostLabel.isNotEmpty ? s.hostLabel : s.hostname;
  return Notification(cut([title(s), host].where((x) => x.isNotEmpty).join(' · '), 80), body);
}

// The sessions whose notice is past the last shown for them, and the
// numbers shown once they are. A session seen for the first time is not
// news, unless since is given and its notice is later; one no longer
// listed is forgotten.
({List<SessionView> notify, Map<String, int> shown}) news(Map<String, int> shown, List<SessionView> sessions, [int? since]) {
  final notify = <SessionView>[];
  final next = <String, int>{};
  for (final s in sessions) {
    final number = s.notice?.number ?? 0;
    final last = shown[s.id] ?? since ?? number;
    if (number > last) notify.add(s);
    final had = shown[s.id] ?? 0;
    next[s.id] = number > had ? number : had;
  }
  return (notify: notify, shown: next);
}
