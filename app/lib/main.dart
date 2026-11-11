// PiRC's mobile app (docs/design.md, section 12, step 13).
import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'app/app.dart';
import 'app/files.dart';
import 'app/links.dart';
import 'app/notices.dart';
import 'app/store.dart';
import 'keys/key_store.dart';
import 'push/push.dart';
import 'push/wake.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final files = PrivateFiles();
  addAndroidNotices();
  runApp(PircApp(store: ChannelKeyStore(), prefs: ChannelPrefs(), camera: true, push: PushPlatform(), links: LinkPlatform(), subscription: _subscription(), cache: await keptChats(files), drafts: await keptDrafts(files)));
}

// The App Store's subscription, or Google Play's.
Store? _subscription() => defaultTargetPlatform == TargetPlatform.iOS || defaultTargetPlatform == TargetPlatform.android ? ChannelStore() : null;

// A push woke the phone (Android: packages/pirc_platform's WakeService
// starts an engine here): the notifications for what is new, the fixed
// text when the relay cannot be read, nothing when nothing is new.
@pragma('vm:entry-point')
Future<void> wakeMain() async {
  WidgetsFlutterBinding.ensureInitialized();
  final push = PushPlatform();
  try {
    final notes = await wake(prefs: ChannelPrefs(), store: ChannelKeyStore(), subscription: _subscription(), now: DateTime.now().millisecondsSinceEpoch);
    for (final n in notes) {
      await push.post(n.session, n.title, n.body);
    }
  } on Object {
    await push.post(null, 'PiRC', 'A session needs you');
  } finally {
    await const MethodChannel('dev.pirc.app/wake').invokeMethod('done');
  }
}
