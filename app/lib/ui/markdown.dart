// Replies as Markdown, as the web page's Native look sets them
// (web/page/src/Markdown.tsx, index.css's .prose-chat): GitHub's flavour,
// parsed by package:markdown and drawn here; code blocks with their
// language, their file when the reply names one (fence.ts), and Copy;
// highlighted when they name their language (highlight.dart); tables that
// scroll sideways under their first column, and open full screen; links
// opened in the phone's browser. While a reply
// streams, a thin cursor follows its last word, or waits under the code
// block or table it ends with (index.css's .cursor).
import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';

import 'highlight.dart';
import 'look.dart';
import 'selectable.dart';

// Something that reads as a file: with a folder, or a name and an
// extension ("sync.sh"), not a version or a number ("1.2").
final _path = RegExp(r'''^(?:[^\s"'=]*/[^\s"'=]+|[\w-]*[A-Za-z][\w-]*\.[A-Za-z]\w{0,7})$''');

// A code block's language and file, from what follows its opening fence:
// ```ts src/a.ts, ```ts title="src/a.ts" (or file=, filename=),
// ```ts:src/a.ts, or ```src/a.ts, whose language is then its extension.
({String? lang, String? file}) fence(String? lang, String? meta) {
  var l = lang;
  String? file;
  final colon = l?.indexOf(':') ?? -1;
  if (l != null && colon > 0 && _path.hasMatch(l.substring(colon + 1))) {
    file = l.substring(colon + 1);
    l = l.substring(0, colon);
  } else if (l != null && _path.hasMatch(l)) {
    file = l;
    l = RegExp(r'\.([A-Za-z]\w*)$').firstMatch(l)?.group(1)?.toLowerCase();
  }
  if (file == null && meta != null && meta.trim().isNotEmpty) {
    final named = RegExp(r'''(?:^|\s)(?:title|file|filename)=(?:"([^"]+)"|'([^']+)'|(\S+))''').firstMatch(meta);
    final first = meta.trim().split(RegExp(r'\s+')).first;
    file = named != null
        ? (named.group(1) ?? named.group(2) ?? named.group(3))
        : _path.hasMatch(first) && !first.startsWith('//') && !first.contains('://')
            ? first
            : null;
  }
  return (lang: l, file: file);
}

class Markdown extends StatelessWidget {
  const Markdown(this.text, {super.key, this.writing = false});
  final String text;
  // Still streaming: the cursor at its end.
  final bool writing;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final nodes = md.Document(extensionSet: md.ExtensionSet.gitHubFlavored, encodeHtml: false).parse(text);
    return _Blocks(look, nodes, writing: writing);
  }
}

// Blocks one under another, 0.6em apart, as Native's prose.
class _Blocks extends StatelessWidget {
  const _Blocks(this.look, this.nodes, {this.color, this.writing = false});
  final Look look;
  final List<md.Node> nodes;
  final Color? color;
  // The cursor after the last block: in its last line, or under it.
  final bool writing;

