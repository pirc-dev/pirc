// The order of sessions in the list, and the next one waiting. A port of
// web/core/order.ts.
import 'view.dart';

// When each working session's turn started, as this client saw it: the
// user's message that started it (or a later one, steering it), else its
// latest message when first seen working.
class Starts {
  var _starts = <String, int>{};

  // Called with every list of sessions; returns the working ones' starts.
  Map<String, int> update(List<SessionView> sessions) {
    final next = <String, int>{};
    for (final s in sessions) {
      final last = s.last;
      if (!(s.working || s.compacting) || last == null) continue;
      final before = _starts[s.id];
      next[s.id] = before == null
          ? last.at
          : last.who == 'user'
              ? (before > last.at ? before : last.at)
              : before;
    }
    _starts = next;
    return next;
  }
}

// Sessions equal in time by window, then title in Dart's own order, which
// may differ from a browser's collation for titles equal in all else.
int byWindow(SessionView a, SessionView b, String Function(SessionView) title) {
  final wa = a.place?.windowNumber;
  final wb = b.place?.windowNumber;
  if (wa != wb) {
    if (wa == null) return 1;
    if (wb == null) return -1;
    return wa - wb;
  }
  return title(a).compareTo(title(b));
}

int Function(SessionView, SessionView) compare(Map<String, int> starts, String Function(SessionView) title) {
  int at(SessionView s) => starts[s.id] ?? s.last?.at ?? s.startedAt ?? 0;
  return (a, b) {
    final d = at(b) - at(a);
    return d != 0 ? d : byWindow(a, b, title);
  };
}

// The session to open next: after the one open, round to the first. Those
// asking a question come first, then those finished since last open, each
// in the list's order.
SessionView? nextWaiting(List<SessionView> sessions, Set<String> news, int Function(SessionView, SessionView) order, [String? open]) {
  bool asking(SessionView s) => (s.questions ?? const []).isNotEmpty;
  final waiting = [
    ...sessions.where(asking).toList()..sort(order),
    ...sessions.where((s) => !asking(s) && news.contains(s.id)).toList()..sort(order),
  ];
  if (waiting.isEmpty) return null;
  final at = waiting.indexWhere((s) => s.id == open);
  return waiting[(at + 1) % waiting.length];
}
