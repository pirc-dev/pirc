// Joining a relay: a QR code or a pirc://join link from another client's
// "Add an app" (docs/web.md, section 5), scanned here, pasted, or opened
// from outside the app.
import 'package:flutter/cupertino.dart';

import '../join.dart';
import 'look.dart';

class JoinScreen extends StatefulWidget {
  const JoinScreen({super.key, required this.join, this.scan, this.incoming, this.back});

  // Joins with the link; throws JoinFailed with what to tell the person.
  final Future<void> Function(JoinLink link) join;
  // Opens the camera for a QR code; null where there is none.
  final Future<String?> Function()? scan;
  // A link opened from outside the app (lib/app/links.dart): put in the
  // field, to be joined with a tap, and taken from here; one that comes
  // while joining waits for the outcome.
  final ValueNotifier<String?>? incoming;
  // Back to the paywall, where it was opened from; none when it is the
  // app's first screen.
  final VoidCallback? back;

  @override
  State<JoinScreen> createState() => _JoinScreenState();
}

class _JoinScreenState extends State<JoinScreen> {
  final _link = TextEditingController();
  var _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final link = widget.incoming?.value;
    if (link != null) {
      widget.incoming!.value = null;
      _link.text = link;
    }
    widget.incoming?.addListener(_incoming);
  }

  @override
  void dispose() {
    widget.incoming?.removeListener(_incoming);
    _link.dispose();
    super.dispose();
  }

  void _incoming() {
    final link = widget.incoming?.value;
    if (link == null || _busy) return;
    widget.incoming!.value = null;
    setState(() {
      _link.text = link;
      _error = null;
    });
  }

  Future<void> _go(String text) async {
    final link = parseJoinLink(text);
    if (link == null) {
      setState(() => _error = 'That is not a PiRC join link. It starts with pirc://join.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.join(link);
    } on JoinFailed catch (e) {
      if (mounted) setState(() => _error = e.reason);
    } finally {
      if (mounted) {
        setState(() => _busy = false);
        _incoming();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final back = widget.back;
    final page = CupertinoPageScaffold(
      backgroundColor: look.page,
      child: SafeArea(
        child: ListView(
          padding: EdgeInsets.fromLTRB(24, back == null ? 48 : 4, 24, 24),
          children: [
            if (back != null)
              Align(
                alignment: Alignment.centerLeft,
                child: CupertinoButton(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  minimumSize: const Size(44, 44),
                  onPressed: _busy ? null : back,
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    Icon(CupertinoIcons.chevron_back, size: 22, color: look.accent),
                    Text('Back', style: look.text(color: look.accent)),
                  ]),
                ),
              ),
            Center(
              child: Container(
                width: 72,
                height: 72,
                decoration: BoxDecoration(color: look.accentSoft, shape: BoxShape.circle),
                child: Icon(CupertinoIcons.link, size: 34, color: look.accent),
              ),
            ),
            const SizedBox(height: 20),
            Text('Add this phone', textAlign: TextAlign.center, style: look.text(size: 28, weight: FontWeight.w700)),
            const SizedBox(height: 10),
            Text(
              'In the PiRC web app, or on a phone that\'s already set up, open Settings and tap "Add an app" under Clients. '
              'Then scan the code it shows, or paste its link below. This phone makes its own key, which never leaves it.',
              textAlign: TextAlign.center,
              style: look.text(size: 15, color: look.secondary),
            ),
            const SizedBox(height: 28),
            if (widget.scan != null) ...[
              CupertinoButton.filled(
                onPressed: _busy
                    ? null
                    : () async {
                        final text = await widget.scan!();
                        if (text != null) await _go(text);
                      },
                child: Text('Scan the code', style: look.text(color: look.onAccent, weight: FontWeight.w600)),
              ),
              const SizedBox(height: 20),
            ],
            CupertinoTextField(
              controller: _link,
              placeholder: 'pirc://join?…',
              placeholderStyle: look.text(color: look.secondary),
              style: look.text(),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: look.card, borderRadius: BorderRadius.circular(10)),
              autocorrect: false,
              enabled: !_busy,
            ),
            const SizedBox(height: 10),
            CupertinoButton(
              onPressed: _busy ? null : () => _go(_link.text),
              child: _busy ? const CupertinoActivityIndicator() : Text('Join with the link', style: look.text(color: look.accent)),
            ),
            if (_error != null) Text(_error!, textAlign: TextAlign.center, style: look.text(size: 15, color: look.failed)),
          ],
        ),
      ),
    );
    if (back == null) return page;
    // Android's back too, here the app's first screen.
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (popped, _) {
        if (!popped && !_busy) back();
      },
      child: page,
    );
  }
}
