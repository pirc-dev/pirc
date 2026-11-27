// The controls that differ between the platforms: on iOS (and iPadOS) the
// phone's own, as Flutter's Cupertino widgets draw them; on Android
// Material 3's, as Flutter's Material widgets draw them. Everything else
// (the Native look's colours, type, cards and sheets) is the same on both.
//
// - Pages: iOS slides them in from the right and back with an edge swipe;
//   Android uses its predictive back, which shows the page underneath as
//   the back gesture is made and can be cancelled.
// - Back: "‹ Sessions" on iOS; an arrow on Android, whose page title says
//   where it is.
// - Alerts: iOS's centred alert with its stacked buttons; Material's
//   dialog, its text buttons at its end, a destructive one in red.
// - Buttons: iOS fades them when pressed; Android ripples.
// - Spinners, switches, search fields, text selection's handles and menu,
//   and scrolling (iOS bounces; Android stretches), each the platform's.
import 'dart:math' as math;

import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart'
    show
        AdaptiveTextSelectionToolbar,
        AlertDialog,
        DialogRoute,
        ColorScheme,
        DefaultMaterialLocalizations,
        Theme,
        CircularProgressIndicator,
        IconButton,
        Icons,
        InkWell,
        Material,
        MaterialPageRoute,
        MaterialScrollBehavior,
        MaterialType,
        Switch,
        TextButton,
        TextMagnifier,
        TextSelectionThemeData,
        ThemeData,
        materialTextSelectionHandleControls,
        showDialog;

import 'look.dart';

bool get onAndroid => defaultTargetPlatform == TargetPlatform.android;

// The Material theme the Android controls take their colours from: the
// Native look's, so that a dialog or a switch is in the app's colours.
ThemeData materialTheme(Look look, Brightness brightness) {
  final scheme = ColorScheme(
    brightness: brightness,
    primary: look.accent,
    onPrimary: look.onAccent,
    secondary: look.accent,
    onSecondary: look.onAccent,
    error: look.block,
    onError: look.card,
    surface: look.card,
    onSurface: look.ink,
    onSurfaceVariant: look.ink2,
    surfaceContainerHigh: look.sheetCard,
    surfaceContainerHighest: Color.alphaBlend(look.wash2, look.card),
    outline: look.ink3,
    outlineVariant: look.rule,
  );
  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    fontFamily: look.fontFamily,
    scaffoldBackgroundColor: look.page,
    textSelectionTheme: TextSelectionThemeData(cursorColor: look.accent, selectionColor: look.accent.withValues(alpha: 0.3), selectionHandleColor: look.accent),
  );
}

// The app's localizations: Material's too, for its dialogs and menus on
// Android and for Flutter's page of the licences.
const appLocalizations = [DefaultMaterialLocalizations.delegate, DefaultCupertinoLocalizations.delegate, DefaultWidgetsLocalizations.delegate];

// Under a CupertinoApp's builder: on Android, the Material theme its
// controls take their colours from.
Widget platformControls(Look look, Brightness brightness, Widget child) => onAndroid ? Theme(data: materialTheme(look, brightness), child: child) : child;

// How lists scroll: iOS bounces at the ends; Android stretches.
ScrollBehavior get scrollBehavior => onAndroid ? const MaterialScrollBehavior() : const CupertinoScrollBehavior();

// A page pushed on a navigator; [fullscreenDialog]: one that covers what
// it was opened from (on iOS it comes up from the bottom).
Route<T> pageRoute<T>({required WidgetBuilder builder, bool fullscreenDialog = false, RouteSettings? settings}) => onAndroid
    ? MaterialPageRoute<T>(builder: builder, fullscreenDialog: fullscreenDialog, settings: settings)
    : CupertinoPageRoute<T>(builder: builder, fullscreenDialog: fullscreenDialog, settings: settings);

// Back to the page underneath: "‹ [label]" on iOS, an arrow on Android.
class BackLink extends StatelessWidget {
  const BackLink({super.key, required this.label, this.onPressed, this.close = false});
  final String label;
  // Null: disabled.
  final VoidCallback? onPressed;
  // A page that covers the one it came from: closed, not gone back from
  // (Android's ✕).
  final bool close;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    if (onAndroid) {
      return Material(
        type: MaterialType.transparency,
        child: IconButton(
          onPressed: onPressed,
          tooltip: close ? 'Close' : 'Back',
          color: look.ink,
          icon: Icon(close ? Icons.close : Icons.arrow_back, size: 24),
        ),
      );
    }
    return CupertinoButton(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      minimumSize: const Size(44, 44),
      onPressed: onPressed,
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(CupertinoIcons.chevron_back, size: 22, color: look.accent),
        Text(label, style: look.text(color: look.accent)),
      ]),
    );
  }
}

// What a CupertinoNavigationBar leads with: on Android the arrow, where it
// would put "‹ Back"; elsewhere null, for its own.
Widget? barLeading(BuildContext context) =>
    onAndroid && (ModalRoute.of(context)?.canPop ?? false) ? BackLink(label: 'Back', onPressed: () => Navigator.of(context).maybePop()) : null;

