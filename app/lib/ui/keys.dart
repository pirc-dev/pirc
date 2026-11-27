// Keys on a hardware keyboard (an iPad's, a tablet's), as the web page's
// (web/page/src/keys.ts) where they fit the app: in the message box Return
// sends, Shift+Return makes a new line, Option (Alt)+Return queues and
// Esc leaves the box; outside a field, n opens the next session waiting,
// / or ⌘F (Ctrl+F) the list's search, ⌘, (Ctrl+,) or ? Settings, and Esc
// stops pi. A screen's keys act only while nothing is over it.
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

// What the keys do, for Settings: an Apple keyboard's names, or another's
// on Android.
String keysSaid({required bool apple}) => [
      'Return sends',
      'Shift-Return a new line',
      '${apple ? 'Option' : 'Alt'}-Return queues',
      'n the next waiting',
      '/ search',
      'Esc stops pi',
      '${apple ? '⌘' : 'Ctrl-'}, Settings',
    ].join(' · ');

// Whether the screen at [context] is in front: its route, and each route
// that holds the navigator it is in, the top one.
bool frontmost(BuildContext context) {
  BuildContext? c = context;
  while (c != null) {
    final route = ModalRoute.of(c);
    if (route == null) return true;
    if (!route.isCurrent) return false;
    c = route.navigator?.context;
  }
  return true;
}

// Whether a text field has the keys.
bool typing() {
  final c = FocusManager.instance.primaryFocus?.context;
  return c != null && (c.widget is EditableText || c.findAncestorStateOfType<EditableTextState>() != null);
}

// ⌘ on an Apple keyboard, Ctrl on another.
bool get command => HardwareKeyboard.instance.isMetaPressed || HardwareKeyboard.instance.isControlPressed;

bool get anyModifier => command || HardwareKeyboard.instance.isAltPressed;

// Whether the screen's own keyboard is up: Return is then its return key, a
// new line. Over 100 points, more than the strip of shortcuts an iPad shows
// over a hardware keyboard. The window's, since a page's scaffold takes the
// keyboard out of what it tells what is on it.
bool screenKeyboard(BuildContext context) {
  final view = View.of(context);
  return view.viewInsets.bottom / view.devicePixelRatio >= 100;
}

bool isReturn(KeyEvent e) => e.logicalKey == LogicalKeyboardKey.enter || e.logicalKey == LogicalKeyboardKey.numpadEnter;

// A screen's keys: [onKey] is asked about each key pressed while the
// screen is in front and no field has the keys, and says whether it took
// it.
mixin ScreenKeys<T extends StatefulWidget> on State<T> {
  bool onKey(KeyEvent e);

  bool _key(KeyEvent e) {
    if (e is! KeyDownEvent || !mounted || typing() || !frontmost(context)) return false;
    return onKey(e);
  }

  @override
  void initState() {
    super.initState();
    HardwareKeyboard.instance.addHandler(_key);
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_key);
    super.dispose();
  }
}
