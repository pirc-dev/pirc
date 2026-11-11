// The Native look (docs/web.md, section 5): the system's grouped grey with
// white cards, a round tinted badge for each status, one blue, and the
// system's own font. Its colours are the web page's Native look's
// (web/page/src/index.css, :root[data-look="native"]), token for token, so
// that the two read as one product; every colour the screens use is here,
// so that another look is a second Look, not a rewrite.
import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';

import '../core/view.dart';

class Look {
  const Look({
    required this.page,
    required this.card,
    required this.sheetCard,
    required this.sheet,
    required this.scrim,
    required this.wash,
    required this.wash2,
    required this.rule,
    required this.ink,
    required this.ink2,
    required this.ink3,
    required this.accent,
    required this.onAccent,
    required this.accentSoft,
    required this.block,
    required this.done,
    required this.work,
    required this.idle,
    required this.blockWash,
    required this.doneWash,
    required this.workWash,
    required this.idleWash,
    this.fontFamily,
    this.monoFamily,
  });

  // The page behind the cards, a card, and a card on a sheet.
  final Color page;
  final Color card;
  final Color sheetCard;
  // A sheet over the page, and the shade behind it.
  final Color sheet;
  final Color scrim;
  // A grey fill (a search field, a pill), and a stronger one.
  final Color wash;
  final Color wash2;
  // A hairline.
  final Color rule;
  // Text, from strongest to faintest.
  final Color ink;
  final Color ink2;
  final Color ink3;
  final Color accent;
  final Color onAccent;
  final Color accentSoft;
  // The statuses, as herdr's: blocked (pi asks), done (finished since last
  // opened), working, idle; and each one's tint, for a badge or a pill.
  final Color block;
  final Color done;
  final Color work;
  final Color idle;
  final Color blockWash;
  final Color doneWash;
  final Color workWash;
  final Color idleWash;
  // Null: the system's (San Francisco, Roboto). Tests name one they load.
  final String? fontFamily;
  // For code and tool output; null: the system's monospace (Menlo on
  // Apple's, monospace on Android).
  final String? monoFamily;

  // What the screens called these before the web's tokens.
  Color get secondary => ink2;
  Color get separator => rule;
  Color get toolCard => wash;
  Color get working => work;
  Color get asking => block;
  Color get failed => block;

  static const light = Look(
    page: Color(0xFFF2F2F7),
    card: Color(0xFFFFFFFF),
    sheetCard: Color(0xFFFFFFFF),
    sheet: Color(0xFFF2F2F7),
    scrim: Color(0x520A0A14),
    wash: Color(0x1F767680),
    wash2: Color(0x33767680),
    rule: Color(0x2B3C3C43),
    ink: Color(0xFF121216),
    ink2: Color(0xFF62626C),
    ink3: Color(0xFF8A8A94),
    accent: Color(0xFF1F62E0),
    onAccent: Color(0xFFFFFFFF),
    accentSoft: Color(0x1F1F62E0),
    block: Color(0xFFC2261D),
    done: Color(0xFF0D6B63),
    work: Color(0xFF9C4806),
    idle: Color(0xFF13702F),
    blockWash: Color(0x1CC2261D),
    doneWash: Color(0x1F0F766E),
    workWash: Color(0x1FB45309),
    idleWash: Color(0x1A15803D),
  );

  static const dark = Look(
    page: Color(0xFF000000),
    card: Color(0xFF1C1C1E),
    sheetCard: Color(0xFF2C2C2E),
    sheet: Color(0xFF1C1C1E),
    scrim: Color(0x8C000000),
    wash: Color(0x3D767680),
    wash2: Color(0x57767680),
    rule: Color(0x8C545458),
    ink: Color(0xFFF5F5F7),
    ink2: Color(0xFFA4A4AD),
    ink3: Color(0xFF7C7C85),
    accent: Color(0xFF5E9BFF),
    onAccent: Color(0xFF06122B),
    accentSoft: Color(0x2E5E9BFF),
    block: Color(0xFFFCA5A5),
    done: Color(0xFF5EEAD4),
    work: Color(0xFFFCD34D),
    idle: Color(0xFF86EFAC),
    blockWash: Color(0x26FCA5A5),
    doneWash: Color(0x245EEAD4),
    workWash: Color(0x24FCD34D),
    idleWash: Color(0x1F86EFAC),
  );

  Look withFont(String? family, {String? mono}) => Look(
        page: page, card: card, sheetCard: sheetCard, sheet: sheet, scrim: scrim, wash: wash, wash2: wash2, rule: rule,
        ink: ink, ink2: ink2, ink3: ink3, accent: accent, onAccent: onAccent, accentSoft: accentSoft,
        block: block, done: done, work: work, idle: idle,
        blockWash: blockWash, doneWash: doneWash, workWash: workWash, idleWash: idleWash,
        fontFamily: family, monoFamily: mono,
      );

  TextStyle text({double size = 17, FontWeight weight = FontWeight.w400, Color? color, double? height, double? spacing, FontStyle? style}) =>
      TextStyle(fontFamily: fontFamily, fontSize: size, fontWeight: weight, color: color ?? ink, height: height, letterSpacing: spacing ?? -0.2, fontStyle: style);

  TextStyle mono({double size = 13, Color? color, FontWeight weight = FontWeight.w400}) => TextStyle(
        fontFamily: monoFamily ?? (defaultTargetPlatform == TargetPlatform.iOS || defaultTargetPlatform == TargetPlatform.macOS ? 'Menlo' : 'monospace'),
        fontSize: size,
        fontWeight: weight,
        color: color ?? ink,
        height: 1.3,
      );

  static Look of(BuildContext context) => LookScope.of(context);
}

class LookScope extends InheritedWidget {
  const LookScope({super.key, required this.look, required super.child});
  final Look look;

