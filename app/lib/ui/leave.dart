// Leaving the relay, from Settings (Leave this relay) or for a join link to
// another relay: asked first, saying plainly when this phone is the relay's
// only app; then, when the relay cannot take it off its list (unreachable,
// or too old to be asked), asked again whether to leave this phone only,
// its entry staying on the relay's list. Nothing is left half done
// without the person's tap.
import 'package:flutter/cupertino.dart';

import '../app/model.dart';
import '../join.dart';
import 'look.dart';
import 'adaptive.dart';

// Whether the relay lists this phone as its only app, so that leaving
// leaves none to add another.
bool onlyClient(PircModel model) {
  final clients = [for (final d in model.client.snapshot().devices) if (d.role == 'client') d];
  return clients.length == 1 && clients.single.self;
}

// The relay's name in a sentence: its host and port, without the scheme.
String hostOf(String relay) {
  final u = Uri.tryParse(relay);
  if (u == null || u.host.isEmpty) return relay;
  return u.hasPort ? '${u.host}:${u.port}' : u.host;
}

// Asks, leaves, and says how it went; true when the phone left.
Future<bool> leaveRelay(
  BuildContext context, {
  required String relay,
  required Future<LeaveFailed?> Function({bool phoneOnly}) leave,
  bool onlyClient = false,
  String title = 'Leave this relay?',
  String? intro,
  String action = 'Leave',
}) async {
  final name = hostOf(relay);
  final sure = await _ask(
    context,
    title: title,
    text: [
      ?intro,
      "This phone's keys come off $name's list, and its kept chats go from this phone. To come back, it joins again with a new link.",
      if (onlyClient) "This phone is the relay's only app. After it leaves, only pirc-relay add-client on the relay's machine lets anyone back in.",
    ].join('\n\n'),
    action: action,
  );
  if (!sure || !context.mounted) return false;
  var failed = await _while(context, leave);
  if (failed == null) return true;
  if (!context.mounted) return false;
  if (!failed.phoneOnly) {
    await _tell(context, "Couldn't leave", failed.reason);
    return false;
  }
  final alone = await _ask(
    context,
    title: 'Leave this phone only?',
    text: '${failed.reason}\n\n'
        "This phone can leave on its own: its keys and chats go from here, but $name keeps it on its list until another app, or pirc-relay remove, takes it off.",
    action: 'Leave this phone only',
  );
  if (!alone || !context.mounted) return false;
  failed = await _while(context, () => leave(phoneOnly: true));
  return failed == null;
}

// Leaving, with a dialog saying so meanwhile, which goes when it is done
// (or with everything else, once left).
Future<LeaveFailed?> _while(BuildContext context, Future<LeaveFailed?> Function() leave) async {
  final nav = Navigator.of(context);
  final route = dialogRoute<void>(
    context,
    (context) => alertDialog<void>(context, title: const Text('Leaving the relay…'), content: Padding(padding: const EdgeInsets.only(top: 12), child: onAndroid ? const Align(alignment: Alignment.centerLeft, child: Spinner(radius: 16)) : const Spinner())),
  );
  nav.push(route);
  try {
    return await leave();
  } finally {
    if (route.isActive) nav.removeRoute(route);
  }
}

Future<bool> _ask(BuildContext context, {required String title, required String text, required String action}) async =>
    await showAlert<bool>(
      context,
      title: Text(title),
      content: Padding(padding: const EdgeInsets.only(top: 6), child: Text(text, style: Look.of(context).text(size: 13.5, spacing: 0))),
      actions: [AlertAction('Cancel', false, primary: true), AlertAction(action, true, destructive: true)],
    ) ??
    false;

Future<void> _tell(BuildContext context, String title, String text) => showAlert<void>(
      context,
      title: Text(title),
      content: Text(text),
      actions: [AlertAction('OK', null, primary: true)],
    );
