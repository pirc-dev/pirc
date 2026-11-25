// The first screen of a build with PIRC_HOSTED, before any relay: PiRC's
// hosted relay, by signing up or by joining an account that is on another
// phone, or a relay of one's own, as every build offers.
import 'package:flutter/cupertino.dart';

import 'look.dart';

class HostedStartScreen extends StatefulWidget {
  const HostedStartScreen({super.key, required this.signUp, required this.joinPhone, required this.ownRelay});

  /// Makes the account; throws with what to tell the person.
  final Future<void> Function() signUp;

  /// Shows this phone's code, for the account's phone to add, once the
  /// relay is reached; throws with what to tell the person.
  final Future<void> Function() joinPhone;

  /// The join screen of a self-hosted relay.
  final VoidCallback ownRelay;

  @override
  State<HostedStartScreen> createState() => _HostedStartScreenState();
}

class _HostedStartScreenState extends State<HostedStartScreen> {
  var _busy = false;
  String? _error;

  // One at a time: a sign-up and a join never run together.
  Future<void> _run(Future<void> Function() step) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await step();
    } on Object catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return CupertinoPageScaffold(
      backgroundColor: look.page,
      child: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(28, 48, 28, 28),
          children: [
            Text('PiRC', textAlign: TextAlign.center, style: look.text(size: 34, weight: FontWeight.w700)),
            const SizedBox(height: 12),
            Text(
              "Control pi on your computers from this phone, through PiRC's relay. "
              'Everything between them is encrypted: the relay sees no session, prompt or reply.',
              textAlign: TextAlign.center,
              style: look.text(size: 16, color: look.secondary),
            ),
            const SizedBox(height: 32),
            CupertinoButton.filled(
              onPressed: _busy ? null : () => _run(widget.signUp),
              child: _busy ? const CupertinoActivityIndicator() : Text('Sign up', style: look.text(color: look.onAccent, weight: FontWeight.w600)),
            ),
            const SizedBox(height: 8),
            Text('No email and no password: this phone is the account.', textAlign: TextAlign.center, style: look.text(size: 13, color: look.secondary)),
            if (_error != null) Padding(padding: const EdgeInsets.only(top: 16), child: Text(_error!, textAlign: TextAlign.center, style: look.text(size: 15, color: look.failed))),
            const SizedBox(height: 28),
            CupertinoButton(
              onPressed: _busy ? null : () => _run(widget.joinPhone),
              child: Text('My account is on another phone', style: look.text(color: look.accent)),
            ),
            CupertinoButton(
              onPressed: _busy ? null : widget.ownRelay,
              child: Text('I run my own relay', style: look.text(color: look.accent)),
            ),
          ],
        ),
      ),
    );
  }
}
