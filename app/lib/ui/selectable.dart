// Text read in a chat, selectable within one message: a long press selects
// a word, with the system's handles and its Copy, Select all and Share (a
// mouse drags); a tap that ends a selection only ends it, and otherwise is
// the message's own (going back from the user's). A tap outside it ends it
// too, as elsewhere on the phone, but not a scroll; so does a tap on another
// message, which on the user's message does nothing more. Controls inside it are
// left out (SelectionContainer.disabled), so that Select all is the text.
import 'package:flutter/cupertino.dart';
import 'package:flutter/gestures.dart' show kTouchSlop;
import 'package:flutter/material.dart' show SelectionArea, SelectionAreaState;
import 'package:flutter/rendering.dart' show MatrixUtils, SelectedContent;

class Selectable extends StatefulWidget {
  const Selectable({super.key, required this.child, this.onTap});
  final Widget child;
  final VoidCallback? onTap;

  @override
  State<Selectable> createState() => _SelectableState();
}

class _SelectableState extends State<Selectable> {
  // The one with a selection: a tap on another, on its text or a control
  // in it, ends that selection first.
  static _SelectableState? _held;

  final _area = GlobalKey<SelectionAreaState>();
  var _selected = false;
  // Where a touch outside it went down.
  Offset? _down;
  // Where a touch in it went down, and whether, as a tap, it ended
  // another's selection: then that is all it does.
  Offset? _press;
  var _ended = false;

  @override
  void dispose() {
    if (_held == this) _held = null;
    super.dispose();
  }

  void _clear() => _area.currentState?.selectableRegion.clearSelection();

  void _changed(SelectedContent? c) {
    _selected = c != null && c.plainText.isNotEmpty;
    if (_selected && _held != this) {
      final was = _held;
      _held = this;
      was?._clear();
    } else if (!_selected && _held == this) {
      _held = null;
    }
  }

  void _tap() {
    if (_ended) return;
    _selected ? _clear() : widget.onTap!();
  }

  @override
  Widget build(BuildContext context) => TapRegion(
        // The group of every selection's handles and menu, which are not
        // outside it.
        groupId: SelectableRegion,
        onTapOutside: (e) => _down = e.position,
        onTapUpOutside: (e) {
          if (_selected && _down != null && (e.position - _down!).distance < kTouchSlop) _clear();
          _down = null;
        },
        child: Listener(
          onPointerDown: (e) {
            _press = e.position;
            _ended = false;
          },
          // Before the tap is given to what is under it.
          onPointerUp: (e) {
            final other = _held;
            if (other != null && other != this && _press != null && (e.position - _press!).distance < kTouchSlop) {
              other._clear();
              _ended = true;
            }
            _press = null;
          },
          child: SelectionArea(
            key: _area,
            onSelectionChanged: _changed,
            child: Lines(child: widget.onTap == null ? widget.child : GestureDetector(behavior: HitTestBehavior.opaque, onTap: _tap, child: widget.child)),
          ),
        ),
      );
}

// What is copied of the text in it: each piece on a line of its own when
// it is below the one before (a paragraph, a list's item, a code block), and
// after a space when beside it (a list's number), or what beside gives (a
// tab between a table's cells), where Flutter would run them together. A
// scrolling view inside it joins its own, so it takes one of these too.
class Lines extends StatefulWidget {
  const Lines({super.key, required this.child, this.beside = ' '});
  final Widget child;
  final String beside;

  @override
  State<Lines> createState() => _LinesState();
}

class _LinesState extends State<Lines> {
  late final _lines = _Lines(widget.beside);

  @override
  void dispose() {
    _lines.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SelectionContainer(delegate: _lines, child: widget.child);
}

class _Lines extends StaticSelectionContainerDelegate {
  _Lines(this.beside);
  final String beside;

  @override
  SelectedContent? getSelectedContent() {
    final out = StringBuffer();
    Rect? last;
    for (final s in selectables) {
      final c = s.getSelectedContent();
      if (c == null || s.boundingBoxes.isEmpty) continue;
      final to = s.getTransformTo(null);
      if (last != null) out.write(MatrixUtils.transformRect(to, s.boundingBoxes.first).top >= last.bottom - 1 ? '\n' : beside);
      out.write(c.plainText);
      last = MatrixUtils.transformRect(to, s.boundingBoxes.last);
    }
    return last == null ? null : SelectedContent(plainText: out.toString());
  }
}
