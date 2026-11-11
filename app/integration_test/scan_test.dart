// That the phone reads a join code: the scanner's decoder (ML Kit on
// Android, Vision on iOS) on a picture of one, as the camera would see it.
// The picture is put in the app's cache first, as join-qr.png, of the link
// given as --dart-define=SCAN_TEXT; since flutter test installs the app
// afresh, build this as the app (flutter build apk -t), copy the picture
// in, and start it (app/README.md).
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pirc/join.dart';

const text = String.fromEnvironment('SCAN_TEXT');

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('reads a join code from a picture of it', (_) async {
    final picture = File('${(await getApplicationCacheDirectory()).path}/join-qr.png');
    if (!picture.existsSync()) {
      markTestSkipped('no join-qr.png in the cache');
      return;
    }
    final controller = MobileScannerController(autoStart: false);
    final capture = await controller.analyzeImage(picture.path);
    final read = capture?.barcodes.map((b) => b.rawValue).whereType<String>().toList() ?? [];
    expect(read, [text]);
    expect(parseJoinLink(read.single), isNotNull);
    await controller.dispose();
  });
}
