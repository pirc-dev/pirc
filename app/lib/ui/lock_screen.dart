// While the main key is not unlocked: Face ID, a fingerprint or the PIN
// releases it (docs/design.md, section 12, step 13).
import 'package:flutter/cupertino.dart';

import 'look.dart';
import 'adaptive.dart';

class LockScreen extends StatelessWidget {
  const LockScreen({super.key, required this.unlock, this.error, this.reset});

  final VoidCallback unlock;
  final String? error;
  // What is kept cannot be opened: starting again, which forgets it.
  final VoidCallback? reset;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return CupertinoPageScaffold(
      backgroundColor: look.page,
      child: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(CupertinoIcons.lock_fill, size: 44, color: look.secondary),
                const SizedBox(height: 16),
                Text('PiRC is locked', style: look.text(size: 22, weight: FontWeight.w600)),
                const SizedBox(height: 8),
                Text('Unlock to see your sessions.', style: look.text(size: 15, color: look.secondary)),
                const SizedBox(height: 24),
                Press.filled(onPressed: unlock, child: Text('Unlock', style: look.text(color: look.onAccent, weight: FontWeight.w600))),
                if (error != null) Padding(padding: const EdgeInsets.only(top: 16), child: Text(error!, textAlign: TextAlign.center, style: look.text(size: 15, color: look.failed))),
                if (reset != null)
                  Press(onPressed: reset, child: Text('Start again on this phone', style: look.text(color: look.failed))),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
