// The folder for what the app keeps of what it shows, the chats and the
// drafts (docs/design.md, section 12, step 13, "What the phone keeps"),
// from packages/pirc_platform over 'dev.pirc.app/files': on iOS unreadable
// while the phone is locked and out of backups, on Android out of backups
// and of transfers to another phone.
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

import 'chat_cache.dart';
import 'drafts.dart';

class PrivateFiles {
  PrivateFiles([this.channel = const MethodChannel('dev.pirc.app/files')]);

  final MethodChannel channel;

  // The folder's path, made and protected if it was not.
  Future<String> folder() async => (await channel.invokeMethod<String>('folder'))!;

  // A file just written there given the folder's protection again: a file
  // replaced by a rename keeps the protection it was written with.
  Future<void> protect(String path) => channel.invokeMethod('protect', {'path': path});

  // A file's protection and whether backups leave it out, for checking it.
  Future<Map<Object?, Object?>?> protection(String path) => channel.invokeMethod<Map<Object?, Object?>>('protection', {'path': path});
}

// The chats kept on the phone, in the private folder. When the folder
// cannot be had (the phone locked as the app starts, a full disk), none are
// kept this time, and the app starts all the same: they come from the
// relay, as on the first start.
Future<ChatCache?> keptChats(PrivateFiles files) async {
  try {
    final private = await files.folder();
    // Where the chats were kept before 2026-11-04, unprotected: a cache,
    // so gone rather than moved; tried again at the next start if not.
    try {
      final old = Directory('${(await getApplicationSupportDirectory()).path}/chats');
      if (await old.exists()) await old.delete(recursive: true);
    } on Object catch (e) {
      debugPrint('pirc: the old chats are still there: $e');
    }
    return FileChatCache(Directory('$private/chats'), protect: files.protect);
  } on Object catch (e) {
    debugPrint('pirc: no private folder, so no chats kept this time: $e');
    return null;
  }
}

// What is being written in each chat, in the private folder; none kept,
// as for the chats, when the folder cannot be had.
Future<Drafts?> keptDrafts(PrivateFiles files) async {
  try {
    return FileDrafts(Directory('${await files.folder()}/drafts'), protect: files.protect);
  } on Object catch (e) {
    debugPrint('pirc: no private folder, so no drafts kept this time: $e');
    return null;
  }
}