  @override
  Widget build(BuildContext context) {
    final shown = nodes.where((n) => n is md.Element || (n is md.Text && n.text.trim().isNotEmpty)).toList();
    final blocks = [for (final n in shown) ?_block(context, n, writing && identical(n, shown.last))];
    final under = writing && (shown.isEmpty || !_inline(shown.last));
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 10, children: [
      ...blocks,
      if (under) const Align(alignment: Alignment.centerLeft, child: Cursor()),
    ]);
  }

  TextStyle get _prose => look.text(size: 16, height: 1.5, color: color, spacing: 0);

  // A block the cursor can follow the last word of.
  static bool _inline(md.Node n) => n is md.Text || (n is md.Element && !const {'pre', 'table', 'blockquote', 'hr'}.contains(n.tag));

  Widget? _block(BuildContext context, md.Node n, bool writing) {
    if (n is md.Text) return n.text.trim().isEmpty ? null : _Inline(look, [n], _prose, writing: writing);
    if (n is! md.Element) return null;
    switch (n.tag) {
      case 'p':
        return _Inline(look, n.children ?? const [], _prose, writing: writing);
      case 'h1' || 'h2' || 'h3' || 'h4' || 'h5' || 'h6':
        final size = switch (n.tag) { 'h1' => 20.8, 'h2' => 18.4, _ => 17.0 };
        return _Inline(look, n.children ?? const [], look.text(size: size, weight: FontWeight.w600, height: 1.3, color: color, spacing: -0.16), writing: writing);
      case 'ul' || 'ol':
        return _list(context, n, writing);
      case 'blockquote':
        return Container(
          padding: const EdgeInsets.only(left: 14),
          decoration: BoxDecoration(border: Border(left: BorderSide(color: look.wash2, width: 2))),
          child: _Blocks(look, n.children ?? const [], color: look.ink2),
        );
      case 'pre':
        return _code(n);
      case 'table':
        return _Table(look, n);
      case 'hr':
        return Container(height: 1, color: look.rule);
      default:
        return _Inline(look, [n], _prose, writing: writing);
    }
  }

  Widget _list(BuildContext context, md.Element n, bool writing) {
    final ordered = n.tag == 'ol';
    final start = int.tryParse(n.attributes['start'] ?? '') ?? 1;
    final items = (n.children ?? const []).whereType<md.Element>().where((e) => e.tag == 'li').toList();
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 4, children: [
      for (final (i, li) in items.indexed)
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(
            width: ordered ? 22 : 18,
            child: Text(ordered ? '${start + i}.' : '•', style: _prose.copyWith(color: look.ink3)),
          ),
          Expanded(
            child: (li.children ?? const []).any((c) => c is md.Element && const {'p', 'ul', 'ol', 'pre', 'blockquote', 'table'}.contains(c.tag))
                ? _Blocks(look, li.children!, color: color, writing: writing && i == items.length - 1)
                : _Inline(look, li.children ?? const [], _prose, writing: writing && i == items.length - 1),
          ),
        ]),
    ]);
  }

  // A code block on the grouped grey, with its language, its file and Copy.
  Widget _code(md.Element pre) {
    final code = pre.children?.whereType<md.Element>().firstOrNull;
    final text = (code?.textContent ?? pre.textContent).replaceFirst(RegExp(r'\n$'), '');
    final lang = RegExp(r'language-(\S+)').firstMatch(code?.attributes['class'] ?? '')?.group(1);
    final f = fence(lang, pre.attributes['data-metadata']);
    final mono = look.mono(size: 13, color: look.ink).copyWith(height: 1.6);
    final spans = highlight(text, f.lang, look, mono);
    return Container(
      decoration: BoxDecoration(color: look.page, borderRadius: BorderRadius.circular(12), border: Border.all(color: look.rule, width: 0.5)),
      clipBehavior: Clip.antiAlias,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        // Its language, file and Copy are not the code: left out of a
        // selection.
        SelectionContainer.disabled(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 4, 4, 0),
            child: Row(children: [
              if (f.lang != null) ...[Text(f.lang!, style: look.text(size: 12, weight: FontWeight.w600, color: look.accent, spacing: 0)), const SizedBox(width: 8)],
              if (f.file != null)
                Expanded(child: Text(f.file!, style: look.mono(size: 12, color: look.ink2), maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.left))
              else
                const Spacer(),
              CopyButton(text: text, label: 'Copy code'),
            ]),
          ),
        ),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.fromLTRB(12, 4, 12, 10),
          child: spans == null ? Text(text, style: mono, softWrap: false) : Text.rich(spans, softWrap: false),
        ),
      ]),
    );
  }
}

