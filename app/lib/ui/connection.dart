// The connection to the relay, across the top of every screen while it is
// not up, as the web app's banner (web.md, section 3): the list, a chat,
// Settings and both columns of the wide layout. What they show stays, but
// may be out of date, and what is sent then fails. Connecting shows only
// once it has taken a moment, so that coming back to the app, which
// reconnects, does not flash it; offline and refused show at once. Once
// shown it stays until the connection is up again, through the retries'
// turns between connecting and offline.
import 'dart:async';

import 'package:flutter/cupertino.dart';

import '../core/view.dart';
import 'look.dart';

// How long connecting may take before it is shown.
const connectingShownAfter = Duration(milliseconds: 1500);

// The words for a connection that is not up, or null when there is nothing
// to say (ready, or stopped by the app itself).
String? connectionText(RelayView relay) => switch (relay.state) {
      'connecting' => 'Connecting to the relay…',
      'offline' => 'Reconnecting to the relay${relay.reason == null ? '…' : ': ${relay.reason}'}',
      'refused' => 'The relay refused this phone${relay.reason == null ? '' : ': ${relay.reason}'}',
      _ => null,
    };

// child, under the connection's line while it shows. relay is read on every
// change of listenable; only a change of what it says redraws.
class ConnectionBanner extends StatefulWidget {
  const ConnectionBanner({super.key, required this.listenable, required this.relay, required this.child});
  final Listenable listenable;
  final RelayView Function() relay;
  final Widget child;

  @override
  State<ConnectionBanner> createState() => _ConnectionBannerState();
}

class _ConnectionBannerState extends State<ConnectionBanner> {
  late RelayView _relay = widget.relay();
  // Not up for long enough to say so, until it is up again.
  bool _shown = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    widget.listenable.addListener(_changed);
    _timing();
  }

  @override
  void didUpdateWidget(ConnectionBanner old) {
    super.didUpdateWidget(old);
    if (old.listenable != widget.listenable) {
      old.listenable.removeListener(_changed);
      widget.listenable.addListener(_changed);
      _changed();
    }
  }

  @override
  void dispose() {
    widget.listenable.removeListener(_changed);
    _timer?.cancel();
    super.dispose();
  }

  void _changed() {
    final now = widget.relay();
    if (now.state == _relay.state && now.reason == _relay.reason) return;
    setState(() => _relay = now);
    _timing();
  }

  // Up (or stopped by the app): nothing shown. Offline or refused: shown at
  // once. Connecting: shown after a moment, unless already shown.
  void _timing() {
    switch (_relay.state) {
      case 'ready' || 'stopped':
        _timer?.cancel();
        _timer = null;
        _shown = false;
      case 'connecting':
        if (_shown || _timer != null) return;
        _timer = Timer(connectingShownAfter, () {
          _timer = null;
          if (mounted) setState(() => _shown = true);
        });
      default:
        _timer?.cancel();
        _timer = null;
        _shown = true;
    }
  }

  @override
  Widget build(BuildContext context) {
    final text = _shown ? connectionText(_relay) : null;
    final look = Look.of(context);
    final refused = _relay.state == 'refused';
    final color = refused ? look.block : look.work;
    final media = MediaQuery.of(context);
    // The same shape with the line or without, so that the screens under it
    // (the navigator and its pages) are kept as it comes and goes.
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (text != null)
        Semantics(
          liveRegion: true,
          container: true,
          // The washes are see-through, made for the page: over it, as the
          // app's own background under them is black.
          child: ColoredBox(
            color: Color.alphaBlend(refused ? look.blockWash : look.workWash, look.page),
            child: Padding(
              padding: EdgeInsets.fromLTRB(16 + media.padding.left, media.padding.top + 8, 16 + media.padding.right, 8),
              child: Row(children: [
                // A still mark, its words saying what goes on: a line that
                // may stay a long while does not move.
                ExcludeSemantics(child: Text(refused ? '×' : '↻', style: look.text(size: 14, weight: FontWeight.w600, color: color))),
                const SizedBox(width: 10),
                Expanded(child: Text(text, style: look.text(size: 14, weight: FontWeight.w500, color: color, spacing: 0))),
              ]),
            ),
          ),
        ),
      // The screens under the line need no room for the status bar: the
      // line has taken it. They are a semantics container of their own: a
      // page route's barrier blocks the semantics painted before it in its
      // container (BlockSemantics), which would hide the line from screen
      // readers.
      Expanded(
        key: const ValueKey('screens'),
        child: Semantics(container: true, child: MediaQuery.removePadding(context: context, removeTop: text != null, child: widget.child)),
      ),
    ]);
  }
}
