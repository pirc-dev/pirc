// The paywall (docs/design.md, step 15, Price): in place of everything
// else while the store does not allow this phone, before joining too. It
// offers the store's free trial where the account can still have it, the
// subscription otherwise, says when a payment has failed or a purchase
// waits for approval, and restores. The store's own sheet takes the
// payment; its terms are stated before it opens, as Apple asks. A phone not
// yet joined may join from here, which on the review relay is the way past
// it for the stores' reviewers.
import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../app/store.dart';
import 'look.dart';

const termsUrl = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';
const privacyUrl = 'https://pirc.dev/privacy/';

// How long the store's answer is waited for with the app in front of the
// person, its own sheets closed: StoreKit's purchase has been seen not to
// answer at all after them (TestFlight build 7), though it went through.
// Then the paywall is as it was, with the store asked again on coming to
// the front and when it says something changed, which lets the phone in.
const storeWait = Duration(seconds: 30);

class PaywallScreen extends StatefulWidget {
  const PaywallScreen({
    super.key,
    required this.access,
    required this.product,
    required this.buy,
    required this.restore,
    required this.manage,
    required this.retry,
    this.waiting = false,
    this.storeName = 'App Store',
    this.theStore = 'the App Store',
    this.accountName = 'Apple Account',
    this.showTerms = true,
    this.manageWhenEnded = false,
    this.join,
  });

  // What the store said: ended, a payment problem or never.
  final Access access;
  // The product as the store shows it; null while it has not answered.
  final StoreProduct? product;
  final Future<Bought> Function() buy;
  final Future<void> Function() restore;
  final Future<void> Function() manage;
  // Asks the store again, as when it could not be reached.
  final Future<void> Function() retry;
  // A purchase waits for approval (Ask to Buy, or the bank's own check).
  final bool waiting;
  final String storeName;
  // As a sentence names it: "the App Store", but "Google Play".
  final String theStore;
  final String accountName;
  // Apple's standard licence; Play has none (the Play build links only the
  // privacy policy).
  final bool showTerms;
  // The store's page when the subscription has ended, as on Play, which
  // does not tell the phone why (a payment failed, or it was cancelled).
  final bool manageWhenEnded;
  // The join screen, on a phone that has not joined; null once it has.
  final VoidCallback? join;

  @override
  State<PaywallScreen> createState() => _PaywallScreenState();
}

