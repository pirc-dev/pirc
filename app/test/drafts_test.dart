// What is being written in each chat, kept on the phone (lib/app/drafts.dart,
// as web/page/src/drafts.ts): per chat, cleared when empty, for a week, the
// newest hundred.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/app/drafts.dart';

const day = 24 * 60 * 60 * 1000;

void main() {
  test('a folder of drafts: kept per chat, cleared when emptied, for a week, the newest hundred', () async {
    final dir = await Directory.systemTemp.createTemp('pirc-drafts-');
    addTearDown(() => dir.exists().then((e) => e ? dir.delete(recursive: true) : null));
    var now = 1793700000000;
    final protected = <String>[];
    final drafts = FileDrafts(Directory('${dir.path}/drafts'), protect: (p) async => protected.add(p), now: () => now);
    expect(await drafts.load('a'), '');
    await drafts.save('a', 'half a thought');
    await drafts.save('b/c', 'another');
    expect(await drafts.load('a'), 'half a thought');
    expect(await drafts.load('b/c'), 'another');
    expect(protected, hasLength(2), reason: 'each file written protected');
    await drafts.save('a', '  ');
    expect(await drafts.load('a'), '', reason: 'emptied, cleared');
    now += 8 * day;
    expect(await drafts.load('b/c'), '', reason: 'older than a week');
    for (var i = 0; i < 105; i++) {
      await drafts.save('chat $i', 'draft $i');
    }
    final files = Directory('${dir.path}/drafts').listSync().whereType<File>().where((f) => f.path.endsWith('.json'));
    expect(files.length, lessThanOrEqualTo(draftsKept));
    expect(await drafts.load('chat 104'), 'draft 104');
    await drafts.clear();
    expect(await drafts.load('chat 104'), '');
    // A folder that cannot be written: kept nowhere, and no failure.
    await FileDrafts(Directory('/dev/null/drafts')).save('a', 'x');
    expect(await FileDrafts(Directory('/dev/null/drafts')).load('a'), '');
  });
}
