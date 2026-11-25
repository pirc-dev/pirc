// A hosted account's life (docs/design.md, step 14, stage 5, D1): its
// subscriptions as the relay last heard them from the stores, a renewal
// offered only when none will carry the account on, the locked account's
// screen, and deleting the account from the account's phone.
//
// The other platform's store is named only for a subscription the account
// has there: a new user, or a store's reviewer, reads nothing of it.
import 'package:fixnum/fixnum.dart';
import 'package:flutter/cupertino.dart';

import '../gen/pirc/v1alpha2/relay.pb.dart';
import 'look.dart';

/// What the screens do with the account's life, as the app gives it.
abstract interface class HostedAccountControls {
  /// The account's subscriptions, as the relay last said them.
  List<AccountSubscription> get subscriptions;

  /// Whether this phone is the account's phone, which alone deletes it.
  bool get isPhone;

  /// This phone's store, as the screens name it: "the App Store" or
  /// "Google Play"; null in a build without one.
  String? get storeName;

  /// Buys or renews through this phone's store; why not, or null once
  /// the relay has it.
  Future<String?> renew();

  /// Deletes the account; why not, or null once deleted.
  Future<String?> deleteAccount();
}

const _week = Duration(days: 7);

String _storeOf(SubscriptionStore s) => switch (s) {
      SubscriptionStore.SUBSCRIPTION_STORE_APP_STORE => 'the App Store',
      SubscriptionStore.SUBSCRIPTION_STORE_GOOGLE_PLAY => 'Google Play',
      SubscriptionStore.SUBSCRIPTION_STORE_TEST => 'the test store',
      _ => 'a store',
    };

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

String _date(DateTime d) {
  final l = d.toLocal();
  return '${l.day} ${_months[l.month - 1]} ${l.year}';
}

DateTime? _ends(AccountSubscription s) => s.hasEnds() ? DateTime.fromMillisecondsSinceEpoch((s.ends.seconds * Int64(1000)).toInt(), isUtc: true) : null;

/// Whether a subscription still carries the account at [now].
bool live(AccountSubscription s, DateTime now) {
  if (s.lapsed) return false;
  final e = _ends(s);
  return e == null || e.isAfter(now);
}

/// One line for each subscription the account has: who pays and until when.
List<String> subscriptionLines(List<AccountSubscription> subs, DateTime now) => [
      for (final s in subs)
        if (live(s, now))
          '${s.trial ? 'Free trial' : 'Paid'} through ${_storeOf(s.store)}${_ends(s) == null ? '' : ' until ${_date(_ends(s)!)}'}${s.renews ? ', renewing' : ''}'
        else
          'Ended through ${_storeOf(s.store)}${_ends(s) == null ? '' : ' on ${_date(_ends(s)!)}'}',
    ];

/// Whether to offer a purchase: no subscription carries the account on, or
/// every one that does ends within a week and will not renew, so that no
/// one pays twice.
bool offerPurchase(List<AccountSubscription> subs, DateTime now) {
  final carrying = subs.where((s) => live(s, now));
  if (carrying.isEmpty) return true;
  return carrying.every((s) => !s.renews && (_ends(s)?.isBefore(now.add(_week)) ?? false));
}