class _PaywallScreenState extends State<PaywallScreen> with WidgetsBindingObserver {
  var _busy = false;
  String? _error;
  // Said after a restore that found nothing, which leaves the paywall up.
  String? _note;
  // Each action, so that only the latest says how it ended.
  var _action = 0;
  // Waiting in front of the person, for no longer than storeWait.
  Timer? _wait;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _wait?.cancel();
    super.dispose();
  }

  // The store's sheets (its password prompts, Play's purchase) take the
  // app from the front, and the wait starts again when they close.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (!_busy) return;
    if (state == AppLifecycleState.resumed) {
      _waitInFront();
    } else {
      _wait?.cancel();
    }
  }

  void _waitInFront() {
    _wait?.cancel();
    _wait = Timer(storeWait, () {
      if (mounted) setState(() => _busy = false);
    });
  }

  // [done]: what to say when it ends with the paywall still up.
  Future<void> _do(Future<void> Function() action, {String? done}) async {
    final mine = ++_action;
    setState(() {
      _busy = true;
      _error = null;
      _note = null;
    });
    final front = WidgetsBinding.instance.lifecycleState;
    if (front == null || front == AppLifecycleState.resumed) _waitInFront();
    try {
      await action();
      if (mounted && mine == _action && done != null) setState(() => _note = done);
    } on PlatformException catch (e) {
      if (mounted && mine == _action) {
        setState(() => _error = switch (e.code) {
          'notAllowed' => 'Purchases are turned off on this phone, in Screen Time.',
          'unavailable' => "Google Play isn't available. Check that the Play Store is signed in to your account.",
          'network' => "Can't reach ${widget.theStore}. Check the connection and try again.",
          _ => "${_capital(widget.theStore)} couldn't do that. Try again.",
        });
      }
    } finally {
      if (mounted && mine == _action) {
        _wait?.cancel();
        setState(() => _busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final product = widget.product;
    final trial = product?.trial;
    final length = trial == null ? null : _length(trial);
    final payment = widget.access == Access.payment;
    final String title;
    final String button;
    if (widget.waiting) {
      title = 'Waiting for approval';
      button = 'Check again';
    } else if (payment) {
      title = "There's a problem with your payment";
      button = 'Fix payment';
    } else if (widget.access == Access.ended) {
      title = 'Your subscription has ended';
      button = 'Subscribe';
    } else if (length != null) {
      title = 'Start your ${length.adjective} free trial';
      button = 'Start free trial';
    } else {
      title = 'Subscribe to PiRC';
      button = 'Subscribe';
    }
    final price = product?.price;
    final String small;
    if (widget.waiting) {
      small = 'The purchase is waiting for someone to approve it. PiRC opens once it is approved.';
    } else if (payment) {
      small = '${_capital(widget.theStore)} could not take the last payment. Update your payment details to keep using PiRC.';
    } else if (price == null) {
      small = "Can't reach ${widget.theStore} for the price.";
    } else if (length != null && widget.access == Access.never) {
      small = 'Free for ${length.noun}, then $price a year. Renews every year until cancelled. '
          'Cancel at any time in your ${widget.storeName} settings; cancelled at least a day before the trial ends, it costs nothing.';
    } else {
      small = '$price a year. Renews every year until cancelled. Cancel at any time in your ${widget.storeName} settings.';
    }
    final Future<void> Function()? primary = _busy
        ? null
        : widget.waiting
            ? widget.retry
            : payment
                ? widget.manage
                : price == null
                    ? widget.retry
                    : () async {
                        await widget.buy();
                      };
    // The amount billed, under the title and as large as anything but it.
    final String? billed = price == null || widget.waiting || payment ? null : length != null && widget.access == Access.never ? 'Then $price a year' : '$price a year';
    return CupertinoPageScaffold(
      backgroundColor: look.page,
      child: SafeArea(
        // A tablet's width would run the text into long lines.
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(24, 48, 24, 24),
              children: [
                Center(
                  child: Container(
                    width: 72,
                    height: 72,
                    decoration: BoxDecoration(color: look.accentSoft, shape: BoxShape.circle),
                    child: Icon(payment ? CupertinoIcons.creditcard : CupertinoIcons.device_phone_portrait, size: 34, color: look.accent),
                  ),
                ),
                const SizedBox(height: 20),
                Semantics(header: true, child: Text(title, textAlign: TextAlign.center, style: look.text(size: 28, weight: FontWeight.w700))),
                if (billed != null) ...[
                  const SizedBox(height: 6),
                  Text(billed, textAlign: TextAlign.center, style: look.text(size: 22, weight: FontWeight.w600)),
                ],
                const SizedBox(height: 10),
                Text(
                  'Follow your pi sessions from your phone, answer when they ask, and start new ones, on every host your relay reaches.',
                  textAlign: TextAlign.center,
                  style: look.text(size: 15, color: look.secondary),
                ),
                const SizedBox(height: 28),
                // Waiting, still in its colour and saying what it does, with
                // a spinner beside: not the dim fill of a disabled button,
                // nearly black in dark mode.
                CupertinoButton.filled(
                  onPressed: primary == null ? null : () => _do(primary),
                  disabledColor: look.accent,
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    if (_busy) ...[CupertinoActivityIndicator(color: look.onAccent, radius: 9), const SizedBox(width: 10)],
                    Text(price == null && !widget.waiting && !payment ? 'Try again' : button, style: look.text(color: look.onAccent, weight: FontWeight.w600)),
                  ]),
                ),
                const SizedBox(height: 14),
                Text(small, textAlign: TextAlign.center, style: look.text(size: 13, color: look.secondary)),
                if (widget.waiting) ...[
                  const SizedBox(height: 4),
                  CupertinoButton(
                    onPressed: _busy ? null : () => _do(() async => widget.buy()),
                    child: Text('Ask again', style: look.text(color: look.accent)),
                  ),
                ],
                if (widget.manageWhenEnded && widget.access == Access.ended && !widget.waiting) ...[
                  const SizedBox(height: 4),
                  CupertinoButton(
                    onPressed: _busy ? null : () => _do(widget.manage),
                    child: Text('Manage subscription', style: look.text(color: look.accent)),
                  ),
                ],
                if (_error != null || _note != null) ...[
                  const SizedBox(height: 10),
                  Text(_error ?? _note!, textAlign: TextAlign.center, style: look.text(size: 15, color: _error != null ? look.failed : look.secondary)),
                ],
                const SizedBox(height: 10),
                CupertinoButton(
                  onPressed: _busy
                      ? null
                      : () => _do(widget.restore, done: 'No subscription to restore on this ${widget.accountName}.'),
                  child: Text('Restore purchases', style: look.text(color: look.accent)),
                ),
                if (widget.join != null)
                  CupertinoButton(
                    onPressed: _busy ? null : widget.join,
                    child: Text('Join with a link', style: look.text(color: look.accent)),
                  ),
                Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  if (widget.showTerms) _Link(label: 'Terms of Use', url: termsUrl),
                  _Link(label: 'Privacy Policy', url: privacyUrl),
                ]),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

String _capital(String s) => s[0].toUpperCase() + s.substring(1);

// The trial's length as the title and the terms say it: weeks in days
// ("14-day", "14 days"), months and years in their own.
({String adjective, String noun}) _length(TrialLength t) {
  final (n, unit) = t.unit == 'week' ? (t.count * 7, 'day') : (t.count, t.unit);
  return (adjective: '$n-$unit', noun: '$n $unit${n == 1 ? '' : 's'}');
}

class _Link extends StatelessWidget {
  const _Link({required this.label, required this.url});
  final String label;
  final String url;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return CupertinoButton(
      padding: const EdgeInsets.symmetric(horizontal: 10),
      onPressed: () => launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication),
      child: Text(label, style: look.text(size: 13, color: look.accent)),
    );
  }
}