// Inline text: emphasis, code, links and line breaks, in one paragraph.
class _Inline extends StatefulWidget {
  const _Inline(this.look, this.nodes, this.style, {this.writing = false, this.strong});
  final Look look;
  final List<md.Node> nodes;
  final TextStyle style;
  // The colour of bold text, when not the text's.
  final Color? strong;
  // The cursor after the last word.
  final bool writing;

  @override
  State<_Inline> createState() => _InlineState();
}

class _InlineState extends State<_Inline> {
  // The links' taps, made anew with each build and let go of after.
  final _taps = <TapGestureRecognizer>[];

  @override
  void dispose() {
    _forget();
    super.dispose();
  }

  void _forget() {
    for (final t in _taps) {
      t.dispose();
    }
    _taps.clear();
  }

  @override
  Widget build(BuildContext context) {
    _forget();
    return Text.rich(
      TextSpan(children: [
        for (final n in widget.nodes) _span(n, widget.style),
        // Its foot 3 below the line's baseline, as the web's vertical-align.
        if (widget.writing)
          WidgetSpan(
            alignment: PlaceholderAlignment.baseline,
            baseline: TextBaseline.alphabetic,
            child: Transform.translate(offset: const Offset(0, 3), child: const Padding(padding: EdgeInsets.only(left: 2), child: Cursor())),
          ),
      ]),
      style: widget.style,
    );
  }

  InlineSpan _span(md.Node n, TextStyle s, {TapGestureRecognizer? tap}) {
    final look = widget.look;
    if (n is md.Text) return TextSpan(text: n.text, style: s, recognizer: tap);
    if (n is! md.Element) return const TextSpan();
    List<InlineSpan> kids(TextStyle t, {TapGestureRecognizer? tap}) => [for (final c in n.children ?? const <md.Node>[]) _span(c, t, tap: tap)];
    switch (n.tag) {
      case 'strong':
        return TextSpan(children: kids(s.copyWith(fontWeight: FontWeight.w600, color: widget.strong), tap: tap));
      case 'em':
        return TextSpan(children: kids(s.copyWith(fontStyle: FontStyle.italic), tap: tap));
      case 'del':
        return TextSpan(children: kids(s.copyWith(decoration: TextDecoration.lineThrough), tap: tap));
      case 'a':
        final uri = openable(n.attributes['href']);
        final t = uri == null ? null : (TapGestureRecognizer()..onTap = () => launchUrl(uri, mode: LaunchMode.externalApplication));
        if (t != null) _taps.add(t);
        return TextSpan(children: kids(s.copyWith(color: look.accent), tap: t));
      case 'br':
        return const TextSpan(text: '\n');
      case 'img':
        return TextSpan(text: n.attributes['alt'] ?? '', style: s.copyWith(color: look.ink2));
      case 'code':
        return WidgetSpan(
          alignment: PlaceholderAlignment.baseline,
          baseline: TextBaseline.alphabetic,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
            decoration: BoxDecoration(color: look.wash, borderRadius: BorderRadius.circular(4)),
            child: Text(n.textContent, style: look.mono(size: (s.fontSize ?? 16) * 0.8, color: s.color)),
          ),
        );
      default:
        return TextSpan(children: kids(s, tap: tap));
    }
  }
}

// A link a reply may open, in the phone's browser or mail: http, https and
// mailto only, so that what a host sends cannot open the phone's other
// apps; null for anything else, which shows as a link and does nothing.
Uri? openable(String? href) {
  final uri = Uri.tryParse(href ?? '');
  return uri != null && const {'http', 'https', 'mailto'}.contains(uri.scheme.toLowerCase()) ? uri : null;
}

// A table on a card, as the web page's Table.tsx: its head on the grey,
// its first column heavier, each column a readable width, and sideways
// when wider than the reply. Then its first column stays in view while the
// rest scroll under it, the edge that hides more is shaded, and Full
// screen opens it on a page of its own, where a phone turned sideways
// shows more.
class _Table extends StatelessWidget {
  const _Table(this.look, this.table);
  final Look look;
  final md.Element table;

  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        TableView(look, table, onWide: (context) => _FullScreen.open(context, look, table)),
      ]);
}

