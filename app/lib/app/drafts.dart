// What is being written in each chat, on this phone only, so that it
// survives leaving the chat and restarting the app, as the web page keeps
// its own (web/page/src/drafts.ts): for the chats written in most
// recently, and for a week. A file per chat in the private folder
// (files.dart), so that one that cannot be read while the phone is locked
// takes no other with it. Deleted with the relay.
import 'dart:convert';
import 'dart:io';

// Kept for the chats written in most recently, and for a week.
const draftsKept = 100;
const draftMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

abstract class Drafts {
  // The chat's draft; empty when there is none, or it is older than a week.
  Future<String> load(String id);
  // An empty text clears the chat's draft.
  Future<void> save(String id, String text);
  Future<void> clear();
}

class MemoryDrafts implements Drafts {
  MemoryDrafts({this.now = _now});
  final int Function() now;
  final drafts = <String, ({String text, int at})>{};

  static int _now() => DateTime.now().millisecondsSinceEpoch;

  @override
  Future<String> load(String id) async {
    final d = drafts[id];
    return d != null && now() - d.at < draftMaxAgeMs ? d.text : '';
  }

  @override
  Future<void> save(String id, String text) async {
    if (text.trim().isEmpty) {
      drafts.remove(id);
      return;
    }
    drafts[id] = (text: text, at: now());
    final kept = drafts.entries.where((e) => now() - e.value.at < draftMaxAgeMs).toList()..sort((a, b) => b.value.at - a.value.at);
    drafts
      ..clear()
      ..addEntries(kept.take(draftsKept));
  }

  @override
  Future<void> clear() async => drafts.clear();
}

class FileDrafts implements Drafts {
  FileDrafts(this.dir, {this.protect, this.now = MemoryDrafts._now});
  final Directory dir;
  // Gives a file just written the folder's protection again.
  final Future<void> Function(String path)? protect;
  final int Function() now;

  File _file(String id) => File('${dir.path}/${base64Url.encode(utf8.encode(id)).replaceAll('=', '')}.json');

  @override
  Future<String> load(String id) async {
    try {
      final j = jsonDecode(await _file(id).readAsString()) as Map<String, Object?>;
      return now() - (j['at'] as int) < draftMaxAgeMs ? j['text'] as String : '';
    } on Object {
      // None, or not readable now (the phone locked): none shown.
      return '';
    }
  }

  @override
  Future<void> save(String id, String text) async {
    final f = _file(id);
    try {
      if (text.trim().isEmpty) {
        if (await f.exists()) await f.delete();
        return;
      }
      await dir.create(recursive: true);
      final tmp = File('${f.path}.tmp');
      await tmp.writeAsString(jsonEncode({'text': text, 'at': now()}));
      await tmp.rename(f.path);
      await protect?.call(f.path);
      await _prune(f);
    } on Object {
      // Not kept (the phone locked): the draft lasts while the chat is open.
    }
  }

  // The week's, the newest hundred; by when each was last written.
  Future<void> _prune(File written) async {
    final files = [
      await for (final e in dir.list())
        if (e is File && e.path.endsWith('.json')) (file: e, at: (await e.stat()).modified.millisecondsSinceEpoch),
    ]..sort((a, b) => b.at - a.at);
    for (final (i, x) in files.indexed) {
      if (x.file.path == written.path) continue;
      if (i >= draftsKept || now() - x.at >= draftMaxAgeMs) await x.file.delete();
    }
  }

  @override
  Future<void> clear() async {
    try {
      if (await dir.exists()) await dir.delete(recursive: true);
    } on FileSystemException {
      // Gone already.
    }
  }
}
