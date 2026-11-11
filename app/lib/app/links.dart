// pirc://join links opened in the app (docs/design.md, section 5.3): by
// the phone's camera, or a link tapped elsewhere, over 'dev.pirc.app/links'
// (packages/pirc_platform). Each link opens the join screen with the link
// filled in, and joining waits for the person's tap.
import 'dart:async';

import 'package:flutter/services.dart';

class LinkPlatform {
  LinkPlatform([this.channel = const MethodChannel('dev.pirc.app/links')]) {
    channel.setMethodCallHandler((call) async {
      if (call.method == 'opened') _opened.add(call.arguments as String);
    });
  }

  final MethodChannel channel;
  final _opened = StreamController<String>.broadcast();

  // A link opened while the app runs.
  Stream<String> get opened => _opened.stream;

  // The link the app was started with, once; after this call, links come
  // by opened.
  Future<String?> launchedWith() => channel.invokeMethod<String>('launchedWith');
}
