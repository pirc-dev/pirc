// The names the account's phone gives the account's devices (docs/e2e.md,
// section 3): the list holds none, so the phone keeps them, signs them with
// the list's counter inside, and seals a copy to every client's box key,
// which the relay keeps (PublishNames) and gives each client with Devices.
// The names this phone sealed last come back to it so, and are what it
// starts from; its ordering value is the clock, or one past the highest it
// has seen or made, kept beside the account.
import 'package:fixnum/fixnum.dart';

import '../e2e/bytes.dart';
import '../e2e/list.dart';
import '../e2e/names.dart';
import '../gen/pirc/v1alpha2/relay.pb.dart' as v2;
import 'account.dart';
import 'setup.dart' show OpenAccount;
import 'sessions.dart';

const _orderingKey = 'hosted.names.ordering';

/// A device's name for the screens when none was given: its own for a
/// computer, its kind otherwise.
String defaultName(int role, bool phone) => role == roleComputer ? 'Computer' : phone ? 'Phone' : 'Browser';

/// Gives the devices [names] (by signing key in hex) and publishes them:
/// every device on the newest list gets a copy's entry, those without a
/// name here keeping the one they had. Throws what the relay or the
/// sealing refuses.
Future<void> publishNames({
  required E2e e2e,
  required OpenAccount open,
  required HostedSessions sessions,
  required KeyValues values,
  required Map<String, String> names,
  int Function()? now,
}) async {
  final account = open.account;
  if (!account.isPhone) throw StateError('only the account\'s phone gives names');
  final list = account.newest.body;
  final all = {...sessions.names, ...names};
  final kept = Int64.parseInt(await values.get(_orderingKey) ?? '0');
  final seen = sessions.namesOrdering ?? Int64.ZERO;
  final last = kept > seen ? kept : seen;
  final clock = Int64(now?.call() ?? DateTime.now().millisecondsSinceEpoch);
  final ordering = clock > last ? clock : last + 1;
  // Kept before it is used, as the counter is.
  await values.set(_orderingKey, '$ordering');
  final made = e2e.makeNames(
    accountId: account.accountId,
    list: list,
    phone: open.main.signing,
    phoneBoxSecretKey: open.main.box.secretKey,
    ordering: ordering,
    names: [
      for (final d in list.devices)
        if (all[hexOf(d.signingKey)] case final n? when n.isNotEmpty) DeviceName(d.signingKey, n),
    ],
  );
  final id = sessions.requestId('n');
  await sessions.request(
    id,
    v2.Frame(
      publishNames: v2.PublishNames(
        requestId: id,
        copies: [for (final c in made.copies) v2.SealedCopy(recipientKey: c.recipientKey, sealed: c.sealed)],
      ),
    ),
  );
}