/// Asks before deleting, saying what it does and what it does not.
Future<bool> confirmDelete(BuildContext context, String? storeName) async =>
    await showCupertinoDialog<bool>(
      context: context,
      builder: (context) => CupertinoAlertDialog(
        title: const Text('Delete this account?'),
        content: Text('The relay deletes the account and everything it holds of it, and every computer, phone and browser on it stops reaching the others. '
            'Your sessions stay on your computers. This cannot be undone.'
            '${storeName == null ? '' : ' It does not cancel your subscription: cancel it in $storeName.'}'),
        actions: [
          CupertinoDialogAction(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          CupertinoDialogAction(isDestructiveAction: true, onPressed: () => Navigator.of(context).pop(true), child: const Text('Delete')),
        ],
      ),
    ) ??
    false;

/// A button that runs a step, says its failure, and runs one at a time.
class _Step extends StatefulWidget {
  const _Step({required this.label, required this.run, this.filled = false, this.danger = false, this.confirm});
  final String label;
  final Future<String?> Function() run;
  final bool filled;
  final bool danger;
  final Future<bool> Function(BuildContext context)? confirm;

  @override
  State<_Step> createState() => _StepState();
}

class _StepState extends State<_Step> {
  var _busy = false;
  String? _error;

  Future<void> _go() async {
    if (_busy) return;
    if (widget.confirm != null && !await widget.confirm!(context)) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final error = await widget.run();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final text = Text(widget.label, style: look.text(color: widget.filled ? look.onAccent : widget.danger ? look.failed : look.accent, weight: widget.filled ? FontWeight.w600 : FontWeight.w400));
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      widget.filled
          ? CupertinoButton.filled(onPressed: _busy ? null : _go, child: _busy ? CupertinoActivityIndicator(color: look.onAccent) : text)
          : CupertinoButton(onPressed: _busy ? null : _go, child: _busy ? const CupertinoActivityIndicator() : text),
      if (_error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error!, textAlign: TextAlign.center, style: look.text(size: 14, color: look.failed))),
    ]);
  }
}

/// The account locked: every subscription has lapsed. Only renewing, or
/// deleting from the account's phone, is left.
class LockedAccountScreen extends StatelessWidget {
  const LockedAccountScreen({super.key, required this.controls, this.now});
  final HostedAccountControls controls;
  final DateTime Function()? now;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final at = (now ?? DateTime.now)();
    final store = controls.storeName;
    return CupertinoPageScaffold(
      backgroundColor: look.page,
      child: SafeArea(
        child: ListView(padding: const EdgeInsets.fromLTRB(28, 48, 28, 28), children: [
          Icon(CupertinoIcons.lock_fill, size: 44, color: look.secondary),
          const SizedBox(height: 16),
          Text('This account is locked', textAlign: TextAlign.center, style: look.text(size: 22, weight: FontWeight.w600)),
          const SizedBox(height: 8),
          Text(
            'Its subscription has ended. Renew it to use PiRC again: its computers, phones and browsers come back as they were. '
            'A locked account is deleted 60 days after it locked.',
            textAlign: TextAlign.center,
            style: look.text(size: 15, color: look.secondary),
          ),
          for (final l in subscriptionLines(controls.subscriptions, at))
            Padding(padding: const EdgeInsets.only(top: 8), child: Text(l, textAlign: TextAlign.center, style: look.text(size: 14, color: look.ink2))),
          const SizedBox(height: 24),
          if (store != null)
            _Step(label: 'Renew through $store', run: controls.renew, filled: true)
          else
            Text('Renew it on a phone with PiRC from its store.', textAlign: TextAlign.center, style: look.text(size: 15, color: look.secondary)),
          if (controls.isPhone) ...[
            const SizedBox(height: 16),
            _Step(label: 'Delete this account', run: controls.deleteAccount, danger: true, confirm: (c) => confirmDelete(c, store)),
          ],
        ]),
      ),
    );
  }
}

/// Settings' rows for the account: its subscriptions, a purchase when none
/// carries it on, and deleting it from the account's phone.
class HostedAccountRows extends StatelessWidget {
  const HostedAccountRows({super.key, required this.controls, this.now});
  final HostedAccountControls controls;
  final DateTime Function()? now;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final at = (now ?? DateTime.now)();
    final subs = controls.subscriptions;
    final store = controls.storeName;
    final lines = subscriptionLines(subs, at);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (lines.isEmpty) Text('No subscription yet.', style: look.text(size: 15, color: look.ink2, spacing: 0)),
        for (final l in lines) Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Text(l, style: look.text(size: 15, spacing: 0))),
        if (store != null && offerPurchase(subs, at)) _Step(label: 'Subscribe through $store', run: controls.renew),
        if (controls.isPhone) _Step(label: 'Delete this account', run: controls.deleteAccount, danger: true, confirm: (c) => confirmDelete(c, store)),
      ]),
    );
  }
}
