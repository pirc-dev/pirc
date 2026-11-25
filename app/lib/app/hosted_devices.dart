// A hosted account's devices as the app runs them, for Settings
// (ui/hosted_devices.dart): adding one by its code (AddDevice, on the
// running connection's frames), the version published taken as the
// account's newest, and names given and sealed (hosted/names.dart).
import 'dart:async';
import 'dart:convert' show base64Url;
import 'dart:typed_data';

import 'package:flutter/cupertino.dart';

import '../e2e/bytes.dart';
import '../e2e/list.dart';
import '../hosted/account.dart';
import '../hosted/join.dart';
import '../hosted/names.dart';
import '../hosted/setup.dart';
import '../ui/hosted_devices.dart';
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
  _Rereading(this._add, this._reread);
  final AddDevice _add;
  final void Function() _reread;
  @override
  Future<Offered> start(String text) => _add.start(text);
  @override
  Future<Uint8List> confirm() async {
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
  Set<String> get behind {
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