// A choice in an alert.
class AlertAction<T> {
  const AlertAction(this.label, this.value, {this.destructive = false, this.primary = false}) : read = null;
  // One whose value is read when it is chosen (a field's text).
  const AlertAction.read(this.label, T Function() this.read, {this.destructive = false, this.primary = false}) : value = null;
  final String label;
  // What the alert completes with when it is chosen.
  final T? value;
  final T Function()? read;
  T? get chosen => read != null ? read!() : value;
  final bool destructive;
  // The one Return chooses, in bold on iOS.
  final bool primary;
}

// An alert over everything; completes with the chosen action's value, or
// null. With no actions, it stays until its route is removed.
Future<T?> showAlert<T>(BuildContext context, {required Widget title, Widget? content, List<AlertAction<T>> actions = const [], bool dismissible = false}) {
  if (onAndroid) {
    return showDialog<T>(context: context, barrierDismissible: dismissible, builder: (context) => alertDialog(context, title: title, content: content, actions: actions));
  }
  return showCupertinoDialog<T>(context: context, barrierDismissible: dismissible, builder: (context) => alertDialog(context, title: title, content: content, actions: actions));
}

// The alert itself, for a route of one's own.
Widget alertDialog<T>(BuildContext context, {required Widget title, Widget? content, List<AlertAction<T>> actions = const []}) {
  if (onAndroid) {
    final look = Look.of(context);
    return AlertDialog(
      title: title,
      content: content,
      actions: [
        for (final a in actions)
          TextButton(
            style: a.destructive ? TextButton.styleFrom(foregroundColor: look.block) : null,
            onPressed: () => Navigator.of(context).pop(a.chosen),
            child: Text(a.label),
          ),
      ],
    );
  }
  return CupertinoAlertDialog(
    title: title,
    content: content,
    actions: [
      for (final a in actions)
        CupertinoDialogAction(
          isDefaultAction: a.primary,
          isDestructiveAction: a.destructive,
          onPressed: () => Navigator.of(context).pop(a.chosen),
          child: Text(a.label),
        ),
    ],
  );
}

// The route of a dialog that is not an alert's (one that waits), dismissed
// only by removing it.
Route<T> dialogRoute<T>(BuildContext context, WidgetBuilder builder) =>
    onAndroid ? DialogRoute<T>(context: context, barrierDismissible: false, builder: builder) : CupertinoDialogRoute<T>(context: context, barrierDismissible: false, builder: builder);

// Something under way: iOS's petals, Material's circle; [radius] is half
// its size on both.
class Spinner extends StatelessWidget {
  const Spinner({super.key, this.radius = 10, this.color});
  final double radius;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    if (!onAndroid) return CupertinoActivityIndicator(radius: radius, color: color);
    final size = radius * 2;
    return SizedBox.square(
      dimension: size,
      child: Padding(
        // Material's circle fills its box; iOS's petals do not quite.
        padding: EdgeInsets.all(size / 10),
        child: CircularProgressIndicator(strokeWidth: math.max(1.5, size / 10), color: color ?? Look.of(context).accent),
      ),
    );
  }
}

// An on/off switch; iOS's in [iosColor] when on, Material's in the accent.
class Toggle extends StatelessWidget {
  const Toggle({super.key, required this.value, required this.onChanged, this.iosColor});
  final bool value;
  // Null: disabled.
  final ValueChanged<bool>? onChanged;
  final Color? iosColor;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    if (onAndroid) return Material(type: MaterialType.transparency, child: Switch(value: value, onChanged: onChanged));
    return CupertinoSwitch(value: value, activeTrackColor: iosColor, inactiveTrackColor: look.wash2, onChanged: onChanged);
  }
}

// A text field's selection handles, its menu and its magnifier: Android's
// on Android (a CupertinoTextField otherwise has iOS's there too).
TextSelectionControls? get fieldHandles => onAndroid ? materialTextSelectionHandleControls : null;

Widget fieldMenu(BuildContext context, EditableTextState state) => onAndroid
    ? AdaptiveTextSelectionToolbar.editableText(editableTextState: state)
    : CupertinoAdaptiveTextSelectionToolbar.editableText(editableTextState: state);

// A text field's menu of [items], the platform's.
Widget menuOf(TextSelectionToolbarAnchors anchors, List<ContextMenuButtonItem> items) => onAndroid
    ? AdaptiveTextSelectionToolbar.buttonItems(anchors: anchors, buttonItems: items)
    : CupertinoAdaptiveTextSelectionToolbar.buttonItems(anchors: anchors, buttonItems: items);

TextMagnifierConfiguration? get fieldMagnifier => onAndroid ? TextMagnifier.adaptiveMagnifierConfiguration : null;

// A search field above a list: iOS's grey one; on Android the same field
// as a pill, with Material's search and clear icons.
class SearchField extends StatefulWidget {
  const SearchField({super.key, required this.controller, required this.placeholder, this.autofocus = false, this.onSubmitted});
  final TextEditingController controller;
  final String placeholder;
  final bool autofocus;
  final ValueChanged<String>? onSubmitted;

