// Sheets over the page, as the web page's Native look draws them
// (web/page/src/Sheet.tsx): from the bottom, on the grouped grey, with a
// handle, a title, and Done; rows on cards; two answers side by side. Above
// the keyboard when one is open, where the web's goes to the top instead.
// Dragged down, by its handle and title or by rows already scrolled to the
// top, it follows the finger and closes past a third of its height or on a
// flick; short of that it goes back.
import 'package:flutter/cupertino.dart';

import 'look.dart';

// Opens a sheet; completes when it closes, with what it was closed with. On
// a wide screen (a tablet), no wider than the web page's (32rem), in the
// middle.
Future<T?> showSheet<T>(BuildContext context, WidgetBuilder builder) => showCupertinoModalPopup<T>(
      context: context,
      barrierColor: Look.of(context).scrim,
      builder: (context) => Align(
        alignment: Alignment.bottomCenter,
        child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: sheetMaxWidth), child: builder(context)),
      ),
    );

const sheetMaxWidth = 512.0;

// Whether a drag let go [dy] below where the sheet rests, moving at
// [velocity] (downwards positive), closes a sheet [height] tall.
// web/page/src/drag.ts decides the same.
bool dragCloses(double dy, double velocity, double height) => dy > 0 && (velocity > 700 || (velocity > -300 && dy > height / 3));

class Sheet extends StatefulWidget {
  const Sheet({super.key, required this.title, this.sub, this.done, required this.children});
  final String title;
  final String? sub;
  // The word that closes it, at the top; none: a scrim tap, an answer, or a
  // drag down.
  final String? done;
  final List<Widget> children;

  @override
  State<Sheet> createState() => _SheetState();
}

class _SheetState extends State<Sheet> with SingleTickerProviderStateMixin {
  // How far below where it rests the finger has it.
  late final _dy = AnimationController.unbounded(vsync: this);
  var _closing = false;

  @override
  void dispose() {
    _dy.dispose();
    super.dispose();
  }

  void _drag(double delta) {
    if (_closing) return;
    _dy.value = (_dy.value + delta).clamp(0, double.infinity);
  }

  void _let(double velocity) {
    if (_closing) return;
    // The sheet's own height, without the keyboard it sits on.
    final height = (context.size?.height ?? 0) - MediaQuery.of(context).viewInsets.bottom;
    final held = ModalRoute.of(context)?.popDisposition == RoutePopDisposition.doNotPop;
    if (!held && dragCloses(_dy.value, velocity, height)) {
      _closing = true;
      Navigator.of(context).maybePop().then((popped) {
        if (popped || !mounted) return;
        _closing = false;
        _back();
      });
    } else {
      _back();
    }
  }

  void _back() => _dy.animateTo(0, duration: const Duration(milliseconds: 200), curve: Curves.easeOut);

  // Rows scrolled to the top and pulled further: the sheet comes down; pushed
  // up again while it is down: it goes back up before they scroll.
  bool _scrolled(ScrollNotification n) {
    if (n.depth != 0) return false;
    if (n is OverscrollNotification && n.dragDetails != null && n.overscroll < 0) {
      _drag(-n.overscroll);
    } else if (n is ScrollUpdateNotification && n.dragDetails != null && _dy.value > 0 && (n.scrollDelta ?? 0) > 0) {
      final take = n.scrollDelta!.clamp(0, _dy.value).toDouble();
      _drag(-take);
      final at = n.metrics.pixels - take;
      if (at >= n.metrics.minScrollExtent) Scrollable.of(n.context!).position.correctBy(-take);
    } else if (n is ScrollEndNotification && _dy.value > 0) {
      _let(n.dragDetails?.primaryVelocity ?? 0);
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final media = MediaQuery.of(context);
    final w = widget;
    return Padding(
      padding: EdgeInsets.only(bottom: media.viewInsets.bottom),
      child: AnimatedBuilder(
        animation: _dy,
        builder: (context, child) => Transform.translate(offset: Offset(0, _dy.value), child: child),
        child: GestureDetector(
          // Anywhere the rows do not take the drag themselves: the handle and
          // title always, the rows when they do not scroll.
          onVerticalDragUpdate: (d) => _drag(d.primaryDelta ?? 0),
          onVerticalDragEnd: (d) => _let(d.primaryVelocity ?? 0),
          onVerticalDragCancel: () => _let(0),
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: (media.size.height - media.viewInsets.bottom) * 0.85),
            child: Container(
              decoration: BoxDecoration(
                color: look.sheet,
                borderRadius: const BorderRadius.vertical(top: Radius.circular(14)),
                boxShadow: const [BoxShadow(color: Color(0x26000000), offset: Offset(0, -8), blurRadius: 30)],
              ),
              child: SafeArea(
                top: false,
                minimum: const EdgeInsets.only(bottom: 20),
                child: Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
                    Semantics(
                      label: 'Drag down to close',
                      child: Center(child: Container(width: 36, height: 4, margin: const EdgeInsets.only(bottom: 10), decoration: BoxDecoration(color: look.wash2, borderRadius: BorderRadius.circular(2)))),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 4, 12, 12),
                      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text(w.title, style: look.text(size: 17, weight: FontWeight.w600, spacing: -0.2), maxLines: 1, overflow: TextOverflow.ellipsis),
                            if (w.sub != null && w.sub!.isNotEmpty)
                              Padding(padding: const EdgeInsets.only(top: 2), child: Text(w.sub!, style: look.text(size: 13, color: look.ink2, spacing: 0), maxLines: 1, overflow: TextOverflow.ellipsis)),
                          ]),
                        ),
                        if (w.done != null)
                          Semantics(
                            button: true,
                            child: GestureDetector(
                              behavior: HitTestBehavior.opaque,
                              onTap: () => Navigator.of(context).pop(),
                              child: ConstrainedBox(
                                constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
                                child: Align(alignment: Alignment.centerRight, widthFactor: 1, child: Text(w.done!, style: look.text(size: 17, weight: FontWeight.w600, color: look.accent, spacing: 0))),
                              ),
                            ),
                          ),
                      ]),
                    ),
                    Flexible(
                      child: NotificationListener<ScrollNotification>(
                        onNotification: _scrolled,
                        // Clamped, so that a pull past the top reaches the
                        // sheet rather than bouncing the rows.
                        child: SingleChildScrollView(
                          physics: const ClampingScrollPhysics(),
                          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: w.children),
                        ),
                      ),
                    ),
                  ]),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// Rows that belong together, on a card of their own, ruled apart.