class TableView extends StatefulWidget {
  const TableView(this.look, this.table, {super.key, this.onWide});
  final Look look;
  final md.Element table;
  // Full screen, offered while the table is wider than its place.
  final void Function(BuildContext context)? onWide;

  @override
  State<TableView> createState() => _TableViewState();
}

class _TableViewState extends State<TableView> {
  final _scroll = ScrollController();
  final _first = GlobalKey();
  // A drag begun on the held first column, passed to the rest's scroll.
  Drag? _drag;
  // The first column's width, once laid out, while the table is wide.
  double? _pinned;
  var _wide = false;

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  // Whether it is wider than its place, and how wide its first column is:
  // after each layout, since a table still streaming in grows.
  void _measure() {
    if (!mounted || !_scroll.hasClients) return;
    final wide = _scroll.position.maxScrollExtent > 1;
    final box = _first.currentContext?.findRenderObject() as RenderBox?;
    final pinned = wide && box != null && box.hasSize ? box.size.width : null;
    if (wide != _wide || pinned != _pinned) {
      setState(() {
        _wide = wide;
        _pinned = pinned;
      });
    }
  }

  Widget _grid(List<(bool, List<md.Element>)> rows, int cols, double width, {required bool copy}) {
    final look = widget.look;
    final cell = look.text(size: 14, height: 1.45, spacing: 0);
    return Table(
      defaultColumnWidth: MaxColumnWidth(const IntrinsicColumnWidth(), FixedColumnWidth(width / (cols == 0 ? 1 : cols))),
      defaultVerticalAlignment: TableCellVerticalAlignment.top,
      children: [
        for (final (i, (head, cells)) in rows.indexed)
          TableRow(
            decoration: BoxDecoration(
              color: head ? look.wash : null,
              border: i == rows.length - 1 ? null : Border(bottom: BorderSide(color: look.rule)),
            ),
            children: [
              for (var c = 0; c < cols; c++)
                Padding(
                  key: !copy && i == 0 && c == 0 ? _first : null,
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                  child: ConstrainedBox(
                    constraints: BoxConstraints(maxWidth: c == 0 ? 160 : 256),
                    // An empty cell a space, so that a selection copies
                    // its tab and the columns after it stay in place.
                    child: c < cells.length && cells[c].textContent.trim().isNotEmpty
                        ? _Inline(look, cells[c].children ?? const [],
                            head ? cell.copyWith(fontSize: 12.5, fontWeight: FontWeight.w600, color: look.ink2) : c == 0 ? cell.copyWith(fontWeight: FontWeight.w600) : cell)
                        : Text(' ', style: cell),
                  ),
                ),
            ],
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final look = widget.look;
    final rows = <(bool, List<md.Element>)>[];
    void walk(md.Element e) {
      for (final c in (e.children ?? const <md.Node>[]).whereType<md.Element>()) {
        if (c.tag == 'tr') {
          rows.add((c.children!.whereType<md.Element>().any((x) => x.tag == 'th'), c.children!.whereType<md.Element>().toList()));
        } else {
          walk(c);
        }
      }
    }

    walk(widget.table);
    final cols = rows.fold(0, (n, r) => r.$2.length > n ? r.$2.length : n);
    WidgetsBinding.instance.addPostFrameCallback((_) => _measure());
    final dark = MediaQuery.platformBrightnessOf(context) == Brightness.dark;
    final shade = dark ? const Color(0x24ffffff) : const Color(0x29000000);
    Widget edge(bool left) => IgnorePointer(
          child: Container(
            width: 12,
            decoration: BoxDecoration(
              gradient: LinearGradient(begin: left ? Alignment.centerLeft : Alignment.centerRight, end: left ? Alignment.centerRight : Alignment.centerLeft, colors: [shade, shade.withValues(alpha: 0)]),
            ),
          ),
        );
    final pinned = _pinned;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Container(
        decoration: BoxDecoration(color: look.card, borderRadius: BorderRadius.circular(12), border: Border.all(color: look.rule)),
        clipBehavior: Clip.antiAlias,
        // At least as wide as the reply, each column its share or more.
        child: LayoutBuilder(
          builder: (context, box) => NotificationListener<ScrollMetricsNotification>(
            onNotification: (_) {
              _measure();
              return false;
            },
            child: Stack(children: [
              SingleChildScrollView(controller: _scroll, scrollDirection: Axis.horizontal, child: Lines(beside: '\t', child: _grid(rows, cols, box.maxWidth, copy: false))),
              if (pinned != null) ...[
                // The first column, held: the same table again, so that its
                // rows are as tall, clipped to that column, with a rule.
                Positioned(
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: pinned + 1,
                  // A copy for the eye, left out of a selection as of
                  // the screen reader.
                  child: ExcludeSemantics(
                    child: SelectionContainer.disabled(
                      child: GestureDetector(
                        onHorizontalDragStart: (d) => _drag = _scroll.position.drag(d, () => _drag = null),
                        onHorizontalDragUpdate: (d) => _drag?.update(d),
                        onHorizontalDragEnd: (d) => _drag?.end(d),
                        onHorizontalDragCancel: () => _drag?.cancel(),
                        child: DecoratedBox(
                          position: DecorationPosition.foreground,
                          decoration: BoxDecoration(border: Border(right: BorderSide(color: look.rule))),
                          child: ClipRect(
                            child: OverflowBox(
                              alignment: Alignment.topLeft,
                              minWidth: 0,
                              maxWidth: double.infinity,
                              // On the card, opaque, so that the rest scroll
                              // under it.
                              child: ColoredBox(color: look.card, child: _grid(rows, cols, box.maxWidth, copy: true)),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                // The edges that hide more, shaded.
                ListenableBuilder(
                  listenable: _scroll,
                  builder: (context, _) {
                    final at = _scroll.hasClients ? _scroll.offset : 0.0;
                    final end = _scroll.hasClients ? _scroll.position.maxScrollExtent : 0.0;
                    return Positioned.fill(
                      child: Row(children: [
                        SizedBox(width: pinned + 1),
                        if (at > 1) edge(true),
                        const Spacer(),
                        if (at < end - 1) edge(false),
                      ]),
                    );
                  },
                ),
              ],
            ]),
          ),
        ),
      ),
      if (_wide && widget.onWide != null)
        SelectionContainer.disabled(
          child: Semantics(
            button: true,
            label: 'Full screen',
            excludeSemantics: true,
            onTap: () => widget.onWide!(context),
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => widget.onWide!(context),
              child: Padding(
                padding: const EdgeInsets.only(top: 6),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 32),
                  child: Row(mainAxisSize: MainAxisSize.min, spacing: 6, children: [
                    Icon(CupertinoIcons.arrow_up_left_arrow_down_right, size: 15, color: look.accent),
                    Text('Full screen', style: look.text(size: 15, color: look.accent, spacing: 0)),
                  ]),
                ),
              ),
            ),
          ),
        ),
    ]);
  }
}

// A wide table on a page of its own; turned sideways, the phone shows more.
class _FullScreen extends StatelessWidget {
  const _FullScreen(this.look, this.table);
  final Look look;
  final md.Element table;

  static void open(BuildContext context, Look look, md.Element table) =>
      Navigator.of(context).push(CupertinoPageRoute<void>(fullscreenDialog: true, builder: (_) => _FullScreen(look, table)));

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final portrait = media.orientation == Orientation.portrait;
    return CupertinoPageScaffold(
      backgroundColor: look.page,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Container(
          padding: EdgeInsets.only(top: media.padding.top, left: media.padding.left + 20, right: media.padding.right + 8),
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: look.rule))),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 52),
            child: Row(children: [
              if (portrait) ...[
                Transform.rotate(
                  angle: -0.52,
                  child: Container(width: 18, height: 26, decoration: BoxDecoration(borderRadius: BorderRadius.circular(4), border: Border.all(color: look.ink2, width: 1.3))),
                ),
                const SizedBox(width: 10),
                Expanded(child: Text('Turn the phone sideways to see more', style: look.text(size: 13, color: look.ink2, spacing: 0))),
              ] else
                const Spacer(),
              Semantics(
                button: true,
                label: 'Close',
                excludeSemantics: true,
                onTap: () => Navigator.of(context).maybePop(),
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => Navigator.of(context).maybePop(),
                  child: Container(
                    width: 44,
                    height: 44,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(color: look.wash, shape: BoxShape.circle),
                    child: Icon(CupertinoIcons.xmark, size: 18, color: look.ink),
                  ),
                ),
              ),
            ]),
          ),
        ),
        Expanded(
          child: SingleChildScrollView(
            padding: EdgeInsets.fromLTRB(media.padding.left + 20, 20, media.padding.right + 20, media.padding.bottom + 20),
            child: Selectable(child: TableView(look, table)),
          ),
        ),
      ]),
    );
  }
}