  @override
  State<SearchField> createState() => _SearchFieldState();
}

class _SearchFieldState extends State<SearchField> {
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_changed);
  }

  @override
  void didUpdateWidget(SearchField old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      old.controller.removeListener(_changed);
      widget.controller.addListener(_changed);
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_changed);
    super.dispose();
  }

  void _changed() => setState(() {});

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    if (!onAndroid) {
      return CupertinoSearchTextField(
        controller: widget.controller,
        autofocus: widget.autofocus,
        autocorrect: false,
        placeholder: widget.placeholder,
        style: look.text(size: 17),
        placeholderStyle: look.text(size: 17, color: look.ink3),
        backgroundColor: look.wash,
        borderRadius: BorderRadius.circular(11),
        itemColor: look.ink3,
        prefixInsets: const EdgeInsetsDirectional.fromSTEB(10, 0, 4, 0),
        onSubmitted: widget.onSubmitted,
      );
    }
    return CupertinoTextField(
      controller: widget.controller,
      autofocus: widget.autofocus,
      autocorrect: false,
      placeholder: widget.placeholder,
      textInputAction: TextInputAction.search,
      onSubmitted: widget.onSubmitted,
      style: look.text(size: 17),
      placeholderStyle: look.text(size: 17, color: look.ink3),
      padding: const EdgeInsets.symmetric(vertical: 11),
      decoration: BoxDecoration(color: look.wash, borderRadius: BorderRadius.circular(100)),
      prefix: Padding(padding: const EdgeInsetsDirectional.only(start: 14, end: 10), child: Icon(Icons.search, size: 22, color: look.ink2)),
      suffix: widget.controller.text.isEmpty
          ? const SizedBox(width: 14)
          : Material(
              type: MaterialType.transparency,
              child: IconButton(
                tooltip: 'Clear',
                onPressed: widget.controller.clear,
                icon: Icon(Icons.close, size: 22, color: look.ink2),
              ),
            ),
      selectionControls: fieldHandles,
      contextMenuBuilder: fieldMenu,
      magnifierConfiguration: fieldMagnifier,
    );
  }
}

// A button: CupertinoButton on iOS, which fades when pressed; on Android
// the same box, which ripples instead. Its parameters are
// CupertinoButton's, as used here.
class Press extends StatelessWidget {
  const Press({super.key, required this.onPressed, required this.child, this.padding, this.minimumSize, this.color, this.borderRadius, this.disabledColor}) : _filled = false;
  const Press.filled({super.key, required this.onPressed, required this.child, this.padding, this.minimumSize, this.color, this.borderRadius, this.disabledColor}) : _filled = true;
  final VoidCallback? onPressed;
  final Widget child;
  final EdgeInsetsGeometry? padding;
  final Size? minimumSize;
  final Color? color;
  final BorderRadius? borderRadius;
  final Color? disabledColor;
  final bool _filled;

  @override
  Widget build(BuildContext context) {
    if (!onAndroid) {
      return _filled
          ? CupertinoButton.filled(onPressed: onPressed, padding: padding, minimumSize: minimumSize, color: color, borderRadius: borderRadius, disabledColor: disabledColor ?? CupertinoColors.tertiarySystemFill, child: child)
          : CupertinoButton(onPressed: onPressed, padding: padding, minimumSize: minimumSize, color: color, borderRadius: borderRadius, disabledColor: disabledColor ?? CupertinoColors.quaternarySystemFill, child: child);
    }
    // CupertinoButton's box and defaults (its large size), drawn by
    // Material.
    final theme = CupertinoTheme.of(context);
    final enabled = onPressed != null;
    final background = color ?? (_filled ? theme.primaryColor : null);
    final fill = background == null
        ? null
        : enabled
            ? background
            : CupertinoDynamicColor.resolve(disabledColor ?? (_filled ? CupertinoColors.tertiarySystemFill : CupertinoColors.quaternarySystemFill), context);
    final foreground = _filled ? theme.primaryContrastingColor : enabled ? theme.primaryColor : CupertinoDynamicColor.resolve(CupertinoColors.tertiaryLabel, context);
    final textStyle = theme.textTheme.actionTextStyle.copyWith(color: foreground);
    final shape = RoundedRectangleBorder(borderRadius: borderRadius ?? const BorderRadius.all(Radius.circular(12)));
    return Semantics(
      button: true,
      enabled: enabled,
      child: ConstrainedBox(
        constraints: BoxConstraints(minWidth: minimumSize?.width ?? 44, minHeight: minimumSize?.height ?? 44),
        child: Material(
          type: fill == null ? MaterialType.transparency : MaterialType.canvas,
          color: fill,
          shape: shape,
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            customBorder: shape,
            onTap: onPressed,
            child: Padding(
              padding: padding ?? const EdgeInsets.symmetric(vertical: 16, horizontal: 20),
              child: Align(
                widthFactor: 1,
                heightFactor: 1,
                child: DefaultTextStyle(
                  style: textStyle,
                  child: IconTheme(data: IconTheme.of(context).copyWith(color: foreground, size: (textStyle.fontSize ?? 17) * 1.2), child: child),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
