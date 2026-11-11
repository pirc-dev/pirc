// Adding a host or an app (docs/design.md, 5.3), as the web page's
// Invite.tsx: a one-time token from the relay, shown once and kept nowhere
// but this sheet's state, gone when it closes. A host's as the /pirc enrol
// line to run in its pi; an app's as a pirc://join link and its QR code,
// for another phone to scan.
import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';
import 'package:qr/qr.dart';

import '../app/model.dart';
import 'look.dart';
import 'sheet.dart';

// The link an app joins by, as the web page's joinLink and join.dart read it.
String joinLink(String relay, String token) => 'pirc://join?relay=${Uri.encodeComponent(relay)}&token=${Uri.encodeComponent(token)}';

// Keeps the screen out of the app switcher's snapshot and screenshots, or
// lets it back: Android's FLAG_SECURE, and on iOS a cover as the app goes
// inactive.
Future<void> secureScreen(bool on, {MethodChannel channel = const MethodChannel('dev.pirc.app/screen')}) => channel.invokeMethod('secure', {'on': on});

// Copies a secret: on this phone only, gone from the clipboard when it
// expires, and on Android marked sensitive, so that its preview hides it.
Future<void> copySecret(String text, {int? expiresAt, MethodChannel channel = const MethodChannel('dev.pirc.app/clipboard')}) =>
    channel.invokeMethod('copySecret', {'text': text, 'expiresAt': ?expiresAt});

class InviteSheet extends StatefulWidget {
  const InviteSheet({super.key, required this.model, required this.relay, required this.role, this.copy = copySecret, this.secure = secureScreen});
  final PircModel model;
  // The relay's address, as this phone joined it.
  final String relay;
  // "host" or "client".
  final String role;
  final Future<void> Function(String text, {int? expiresAt}) copy;
  final Future<void> Function(bool on) secure;

  @override
  State<InviteSheet> createState() => _InviteSheetState();
}

class _InviteSheetState extends State<InviteSheet> {
  final _label = TextEditingController();
  var _busy = false;
  String? _error;
  // The token made, and when it expires (0: the relay did not say); only
  // here.
  ({String token, int expiresAt})? _made;
  Timer? _tick;
  // Copy, Copied or why it could not.
  String _copied = 'Copy';
  Timer? _copiedTimer;
  // Whether the screen is kept out of snapshots: while a token shows.
  var _secured = false;

  bool get _host => widget.role == 'host';

  void _secure(bool on) {
    if (on == _secured) return;
    _secured = on;
    widget.secure(on).catchError((_) {});
  }

  @override
  void dispose() {
    // Closed, by Done, a swipe or a relock: the screen as it was.
    _secure(false);
    _tick?.cancel();
    _copiedTimer?.cancel();
    _label.dispose();
    super.dispose();
  }

