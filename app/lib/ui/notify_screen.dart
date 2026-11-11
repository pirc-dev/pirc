// What notifications are for, said once before the system asks for them,
// after joining: written on this phone, so that the push services in the
// way learn only that something happened.
import 'package:flutter/cupertino.dart';

import 'look.dart';

class NotifyScreen extends StatelessWidget {
  const NotifyScreen({super.key, required this.allow, required this.later});

  // On to the system's prompt; and not now.
  final VoidCallback allow;
  final VoidCallback later;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return CupertinoPageScaffold(
      backgroundColor: look.page,
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32),
          child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
            Icon(CupertinoIcons.bell, size: 56, color: look.accent),
            const SizedBox(height: 20),
            Text('Notifications', textAlign: TextAlign.center, style: look.text(size: 24, weight: FontWeight.w700)),
            const SizedBox(height: 12),
            Text(
              'PiRC tells you when a session finishes, fails or asks you something. '
              'The notification is written on this phone: Apple, Google and PiRC’s push service only learn that something happened, never what.',
              textAlign: TextAlign.center,
              style: look.text(size: 16, color: look.ink2, height: 1.45),
            ),
            const SizedBox(height: 28),
            CupertinoButton.filled(onPressed: allow, child: Text('Continue', style: look.text(color: look.onAccent, weight: FontWeight.w600))),
            const SizedBox(height: 8),
            CupertinoButton(onPressed: later, child: Text('Not now', style: look.text(color: look.accent))),
          ]),
        ),
      ),
    );
  }
}