class SheetGroup extends StatelessWidget {
  const SheetGroup({super.key, required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(color: look.sheetCard, borderRadius: BorderRadius.circular(14)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final (i, c) in children.indexed)
          i == 0 ? c : DecoratedBox(decoration: BoxDecoration(border: Border(top: BorderSide(color: look.rule))), child: c),
      ]),
    );
  }
}

// A row of a sheet: a label, an optional line under it, and a value.
class SheetRow extends StatefulWidget {
  const SheetRow({super.key, required this.label, this.sub, this.value, this.danger = false, this.disabled = false, this.onTap});
  final String label;
  final String? sub;
  final Widget? value;
  final bool danger;
  final bool disabled;
  final VoidCallback? onTap;

  @override
  State<SheetRow> createState() => _SheetRowState();
}

class _SheetRowState extends State<SheetRow> {
  var _down = false;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final w = widget;
    final on = !w.disabled && w.onTap != null;
    return Semantics(
      button: true,
      enabled: on,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: on ? (_) => setState(() => _down = true) : null,
        onTapCancel: () => setState(() => _down = false),
        onTapUp: (_) => setState(() => _down = false),
        onTap: on ? w.onTap : null,
        child: Opacity(
          opacity: w.disabled ? 0.4 : 1,
          child: Container(
            color: _down ? look.wash : null,
            constraints: const BoxConstraints(minHeight: 48),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Row(children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  Text(w.label, style: look.text(size: 16, color: w.danger ? look.block : look.ink, spacing: 0)),
                  if (w.sub != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 1),
                      child: Text(w.sub!, style: look.text(size: 13, color: look.ink2, spacing: 0), maxLines: 1, overflow: TextOverflow.ellipsis),
                    ),
                ]),
              ),
              if (w.value != null) ...[const SizedBox(width: 12), w.value!],
            ]),
          ),
        ),
      ),
    );
  }
}

// Two answers side by side: Cancel, or another word for not doing it, and
// the action.
class Answers extends StatelessWidget {
  const Answers({super.key, required this.cancel, this.cancelLabel = 'Cancel', required this.label, this.danger = false, this.disabled = false, required this.go});
  final VoidCallback cancel;
  final String cancelLabel;
  final String label;
  final bool danger;
  final bool disabled;
  final VoidCallback go;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    Widget button(String text, Color fill, Color ink, VoidCallback? onTap, {bool off = false}) => Expanded(
          child: Semantics(
            button: true,
            enabled: !off,
            child: GestureDetector(
              onTap: off ? null : onTap,
              child: Opacity(
                opacity: off ? 0.4 : 1,
                child: Container(
                  height: 52,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(color: fill, borderRadius: BorderRadius.circular(14)),
                  child: Text(text, style: look.text(size: 15.5, weight: FontWeight.w600, color: ink, spacing: 0)),
                ),
              ),
            ),
          ),
        );
    return Row(spacing: 10, children: [
      button(cancelLabel, look.wash, look.ink, cancel),
      button(label, danger ? look.blockWash : look.accent, danger ? look.block : look.onAccent, go, off: disabled),
    ]);
  }
}

// A paragraph saying what an answer will do.
class SheetText extends StatelessWidget {
  const SheetText(this.spans, {super.key});
  final List<InlineSpan> spans;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Text.rich(TextSpan(children: spans), style: look.text(size: 15.5, height: 1.6, color: look.ink2, spacing: 0));
  }
}