  Future<void> _make() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await widget.model.client.issueToken(widget.role, _label.text.trim());
      if (!mounted) return;
      if (!r.ok || r.token == null) return setState(() => _error = r.ok ? 'The relay gave no token.' : r.message);
      final made = _made = (token: r.token!, expiresAt: r.expiresAt ?? 0);
      _secure(true);
      setState(() {});
      // Its end, as it comes; then nothing more to show, or to hide.
      if (made.expiresAt > 0) {
        _tick = Timer.periodic(const Duration(seconds: 1), (t) {
          if (widget.model.now() >= made.expiresAt) {
            t.cancel();
            _secure(false);
          }
          setState(() {});
        });
      }
    } on Object catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _copy(String text, int expiresAt) async {
    String said;
    try {
      await widget.copy(text, expiresAt: expiresAt > 0 ? expiresAt : null);
      said = 'Copied';
    } on Object {
      said = 'Could not copy';
    }
    if (!mounted) return;
    setState(() => _copied = said);
    _copiedTimer?.cancel();
    _copiedTimer = Timer(const Duration(milliseconds: 1500), () {
      if (mounted) setState(() => _copied = 'Copy');
    });
  }

  @override
  Widget build(BuildContext context) {
    final made = _made;
    return made == null ? _ask(context) : _token(context, made);
  }

  Widget _ask(BuildContext context) {
    final look = Look.of(context);
    return Sheet(title: _host ? 'Add a host' : 'Add an app', sub: 'With a one-time token, valid for 15 minutes', children: [
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 14, children: [
          SheetText([
            TextSpan(
                text: _host
                    ? 'A computer running pi, whose sessions then show here. You run a line in its pi; nobody needs to compare keys.'
                    : "PiRC's app on a phone, which scans a code to join. It can then see and run every session, as this one can."),
          ]),
          Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 4, children: [
            Text('Name', style: look.text(size: 13, color: look.ink2, spacing: 0)),
            CupertinoTextField(
              controller: _label,
              maxLength: 128,
              placeholder: 'Its own, if left empty',
              autocorrect: false,
              enableSuggestions: false,
              textCapitalization: TextCapitalization.none,
              textInputAction: TextInputAction.go,
              onSubmitted: (_) => _make(),
              style: look.text(size: 16, spacing: 0),
              placeholderStyle: look.text(size: 16, color: look.ink3, spacing: 0),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
              decoration: BoxDecoration(color: look.sheetCard, borderRadius: BorderRadius.circular(12), border: Border.all(color: look.rule)),
            ),
          ]),
          if (_error != null) Semantics(liveRegion: true, child: Text(_error!, style: look.text(size: 14, color: look.block, spacing: 0))),
          Answers(cancel: () => Navigator.of(context).maybePop(), label: _busy ? '…' : 'Make a token', disabled: _busy, go: _make),
        ]),
      ),
    ]);
  }

  Widget _token(BuildContext context, ({String token, int expiresAt}) made) {
    final look = Look.of(context);
    final expired = made.expiresAt > 0 && widget.model.now() >= made.expiresAt;
    final end = DateTime.fromMillisecondsSinceEpoch(made.expiresAt);
    // In the phone's 12- or 24-hour clock, as the web page's.
    final mm = end.minute.toString().padLeft(2, '0');
    final until = MediaQuery.alwaysUse24HourFormatOf(context) ? '${end.hour}:$mm' : '${(end.hour + 11) % 12 + 1}:$mm ${end.hour < 12 ? 'AM' : 'PM'}';
    final text = _host ? '/pirc enrol ${widget.relay} ${made.token}' : joinLink(widget.relay, made.token);
    return Sheet(title: _host ? 'Add a host' : 'Add an app', sub: expired
            ? 'The token has expired'
            : made.expiresAt > 0
                ? 'Valid until $until, for one ${_host ? 'host' : 'app'}'
                : 'For one ${_host ? 'host' : 'app'}', children: [
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 14, children: [
          if (expired)
            const SheetText([TextSpan(text: 'Nothing joined with it in time. Make another when it is at hand.')])
          else ...[
            SheetText([
              TextSpan(
                  text: _host
                      ? 'In pi on that computer, run this line. It joins at once and shows in the list.'
                      : "On the phone, scan this with PiRC's app, or open the link there. It joins at once and shows in the list."),
            ]),
            if (!_host) Center(child: QrView(text, size: 256)),
            Container(
              padding: const EdgeInsets.fromLTRB(14, 4, 4, 4),
              decoration: BoxDecoration(color: look.wash, borderRadius: BorderRadius.circular(10)),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Expanded(child: Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Text(text, style: look.mono(size: 13, color: look.ink).copyWith(height: 1.6)))),
                Semantics(
                  button: true,
                  label: _copied == 'Copy' ? (_host ? 'Copy the line' : 'Copy the link') : _copied,
                  liveRegion: true,
                  excludeSemantics: true,
                  onTap: () => _copy(text, made.expiresAt),
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: () => _copy(text, made.expiresAt),
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minWidth: 44, minHeight: 36),
                      child: Center(
                        child: Text(_copied, style: look.text(size: 12.5, weight: FontWeight.w500, color: _copied == 'Could not copy' ? look.block : look.ink3, spacing: 0)),
                      ),
                    ),
                  ),
                ),
              ]),
            ),
            Text('Shown once: closing this forgets it. Anyone with it can join until it is used.', style: look.text(size: 13, color: look.ink3, spacing: 0)),
          ],
          Semantics(
            button: true,
            child: GestureDetector(
              onTap: () => Navigator.of(context).maybePop(),
              child: Container(
                height: 52,
                alignment: Alignment.center,
                decoration: BoxDecoration(color: look.ink, borderRadius: BorderRadius.circular(26)),
                child: Text('Done', style: look.text(size: 15.5, weight: FontWeight.w600, color: look.page, spacing: 0)),
              ),
            ),
          ),
        ]),
      ),
    ]);
  }
}

// A QR code, dark on white whatever the look, with the quiet zone scanners
// need, as the web page's; encoded once for its text.
class QrView extends StatefulWidget {
  const QrView(this.text, {super.key, this.size = 256});
  final String text;
  final double size;

  @override
  State<QrView> createState() => _QrViewState();
}

class _QrViewState extends State<QrView> {
  late QrImage _image = _encode();

  QrImage _encode() => QrImage(QrCode(payload: QrPayload.fromString(widget.text), errorCorrectLevel: QrErrorCorrectLevel.medium));

  @override
  void didUpdateWidget(QrView old) {
    super.didUpdateWidget(old);
    if (old.text != widget.text) _image = _encode();
  }

  @override
  Widget build(BuildContext context) {
    final image = _image;
    final size = widget.size;
    return Semantics(
      image: true,
      label: 'QR code of the link',
      child: ClipRRect(
        borderRadius: BorderRadius.circular(12),
        child: CustomPaint(size: Size.square(size), painter: _QrPainter(image)),
      ),
    );
  }
}

class _QrPainter extends CustomPainter {
  _QrPainter(this.image);
  final QrImage image;
  // Modules of white around it.
  static const border = 4;

  @override
  void paint(Canvas canvas, Size size) {
    final n = image.moduleCount + 2 * border;
    final cell = size.width / n;
    canvas.drawRect(Offset.zero & size, Paint()..color = const Color(0xffffffff));
    final dark = Paint()
      ..color = const Color(0xff000000)
      ..isAntiAlias = false;
    for (var y = 0; y < image.moduleCount; y++) {
      for (var x = 0; x < image.moduleCount; x++) {
        if (image.isDark(y, x)) canvas.drawRect(Rect.fromLTWH((x + border) * cell, (y + border) * cell, cell + 0.01, cell + 0.01), dark);
      }
    }
  }

  @override
  bool shouldRepaint(_QrPainter old) => old.image != image;
}