// Copy, then Copied for a moment; a control, left out of a selection.
class CopyButton extends StatefulWidget {
  const CopyButton({super.key, required this.text, required this.label});
  final String text;
  final String label;

  @override
  State<CopyButton> createState() => _CopyButtonState();
}

class _CopyButtonState extends State<CopyButton> {
  var _copied = false;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return SelectionContainer.disabled(
      child: Semantics(
        button: true,
        label: widget.label,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () async {
            await Clipboard.setData(ClipboardData(text: widget.text));
            if (!mounted) return;
            setState(() => _copied = true);
            await Future<void>.delayed(const Duration(milliseconds: 1500));
            if (mounted) setState(() => _copied = false);
          },
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 32),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
              child: Text(_copied ? 'Copied' : 'Copy', style: look.text(size: 12.5, weight: FontWeight.w500, color: look.ink3, spacing: 0)),
            ),
          ),
        ),
      ),
    );
  }
}

// A line under a chat's header in Markdown, as the web's .notice: small,
// its paragraphs close together, its figures in ink.
class NoticeText extends StatelessWidget {
  const NoticeText(this.text, {super.key, required this.color});
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final style = look.text(size: 13.5, height: 1.45, color: color, spacing: 0);
    final nodes = md.Document(extensionSet: md.ExtensionSet.gitHubFlavored, encodeHtml: false).parse(text);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 2, children: [
      for (final n in nodes)
        _Inline(look, n is md.Element && n.tag == 'p' ? n.children ?? const [] : [n], style, strong: look.ink),
    ]);
  }
}

// The cursor of a reply still streaming, as Native's (index.css's cards
// .cursor): a block in the accent, as tall as a line of its text,
// blinking as the web's does (steps(2) over each half second: full, half,
// none, half); steady when the phone asks for less motion.
class Cursor extends StatefulWidget {
  const Cursor({super.key});

  @override
  State<Cursor> createState() => _CursorState();
}

class _CursorState extends State<Cursor> {
  static const _blink = [1.0, 0.5, 0.0, 0.5];
  // A quarter second each; four frames a second.
  Timer? _tick;
  var _step = 0;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _tick?.cancel();
    _step = 0;
    _tick = MediaQuery.disableAnimationsOf(context) ? null : Timer.periodic(const Duration(milliseconds: 250), (_) => setState(() => _step = (_step + 1) % 4));
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Opacity(
        opacity: _blink[_step],
        child: Container(width: 9, height: 17.6, decoration: BoxDecoration(color: Look.of(context).accent, borderRadius: BorderRadius.circular(2))),
      );
}
