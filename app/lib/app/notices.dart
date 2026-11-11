// The notices of the Android libraries Gradle adds, which Flutter's
// NOTICES leaves out (docs/design.md, step 13): the build writes them from
// the release's dependencies (android/app/build.gradle.kts), and the
// Licences page shows them with the rest.
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

void addAndroidNotices() {
  if (defaultTargetPlatform != TargetPlatform.android) return;
  LicenseRegistry.addLicense(() async* {
    // A failure leaves the rest of the page as it is.
    final String? json;
    try {
      json = await const MethodChannel('dev.pirc.app/about').invokeMethod<String>('notices');
    } on PlatformException {
      return;
    }
    if (json == null) return;
    for (final e in androidNotices(json)) {
      yield e;
    }
  });
}

// [{"packages": [...], "text": "..."}], the build's file.
Iterable<LicenseEntry> androidNotices(String json) sync* {
  for (final e in jsonDecode(json) as List<Object?>) {
    e as Map<String, Object?>;
    yield LicenseEntryWithLineBreaks((e['packages'] as List<Object?>).cast<String>(), e['text'] as String);
  }
}
