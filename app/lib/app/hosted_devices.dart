// A hosted account's devices as the app runs them, for Settings
// (ui/hosted_devices.dart): adding one by its code (AddDevice, on the
// running connection's frames), the version published taken as the
// account's newest, and names given and sealed (hosted/names.dart); and
// the account's life: renewing through the store, deleting the account.
import 'dart:async';
import 'dart:convert' show base64Url;
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';
import 'package:flutter/cupertino.dart';

import '../e2e/bytes.dart';
import '../e2e/list.dart';
import '../hosted/account.dart';
import '../hosted/join.dart';
import '../hosted/names.dart';
import '../hosted/setup.dart';
import '../gen/pirc/v1alpha2/relay.pb.dart' as v2;
import '../hosted/sessions.dart' show HostedRefusal;
import '../ui/hosted_account_screens.dart';
import '../ui/hosted_devices.dart';
import 'store.dart';
import '../ui/hosted_join_screens.dart';

String _keyText(List<int> b) => base64Url.encode(b).replaceAll('=', '');

String? _hexOfKeyText(String key) {
  try {
    return hexOf(base64Url.decode(base64Url.normalize(key)));
  } on FormatException {
    return null;
  }
}

/// AddDevice, but a publish whose answer did not come makes the phone log
/// in again, so that it reads the account's newest from the relay before
/// anything else is signed: a version built on an older one would drop
/// the device the relay took.
class _Rereading implements DeviceAdder {
  _Rereading(this._add, this._reread, this._account) : _base = _account.newest.counter;
  final AddDevice _add;
  final void Function() _reread;
  final HostedAccount _account;
  // The version the join was started from, and so would build on.
  final Int64 _base;
  @override
  Future<Offered> start(String text) => _add.start(text);
  @override
  Future<Uint8List> confirm() async {
    // A newer version came while the person was asked: one built on the
    // older would drop what it added.
    if (_account.newest.counter != _base) {
      _add.cancel();
      throw const JoinFailed('the account changed while you were asked; nothing was added, start again');
    }
    try {
      return await _add.confirm();
    } on JoinFailed catch (e) {
      if (e.published == null && e.message.startsWith(uncertainPublish)) _reread();
      rethrow;
    }
  }

  @override
  void cancel() => _add.cancel();
  @override
  Future<void> get ended => _add.ended;
}

class AppHostedDevices implements HostedDevices {
  AppHostedDevices({required this.e2e, required this.run, required this.values, required this.counter, this.scan}) {
    unawaited(keptNames(values).then((n) => _kept = n));
  }

  Map<String, String> _kept = {};

  final E2e e2e;
  final HostedRun run;
  final KeyValues values;
  final PhoneCounter counter;
  final Future<String?> Function()? scan;

  HostedAccount get _account => run.open.account;

  @override
  bool get isPhone => _account.isPhone;

  @override
  // Only the account's phone hears the computers confirm a change (its
  // probes), and only it shows which have not.
  Set<String> get behind {
    if (!isPhone) return const {};
    final hex = run.sessions.behind;
    return {
      for (final d in _account.newest.body.devices)
        if (hex.contains(hexOf(d.signingKey))) _keyText(d.signingKey),
    };
  }

  // The account as a join of the account's phone uses it, from its newest.
  PhoneAccount _phone() {
    final a = _account;
    final open = run.open;
    return PhoneAccount(
      accountId: a.accountId,
      phone: a.self,
      signing: open.main.signing,
      channel: open.main.channel.secretKey,
      first: a.first,
      newest: a.newest.bytes,
      name: _kept[hexOf(a.self.signingKey)] ?? 'your phone',
      counter: counter.next,
    );
  }

