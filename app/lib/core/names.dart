// What a session is called and where it runs. A port of web/core/names.ts.
import 'view.dart';

String folder(String cwd) {
  final parts = cwd.split('/').where((p) => p.isNotEmpty);
  return parts.isNotEmpty ? parts.last : (cwd.isNotEmpty ? cwd : 'pi');
}

// A session is called by pi's name for it, else by its first message, as
// pi's own list does, else by its folder.
String title(SessionView s) {
  final name = s.name.trim();
  if (name.isNotEmpty) return name;
  if ((s.first ?? '').isNotEmpty) return s.first!;
  return folder(s.cwd);
}

// The window or tab it runs in, as the terminal names it; null when not
// known.
String? windowOf(SessionView s) {
  final display = s.place?.display ?? '';
  if (display.isNotEmpty) return display;
  final window = s.place?.window ?? '';
  return window.isNotEmpty ? window : null;
}

// What the title leaves out: the folder, the model.
String details(SessionView s) {
  final model = s.model == null ? '' : (s.model!.name.isNotEmpty ? s.model!.name : s.model!.id);
  return [s.cwd, model].where((x) => x.isNotEmpty).join(' · ');
}

// Where it runs, host first: "LC › work › api", or the display string an
// extension gave in place of the names.
String where(SessionView s) {
  final p = s.place;
  final place = (p?.display ?? '').isNotEmpty ? [p!.display] : [p?.group, p?.window];
  final host = s.hostLabel.isNotEmpty ? s.hostLabel : s.hostname;
  return [host, ...place].whereType<String>().where((x) => x.isNotEmpty).join(' › ');
}

// How long ago, shortly: "now", "5m", "3h", then the date as the app writes
// it in the reader's language: day(at, true) its weekday, day(at, false)
// its day and month. A host's clock ahead of this one's counts as now.
String ago(int at, int now, String Function(int at, bool weekday) day) {
  final m = ((now - at) / 60000).floor();
  if (m < 1) return 'now';
  if (m < 60) return '${m}m';
  if (m < 24 * 60) return '${(m / 60).floor()}h';
  return day(at, m < 6 * 24 * 60);
}
