// The session list's column on a wide screen, as the web page's
// (web/page/src/side.ts): how wide it is, dragged by its edge, and whether
// it is hidden, by the button at the start of what is beside it, which so
// stays in one place either way. Kept on the device.
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart' show Icons, Tooltip;

import 'adaptive.dart';
import 'look.dart';

const sideWidthDefault = 380.0;
const sideMin = 280.0;
const sideMax = 560.0;
// What is beside the list keeps at least this much.
const sideRoom = 400.0;

// Wide enough for the list and a chat side by side: a tablet either way up,
// or a wide window; not a phone on its side, whose height is too little for
// the chat as it is.
bool isWide(Size size) => size.width >= 700 && size.height >= 500;

class Side {
  const Side({this.width = sideWidthDefault, this.hidden = false});
  final double width;
  final bool hidden;

  Side copyWith({double? width, bool? hidden}) => Side(width: width ?? this.width, hidden: hidden ?? this.hidden);

  Map<String, Object> toJson() => {'width': width, 'hidden': hidden};

  static Side fromJson(Object? j) {
    if (j is! Map) return const Side();
    final w = j['width'];
    return Side(width: w is num ? w.toDouble() : sideWidthDefault, hidden: j['hidden'] == true);
  }
}

// The width the column has in a window [room] wide.
double sideWidth(double width, double room) => width.clamp(sideMin, sideMax).clamp(sideMin, (room - sideRoom).clamp(sideMin, sideMax)).roundToDouble();

// Over what is beside the list: the column's state, for its button.
class SideScope extends InheritedNotifier<ValueNotifier<Side>> {
  const SideScope({super.key, required ValueNotifier<Side> side, required super.child}) : super(notifier: side);

  static ValueNotifier<Side>? of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<SideScope>()?.notifier;
}

// Hides or shows the list; nothing where there is no list beside.
class SideToggle extends StatelessWidget {
  const SideToggle({super.key});

  @override
  Widget build(BuildContext context) {
    final side = SideScope.of(context);
    if (side == null) return const SizedBox.shrink();
    final look = Look.of(context);
    final hidden = side.value.hidden;
    final label = hidden ? 'Show the list' : 'Hide the list';
    final icon = onAndroid ? (hidden ? Icons.menu : Icons.menu_open) : CupertinoIcons.sidebar_left;
    final button = Semantics(
      button: true,
      expanded: !hidden,
      label: label,
      excludeSemantics: true,
      onTap: () => side.value = side.value.copyWith(hidden: !hidden),
      child: Press(
        padding: EdgeInsets.zero,
        minimumSize: const Size(44, 44),
        onPressed: () => side.value = side.value.copyWith(hidden: !hidden),
        child: Icon(icon, size: 22, color: look.accent),
      ),
    );
    // Android's icon buttons name themselves on a long press.
    return onAndroid ? Tooltip(message: label, excludeFromSemantics: true, child: button) : button;
  }
}

// The column's edge: a line, and either side of it a strip that a finger or
// a pointer drags. Taps on the strip go through to what is under it.
class SideEdge extends StatefulWidget {
  const SideEdge({super.key, required this.side, required this.room});
  final ValueNotifier<Side> side;
  final double room;

  @override
  State<SideEdge> createState() => _SideEdgeState();
}

class _SideEdgeState extends State<SideEdge> {
  double? _from;
  var _hover = false;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final side = widget.side;
    return Semantics(
      label: 'List width',
      value: '${side.value.width.round()}',
      increasedValue: '${sideWidth(side.value.width + 20, widget.room).round()}',
      decreasedValue: '${sideWidth(side.value.width - 20, widget.room).round()}',
      onIncrease: () => side.value = side.value.copyWith(width: sideWidth(side.value.width + 20, widget.room)),
      onDecrease: () => side.value = side.value.copyWith(width: sideWidth(side.value.width - 20, widget.room)),
      child: MouseRegion(
        cursor: SystemMouseCursors.resizeColumn,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: GestureDetector(
          behavior: HitTestBehavior.translucent,
          onHorizontalDragStart: (_) => setState(() => _from = sideWidth(side.value.width, widget.room)),
          onHorizontalDragUpdate: (d) {
            final from = _from;
            if (from == null) return;
            _from = from + d.delta.dx;
            side.value = side.value.copyWith(width: sideWidth(_from!, widget.room));
          },
          onHorizontalDragEnd: (_) => setState(() => _from = null),
          onHorizontalDragCancel: () => setState(() => _from = null),
          child: Center(
            child: Container(width: _hover || _from != null ? 2 : 0.5, color: _hover || _from != null ? look.accent.withValues(alpha: 0.6) : look.rule),
          ),
        ),
      ),
    );
  }
}
