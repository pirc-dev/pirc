// The chats kept on the phone (docs/design.md, section 12, step 13, "What
// the phone keeps"): those opened in the last 7 days, whole, their images as
// thumbnails, so that the app shows a chat at once and the relay's history
// replaces it when it comes.
// Kept by pi's session ID, which outlives a pi process. In the platform's
// private folder (files.dart): on iOS unreadable while the phone is locked
// and out of backups, on Android out of backups. Deleted with the relay.
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import '../core/images.dart';
import '../core/view.dart';
import 'thumbs.dart';

// How long a chat is kept after it was last opened.
const keepMs = 7 * 24 * 60 * 60 * 1000;

abstract class ChatCache {
  Future<ChatView?> load(String sessionId);
  // Every chat kept, by pi's session ID.
  Future<Map<String, ChatView>> loadAll();
  // Keeps the chat, opened at openedAt (milliseconds since the epoch), and
  // a thumbnail of each of its images that image gives, not kept already.
  Future<void> save(String sessionId, ChatView chat, int openedAt, {StoredImage? Function(String key)? image});
  // The thumbnails kept with the chat, by their image's key.
  Future<Map<String, StoredImage>> images(String sessionId);
  // Forgets the chats last opened before now - keepMs.
  Future<void> prune(int now);
  Future<void> clear();
}

class MemoryChatCache implements ChatCache {
  final chats = <String, (ChatView, int)>{};
  final thumbs = <String, Map<String, StoredImage>>{};

  @override
  Future<ChatView?> load(String sessionId) async => chats[sessionId]?.$1;
  @override
  Future<Map<String, ChatView>> loadAll() async => chats.map((k, v) => MapEntry(k, v.$1));
  @override
  Future<void> save(String sessionId, ChatView chat, int openedAt, {StoredImage? Function(String key)? image}) async {
    chats[sessionId] = (chat, openedAt);
    final kept = thumbs[sessionId] ?? {};
    thumbs[sessionId] = {
      for (final k in imageKeys(chat)) k: ?(kept[k] ?? image?.call(k)),
    };
  }

  @override
  Future<Map<String, StoredImage>> images(String sessionId) async => thumbs[sessionId] ?? const {};
  @override
  Future<void> prune(int now) async {
    chats.removeWhere((_, v) => v.$2 < now - keepMs);
    thumbs.removeWhere((k, _) => !chats.containsKey(k));
  }

  @override
  Future<void> clear() async {
    chats.clear();
    thumbs.clear();
  }
}

// The keys of the chat's images that came with their data.
Set<String> imageKeys(ChatView chat) => {
      for (final x in chat.items)
        if (x is UserItem)
          for (final i in x.images) ?i.key,
    };

// One JSON file per chat in a folder of its own, and beside it a folder of
// its images' thumbnails, a file each named by the image's key. A file that
// is there but cannot be read (on iOS, while the phone is locked) is not
// taken for none: prune leaves it, and its chat is not written again from a
// copy that may hold less, only from one the relay sent whole. Read later,
// it still is not: what the app holds then never had it.
class FileChatCache implements ChatCache {
  FileChatCache(this.dir, {this.protect, Future<String> Function(File f)? read, Future<StoredImage?> Function(StoredImage)? thumb})
      : _read = read ?? ((f) => f.readAsString()),
        _thumb = thumb ?? thumbnail;
  final Directory dir;
  // Gives a file just written the folder's protection again.
  final Future<void> Function(String path)? protect;
  final Future<String> Function(File f) _read;
  final Future<StoredImage?> Function(StoredImage) _thumb;
  // The sessions whose file was there and could not be read.
  final _unread = <String>{};
  // The thumbnails on disk, by session, once looked at; and those being made.
  final _thumbs = <String, Set<String>>{};
  final _making = <String>{};

  String _name(String sessionId) => base64Url.encode(utf8.encode(sessionId)).replaceAll('=', '');
  File _file(String sessionId) => File('${dir.path}/${_name(sessionId)}.json');
  Directory _images(String sessionId) => Directory('${dir.path}/${_name(sessionId)}.images');

  // The file's JSON; null when there is none or it is not a chat's, which
  // is as good as none; and the session marked when it could not be read.
  Future<Map<String, Object?>?> _json(String sessionId) async {
    final f = _file(sessionId);
    try {
      return jsonDecode(await _read(f)) as Map<String, Object?>;
    } on FileSystemException {
      if (await f.exists()) _unread.add(sessionId);
      return null;
    } on Object {
      return null;
    }
  }

  @override
  Future<ChatView?> load(String sessionId) async {
    final j = await _json(sessionId);
    try {
      return j == null ? null : ChatView.fromJson(j['chat'] as Json);
    } on Object {
      // Not a chat's: fetched from the relay as if new.
      return null;
    }
  }