  @override
  void addDevice(BuildContext context) {
    final computers = _account.newest.body.devices.where((d) => d.role == roleComputer).length;
    Navigator.of(context).push(CupertinoPageRoute<void>(
      builder: (_) => AddDeviceScreen(
        adder: () => _Rereading(
          AddDevice(e2e: e2e, account: _phone(), frames: run.sessions.frames, send: (f) => run.sessions.sendRaw(f)),
          () => run.conn.switchAccount(_account.accountId),
          _account,
        ),
        computers: computers,
        // The relay took it: the newest from now on, whatever the join did;
        // and the names sealed again, so that a client added has them.
        published: (list) async {
          await _account.take(list);
          if (_kept.isEmpty) return;
          try {
            await publishNames(e2e: e2e, open: run.open, sessions: run.sessions, values: values, names: {});
          } on Object catch (e) {
            debugPrint('hosted: names not sealed again: $e');
          }
        },
        scan: scan,
      ),
    ));
  }

  @override
  Future<String?> rename(String key, String name) async {
    final hex = _hexOfKeyText(key);
    if (hex == null) return 'not a device of this account';
    try {
      await publishNames(e2e: e2e, open: run.open, sessions: run.sessions, values: values, names: {hex: name});
      _kept = await keptNames(values);
      return null;
    } on Object catch (e) {
      return '$e';
    }
  }
}

/// Where a deletion asked for is recorded until it is known done (D5): a
/// phone stopped half-way, or that never heard the relay's answer,
/// finishes it when it can.
const deletingKey = 'hosted.deleting';

/// A hosted account's life as the app runs it, for Settings and the locked
/// account's screen (ui/hosted_account_screens.dart).
class AppHostedAccount implements HostedAccountControls {
  AppHostedAccount({required this.run, required this.store, required this.storeName, required this.subscriptionsOf, required this.proof, required this.deleted, required this.values});

  final HostedRun run;
  final Store? store;
  @override
  final String? storeName;
  final List<v2.AccountSubscription> Function() subscriptionsOf;
  final KeyValues values;

  /// The store's proof of this phone's subscription, null for none.
  final Future<String?> Function() proof;

  /// After the relay has deleted the account: this phone's part of it goes.
  final Future<void> Function() deleted;

  @override
  List<v2.AccountSubscription> get subscriptions => subscriptionsOf();

  @override
  bool get isPhone => run.open.account.isPhone;

  // The relay takes the store's proof, once the store says it is live;
  // then the phone logs in again, to be told the account's subscriptions.
  Future<String?> _give(String proof) async {
    try {
      await run.renew(proof);
    } on HostedRefusal catch (e) {
      return 'The relay refused: ${e.message}';
    }
    run.conn.switchAccount(run.open.account.accountId);
    return null;
  }

  @override
  Future<String?> renew({bool buy = false}) async {
    final store = this.store;
    if (store == null) return 'This build has no store to renew through.';
    try {
      // A subscription this phone has already, which the relay may not
      // know; not when a purchase is what was asked for.
      if (!buy) {
        final had = await proof();
        if (had != null && await _give(had) == null) return null;
      }
      final bought = await store.buy();
      if (bought == Bought.cancelled) return 'Not bought.';
      if (bought == Bought.pending) return 'The purchase waits for approval. Renew again once it is approved.';
      final p = await proof();
      if (p == null) return 'The store has no subscription for this phone yet. Try again in a moment.';
      return await _give(p);
    } on Object catch (e) {
      return 'Not renewed: $e';
    }
  }

  @override
  Future<String?> deleteAccount() async {
    // Recorded first, for this account only: whatever happens next, the
    // phone finishes it.
    await values.set(deletingKey, _me);
    try {
      await run.deleteAccount();
    } on HostedRefusal catch (e) {
      // Refused: nothing was deleted, nothing to finish.
      await values.set(deletingKey, null);
      return 'The relay refused: ${e.message}';
    } on Object {
      return 'PiRC could not hear whether the relay deleted the account. It finishes once it can reach the relay again.';
    }
    await deleted();
    return null;
  }

  String get _me => hexOf(run.open.account.accountId);

  /// Whether this account's deletion was asked for and is not known done.
  Future<bool> deleting() async => await values.get(deletingKey) == _me;

  /// A deletion recorded and not known done: asked again, once logged in;
  /// why it was not done, for the person, or null.
  Future<String?> resumeDeletion() async {
    if (!isPhone || !await deleting()) return null;
    return deleteAccount();
  }
}
