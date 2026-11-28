// Tells a screen reader something without moving its focus. On Android, a
// live region that TalkBack reads when its words change, as Android would
// have it (its announcements are deprecated); on iOS, an announcement,
// since VoiceOver moves its focus to a live region that changes.
import 'package:flutter/semantics.dart';
import 'package:flutter/widgets.dart';

import 'adaptive.dart';

class Herald extends StatefulWidget {
  const Herald({super.key, required this.child});
  final Widget child;

  static HeraldState? of(BuildContext context) => context.findAncestorStateOfType<HeraldState>();

  @override
  State<Herald> createState() => HeraldState();
}

class HeraldState extends State<Herald> {
  var _words = '';

  // Said once: the same words again are said again.
  void say(String text) {
    if (text.trim().isEmpty || !mounted) return;
    if (!onAndroid) {
      SemanticsService.sendAnnouncement(View.of(context), text, Directionality.of(context));
      return;
    }
    setState(() => _words = _words == text ? '$text ' : text);
  }

  @override
  Widget build(BuildContext context) => Stack(children: [
        widget.child,
        if (onAndroid) Positioned(left: 0, top: 0, width: 1, height: 1, child: Semantics(liveRegion: true, label: _words, child: const SizedBox.shrink())),
      ]);
}