  @override
  Future<Map<String, ChatView>> loadAll() async {
    final out = <String, ChatView>{};
    if (!await dir.exists()) return out;
    await for (final f in dir.list()) {
      if (f is! File || !f.path.endsWith('.json')) continue;
      final name = f.uri.pathSegments.last.replaceAll('.json', '');
      final String sessionId;
      try {
        sessionId = utf8.decode(base64Url.decode(base64Url.normalize(name)));
      } on FormatException {
        continue;
      }
      final chat = await load(sessionId);
      if (chat != null) out[sessionId] = chat;
    }
    return out;
  }

  @override
  Future<void> save(String sessionId, ChatView chat, int openedAt, {StoredImage? Function(String key)? image}) async {
    // Kept and not read: only a whole copy may replace it.
    if (_unread.contains(sessionId) && chat.truncated) return;
    final f = _file(sessionId);
    try {
      await dir.create(recursive: true);
      final tmp = File('${f.path}.tmp');
      await tmp.writeAsString(jsonEncode({'openedAt': openedAt, 'chat': chat.copyWith(loading: false).toJson()}));
      await tmp.rename(f.path);
      _unread.remove(sessionId);
      await protect?.call(f.path);
    } on Object {
      // Not written (the phone locked): the file is as it was.
      return;
    }
    await _keepImages(sessionId, imageKeys(chat), image);
  }

  static const _types = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp'};

  // The keys of the thumbnails on disk, with each file's type.
  Future<Map<String, String>> _onDisk(String sessionId) async {
    final out = <String, String>{};
    final d = _images(sessionId);
    if (!await d.exists()) return out;
    await for (final f in d.list()) {
      // Each "key.ext"; one half written ends in ".tmp".
      final parts = f.uri.pathSegments.last.split('.');
      if (f is! File || parts.length != 2) continue;
      final type = _types.entries.where((e) => e.value == parts[1]).firstOrNull?.key;
      if (type != null) out[parts[0]] = type;
    }
    return out;
  }

  // A thumbnail written for each image held and not kept, and those of
  // images no longer in the chat deleted. A failure (the phone locked)
  // leaves the folder as it was, to be tried at the next save.
  Future<void> _keepImages(String sessionId, Set<String> keys, StoredImage? Function(String key)? image) async {
    try {
      final kept = _thumbs[sessionId] ??= (await _onDisk(sessionId)).keys.toSet();
      final d = _images(sessionId);
      for (final k in kept.difference(keys).toList()) {
        for (final ext in _types.values) {
          final f = File('${d.path}/$k.$ext');
          if (await f.exists()) await f.delete();
        }
        kept.remove(k);
      }
      for (final k in keys.difference(kept)) {
        final full = image?.call(k);
        if (full == null || !_making.add('$sessionId/$k')) continue;
        try {
          final small = await _thumb(full);
          if (small == null) continue;
          await d.create(recursive: true);
          final f = File('${d.path}/$k.${_types[small.mimeType]}');
          final tmp = File('${f.path}.tmp');
          await tmp.writeAsBytes(small.data);
          await tmp.rename(f.path);
          await protect?.call(f.path);
          kept.add(k);
        } finally {
          _making.remove('$sessionId/$k');
        }
      }
    } on Object {
      // Not kept now; tried again at the next save.
      _thumbs.remove(sessionId);
    }
  }

  @override
  Future<Map<String, StoredImage>> images(String sessionId) async {
    final out = <String, StoredImage>{};
    try {
      final d = _images(sessionId);
      for (final MapEntry(key: k, value: type) in (await _onDisk(sessionId)).entries) {
        out[k] = StoredImage(type, Uint8List.fromList(await File('${d.path}/$k.${_types[type]}').readAsBytes()));
      }
    } on Object {
      // Not readable now (the phone locked): placeholders.
    }
    return out;
  }

  @override
  Future<void> prune(int now) async {
    if (!await dir.exists()) return;
    await for (final f in dir.list()) {
      if (f is! File || !f.path.endsWith('.json')) continue;
      try {
        final openedAt = (jsonDecode(await _read(f)) as Map<String, Object?>)['openedAt'] as int;
        if (openedAt >= now - keepMs) continue;
      } on FileSystemException {
        // Not readable now (the phone locked): left until it is.
        continue;
      } on Object {
        // Not a chat's: gone too.
      }
      try {
        await f.delete();
      } on FileSystemException {
        // Gone already.
      }
    }
    // The thumbnails of a chat no longer kept go with it.
    await for (final d in dir.list()) {
      if (d is! Directory || !d.path.endsWith('.images')) continue;
      if (await File('${d.path.substring(0, d.path.length - '.images'.length)}.json').exists()) continue;
      try {
        await d.delete(recursive: true);
      } on FileSystemException {
        // Gone already.
      }
    }
    _thumbs.clear();
  }

  @override
  Future<void> clear() async {
    _thumbs.clear();
    if (await dir.exists()) await dir.delete(recursive: true);
  }
}