  static Look of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<LookScope>()!.look;

  @override
  bool updateShouldNotify(LookScope old) => old.look != look;
}

// What a session's badge says.
enum Status { asking, working, done, idle }

Status statusOf(SessionView s, Set<String> news) {
  if ((s.questions ?? const []).isNotEmpty) return Status.asking;
  if (s.working || s.compacting) return Status.working;
  if (news.contains(s.id)) return Status.done;
  return Status.idle;
}

// A status's colour, its tint, its symbol and what it says, as the web
// page's Status: × asks, ◐ working, ✓ done, ○ idle.
(Color, Color, String, String) statusLook(Look look, Status status, {bool compacting = false}) => switch (status) {
      Status.asking => (look.block, look.blockWash, '×', 'Asks a question'),
      Status.working => (look.work, look.workWash, '◐', compacting ? 'Compacting' : 'Working'),
      Status.done => (look.done, look.doneWash, '✓', 'Finished since last opened'),
      Status.idle => (look.idle, look.idleWash, '○', 'Idle'),
    };

// The round tinted badge with the status's symbol, where a messaging app
// puts a face. The symbols are drawn, not set in a font, since not every
// phone's fonts have them.
class StatusBadge extends StatelessWidget {
  const StatusBadge(this.status, {super.key, this.size = 32, this.compacting = false});
  final Status status;
  final double size;
  final bool compacting;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final (color, wash, _, label) = statusLook(look, status, compacting: compacting);
    return Semantics(
      label: label,
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(color: wash, shape: BoxShape.circle),
        child: CustomPaint(painter: _Symbol(status, color)),
      ),
    );
  }
}

// A status's symbol alone, in its colour, size points high.
class StatusGlyph extends StatelessWidget {
  const StatusGlyph(this.status, {super.key, this.size = 16});
  final Status status;
  final double size;

  @override
  Widget build(BuildContext context) {
    final (color, _, _, label) = statusLook(Look.of(context), status);
    // The badge's symbol fills 38% of it: drawn in a box that large.
    return Semantics(
      label: label,
      child: SizedBox.square(
        dimension: size,
        child: OverflowBox(maxWidth: size / 0.38, maxHeight: size / 0.38, child: CustomPaint(size: Size.square(size / 0.38), painter: _Symbol(status, color))),
      ),
    );
  }
}

// × asks, ◐ working, ✓ done, ○ idle, in a box a third of the badge's size.
class _Symbol extends CustomPainter {
  _Symbol(this.status, this.color);
  final Status status;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final r = size.shortestSide * 0.19;
    final line = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = size.shortestSide * 0.06
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    switch (status) {
      case Status.asking:
        canvas.drawLine(c + Offset(-r, -r) * 0.8, c + Offset(r, r) * 0.8, line);
        canvas.drawLine(c + Offset(r, -r) * 0.8, c + Offset(-r, r) * 0.8, line);
      case Status.working:
        canvas.drawCircle(c, r, line);
        canvas.drawArc(Rect.fromCircle(center: c, radius: r), -1.5708, 3.1416, true, Paint()..color = color);
      case Status.done:
        canvas.drawPath(
          Path()
            ..moveTo(c.dx - r, c.dy)
            ..lineTo(c.dx - r * 0.3, c.dy + r * 0.7)
            ..lineTo(c.dx + r, c.dy - r * 0.75),
          line,
        );
      case Status.idle:
        canvas.drawCircle(c, r, line);
    }
  }

  @override
  bool shouldRepaint(_Symbol old) => old.status != status || old.color != color;
}

// A count on a tinted pill, as the web page's: "2 working".
class Pill extends StatelessWidget {
  const Pill({super.key, required this.count, required this.word, required this.color, required this.wash, this.big = false});
  final int count;
  final String word;
  final Color color;
  final Color wash;
  // The list's own counts, under its title; else a host's or group's.
  final bool big;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Container(
      height: big ? 26 : null,
      padding: big ? const EdgeInsets.symmetric(horizontal: 10) : const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(color: wash, borderRadius: BorderRadius.circular(13)),
      child: Align(widthFactor: 1, child: Text.rich(
        TextSpan(children: [
          TextSpan(text: '$count', style: big ? look.mono(size: 13, color: color, weight: FontWeight.w600) : look.text(size: 12, color: color, weight: FontWeight.w600, spacing: 0)),
          TextSpan(text: ' $word', style: look.text(size: big ? 13 : 12, color: color, weight: big ? FontWeight.w400 : FontWeight.w600, spacing: 0)),
        ]),
      )),
    );
  }
}

// Text with the characters a search matched marked, as the web page's
// Native look marks them (Marked.tsx): in the accent, heavier, on its tint.
// Positions index the searched text, of which this starts at offset.
Widget marked(Look look, String text, int offset, Set<int>? positions, TextStyle style) => positions == null || positions.isEmpty
    ? Text(text, style: style, maxLines: 1, overflow: TextOverflow.ellipsis)
    : Text.rich(markedSpan(look, text, offset, positions, style), maxLines: 1, overflow: TextOverflow.ellipsis);

InlineSpan markedSpan(Look look, String text, int offset, Set<int> positions, TextStyle style) {
  final hit = style.copyWith(fontWeight: FontWeight.w600, color: look.accent, backgroundColor: look.accentSoft);
  // Runs of matched and unmatched characters, each one span.
  final runs = <TextSpan>[];
  var start = 0;
  for (var i = 1; i <= text.length; i++) {
    if (i == text.length || positions.contains(offset + i) != positions.contains(offset + start)) {
      runs.add(TextSpan(text: text.substring(start, i), style: positions.contains(offset + start) ? hit : style));
      start = i;
    }
  }
  return TextSpan(children: runs);
}
