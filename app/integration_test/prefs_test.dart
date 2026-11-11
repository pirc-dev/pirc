// The platform's half of the app's prefs (ios/Runner/Prefs.swift,
// android/app/.../Prefs.kt), on a phone or simulator:
//   flutter test integration_test -d <device>
// That the relay outlives the app: run with --dart-define=PREFS=write,
// stop the app, then run with --dart-define=PREFS=read.
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc/app/app.dart';

const step = String.fromEnvironment('PREFS');
const kept = 'wss://kept.test/v1alpha1';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final prefs = ChannelPrefs();

  if (step == 'write') {
    testWidgets('keeps the relay', (_) => prefs.setRelay(kept));
  } else if (step == 'read') {
    testWidgets('the relay kept before the app stopped', (_) async {
      expect(await prefs.relay(), kept);
      await prefs.setRelay(null);
    });
  } else {
    testWidgets('keeps the relay, and forgets it', (_) async {
      await prefs.setRelay('wss://relay.test/v1alpha1');
      expect(await prefs.relay(), 'wss://relay.test/v1alpha1');
      await prefs.setRelay('wss://other.test');
      expect(await prefs.relay(), 'wss://other.test');
      await prefs.setRelay(null);
      expect(await prefs.relay(), isNull);
    });
  }
}
