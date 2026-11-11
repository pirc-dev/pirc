// The chats kept on the phone: kept by pi's session ID, shown while the
// relay's history is on its way, replaced by it, and forgotten after 7 days.
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;

import 'package:pirc/app/chat_cache.dart';
import 'package:pirc/app/model.dart';
import 'package:pirc/app/thumbs.dart';
import 'package:pirc/core/images.dart';
import 'package:pirc/core/protocol.dart';
import 'package:pirc/core/view.dart';

const day = 24 * 60 * 60 * 1000;
const t0 = 1793700000000;

ChatView chatOf(List<String> texts) => ChatView(
      items: [for (final (i, t) in texts.indexed) UserItem(id: 'e-$i', turnId: '', at: t0, text: t, images: const [])],
      truncated: false,
      loading: false,
    );

// A chat of one message with images, by their keys.
ChatView withImages(List<String> keys) => ChatView(
      items: [UserItem(id: 'e-0', turnId: '', at: t0, text: 'look', images: [for (final k in keys) ImageView(mimeType: 'image/png', key: k)])],
      truncated: false,
      loading: false,
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('a folder of chats: kept, read back, pruned by when each was opened, cleared', () async {
    final dir = await Directory.systemTemp.createTemp('pirc-chats-');
    addTearDown(() => dir.exists().then((e) => e ? dir.delete(recursive: true) : null));
    final cache = FileChatCache(Directory('${dir.path}/chats'));
    expect(await cache.load('s1'), isNull);
    expect(await cache.loadAll(), isEmpty);
    await cache.save('s1', chatOf(['hello']).copyWith(loading: true), t0);
    await cache.save('s/2', chatOf(['old']), t0 - 8 * day);
    expect((await cache.loadAll()).keys.toSet(), {'s1', 's/2'});
    final back = await cache.load('s1');
    expect(back!.toJson(), chatOf(['hello']).toJson(), reason: 'kept whole, not loading');
    await cache.prune(t0);
    expect(await cache.load('s/2'), isNull);
    expect(await cache.load('s1'), isNotNull);
    await File('${dir.path}/chats/garbage.json').writeAsString('{');
    await cache.prune(t0);
    expect(await File('${dir.path}/chats/garbage.json').exists(), isFalse);
    await cache.clear();
    expect(await cache.load('s1'), isNull);
  });

  test('a phone locked: a chat that cannot be read is not lost, nor replaced by less', () async {
    final dir = await Directory.systemTemp.createTemp('pirc-chats-');
    addTearDown(() => dir.exists().then((e) => e ? dir.delete(recursive: true) : null));
    final chats = Directory('${dir.path}/chats');
    await FileChatCache(chats).save('s1', chatOf(['one', 'two', 'three', 'four', 'five']), t0);
    // Started again with the phone locked: iOS refuses to read the file.
    var locked = true;
    final protected = <String>[];
    final cache = FileChatCache(chats, protect: (p) async => protected.add(p), read: (f) => locked ? throw FileSystemException('Operation not permitted', f.path, const OSError('', 1)) : f.readAsString());
    expect(await cache.loadAll(), isEmpty, reason: 'none to show');
    await cache.prune(t0 + 8 * day);
    // The relay's copy, which left the start out: not written over it.
    final less = chatOf(['four', 'five']).copyWith(truncated: true);
    await cache.save('s1', less, t0);
    locked = false;
    expect((await cache.load('s1'))!.items, hasLength(5), reason: 'kept, and prune left it');
    // Read now, but what the app holds is still the shorter copy.
    await cache.save('s1', less, t0);
    expect((await cache.load('s1'))!.items, hasLength(5));
    expect(protected, isEmpty);
    // Started again, unlocked: there, whole.
    expect((await FileChatCache(chats).loadAll())['s1']!.items, hasLength(5));
    // Locked again, then the relay's whole copy: that may replace it, and
    // the file written is protected.
    locked = true;
    expect(await cache.load('s1'), isNull);
    await cache.save('s1', chatOf(['one', 'two', 'three', 'four', 'five', 'six']), t0);
    locked = false;
    expect((await cache.load('s1'))!.items, hasLength(6));
    expect(protected, ['${chats.path}/${File(protected.single).uri.pathSegments.last}']);
    // A save that fails, as one while locked does, leaves the file as it was.
    final failing = FileChatCache(Directory('/dev/null/chats'));
    await failing.save('s1', chatOf(['x']), t0);
  });

  test('an opened chat is kept; seen again, it shows at once and history replaces it', () async {
    final cache = MemoryChatCache();
    final ref = SessionRef(hostKey: List.filled(32, 1), sessionId: 'pi-s1', instanceId: 'i1');
    const id = '0101010101010101-i1';
    Frame list(String instance) => Frame(sessionList: SessionList(sessions: [
          SessionEntry(session: SessionRef(hostKey: ref.hostKey, sessionId: 'pi-s1', instanceId: instance), hostLabel: 'h', payload: SessionAnnouncement(cwd: '/w').writeToBuffer()),
        ]));
    Frame history(String instance, String requestId, List<String> texts) => Frame(routed: Routed(
          session: SessionRef(hostKey: ref.hostKey, sessionId: 'pi-s1', instanceId: instance),
          payload: SessionMessage(history: History(requestId: requestId, items: [
            for (final (i, t) in texts.indexed) ConversationItem(entryId: '$i', userMessage: UserMessage(text: t)),
          ])).writeToBuffer(),
        ));

    // First run: the chat comes, is opened, and is kept.
    var n = 0;
    final first = PircModel(send: (_) => true, newId: () => 'id-${++n}', now: () => t0, cache: cache);
    first.client.onState(const RelayView(state: 'ready'));
    first.client.onFrame(list('i1'));
    await Future<void>.delayed(Duration.zero);
    first.client.onFrame(history('i1', 'id-1', ['fix the build']));
    first.opened(id);
    await Future<void>.delayed(Duration.zero);
    expect((await cache.load('pi-s1'))!.items.map((x) => (x as UserItem).text), ['fix the build']);

    // Next start, a new pi process for the same session: the kept chat
    // shows while history is fetched, marked loading.
    n = 0;
    final sent = <Frame>[];
    final next = PircModel(
      send: (f) {
        sent.add(f);
        return true;
      },
      newId: () => 'id-${++n}',
      now: () => t0 + day,
      cache: cache,
    );
    await next.restore();
    next.client.onState(const RelayView(state: 'ready'));
    next.client.onFrame(list('i2'));
    await Future<void>.delayed(Duration.zero);
    final shown = next.chat('0101010101010101-i2')!;
    expect(shown.loading, isTrue);
    expect(shown.items.map((x) => (x as UserItem).text), ['fix the build']);
    final asked = SessionMessage.fromBuffer(sent.where((f) => f.hasRouted()).single.routed.payload).historyRequest;
    expect(asked.afterEntryId, '0', reason: 'only what follows the kept chat');
    next.client.onFrame(history('i2', 'id-1', ['fix the build', 'and the docs']));
    await Future<void>.delayed(Duration.zero);
    expect(next.chat('0101010101010101-i2')!.items.length, 2);
    expect(next.chat('0101010101010101-i2')!.loading, isFalse);
  });

  test('chats opened more than 7 days ago are forgotten when the app starts', () async {
    final cache = MemoryChatCache();
    await cache.save('old', chatOf(['a']), t0);
    await cache.save('recent', chatOf(['b']), t0 + 5 * day);
    PircModel(send: (_) => true, now: () => t0 + 8 * day, cache: cache);
    await Future<void>.delayed(Duration.zero);
    expect(cache.chats.keys, ['recent']);
  });

  test("a chat's images kept beside it as thumbnails, protected, and deleted with it", () async {
    final dir = await Directory.systemTemp.createTemp('pirc-chats-');
    addTearDown(() => dir.exists().then((e) => e ? dir.delete(recursive: true) : null));
    final chats = Directory('${dir.path}/chats');
    final protected = <String>[];
    var made = 0;
    final cache = FileChatCache(chats, protect: (p) async => protected.add(p), thumb: (i) async {
      made++;
      return StoredImage('image/jpeg', Uint8List.fromList(i.data.take(2).toList()));
    });
    final held = {'k1': StoredImage('image/png', Uint8List.fromList([1, 2, 3])), 'k2': StoredImage('image/png', Uint8List.fromList([4, 5, 6]))};
    // k3 came without its data, or is no longer held: none kept.
    await cache.save('s1', withImages(['k1', 'k3']), t0, image: (k) => held[k]);
    final kept = await cache.images('s1');
    expect(kept.keys, ['k1']);
    expect(kept['k1']!.mimeType, 'image/jpeg');
    expect(kept['k1']!.data, [1, 2]);
    expect(protected.where((p) => p.endsWith('k1.jpg')), hasLength(1), reason: 'protected as the chat is');
    // Saved again, as each change does: made once only.
    await cache.save('s1', withImages(['k1', 'k2']), t0, image: (k) => held[k]);
    await cache.save('s1', withImages(['k1', 'k2']), t0, image: (k) => held[k]);
    expect(made, 2);
    expect((await cache.images('s1')).keys.toSet(), {'k1', 'k2'});
    // Started again: the thumbnails read back, and one gone from the chat
    // deleted.
    final next = FileChatCache(chats, thumb: (i) async => i);
    expect((await next.images('s1')).keys.toSet(), {'k1', 'k2'});
    await next.save('s1', withImages(['k2']), t0);
    expect((await next.images('s1')).keys.toSet(), {'k2'});
    // Not readable (the phone locked): none, and the chat's left as it is.
    final locked = FileChatCache(chats, read: (f) => throw FileSystemException('Operation not permitted', f.path, const OSError('', 1)));
    await locked.prune(t0 + 8 * day);
    expect((await next.images('s1')).keys.toSet(), {'k2'});
    // Pruned with its chat.
    await next.prune(t0 + 8 * day);
    expect(await next.images('s1'), isEmpty);
    expect(await chats.list().toList(), isEmpty);
  });

  test("a photo's thumbnail is a JPEG a thumbnail high; a picture with clear parts, a PNG", () async {
    final photo = img.Image(width: 2000, height: 1500);
    for (final p in photo) {
      p.setRgb(p.x * 255 ~/ 2000, p.y * 255 ~/ 1500, (p.x + p.y) % 256);
    }
    final big = StoredImage('image/jpeg', img.encodeJpg(photo, quality: 85));
    final small = (await thumbnail(big))!;
    final back = img.decodeJpg(small.data)!;
    expect((small.mimeType, back.height, back.width), ('image/jpeg', thumbHeight, 384));
    expect(small.data.length, lessThan(big.data.length ~/ 5));
    final clear = img.Image(width: 900, height: 600, numChannels: 4);
    final png = StoredImage('image/png', img.encodePng(clear));
    final t = (await thumbnail(png))!;
    expect(t.mimeType, 'image/png');
    // Already small: itself.
    final tiny = StoredImage('image/png', img.encodePng(img.Image(width: 8, height: 8)));
    expect(identical((await thumbnail(tiny))!.data, tiny.data), isTrue);
    expect(await thumbnail(StoredImage('image/png', Uint8List.fromList([1, 2, 3]))), isNull, reason: 'not a picture');
  });

  test('a kept thumbnail shows where the image is not held, and the image replaces it', () {
    final store = ImageStore(1 << 20);
    final full = Uint8List.fromList(List.filled(100, 7));
    final key = imageKey('image/png', full);
    store.putSmall(key, StoredImage('image/jpeg', Uint8List.fromList([1])));
    expect(store.get(key)!.data, [1]);
    expect(store.put('image/png', full), key);
    expect(store.get(key)!.data, full, reason: 'the image itself, now it came');
    store.putSmall(key, StoredImage('image/jpeg', Uint8List.fromList([1])));
    expect(store.get(key)!.data, full, reason: 'not replaced by its thumbnail');
  });

  test("a kept chat's thumbnails shown when it opens again", () async {
    final cache = MemoryChatCache();
    final ref = SessionRef(hostKey: List.filled(32, 1), sessionId: 'pi-s1', instanceId: 'i1');
    const id = '0101010101010101-i1';
    final thumb = StoredImage('image/jpeg', Uint8List.fromList([9, 9]));
    await cache.save('pi-s1', withImages(['k1']), t0, image: (_) => thumb);
    final model = PircModel(send: (_) => true, now: () => t0 + day, cache: cache);
    await model.restore();
    model.client.onState(const RelayView(state: 'ready'));
    model.client.onFrame(Frame(sessionList: SessionList(sessions: [
      SessionEntry(session: ref, hostLabel: 'h', payload: SessionAnnouncement(cwd: '/w').writeToBuffer()),
    ])));
    await Future<void>.delayed(Duration.zero);
    expect(model.client.image('k1'), isNull);
    var told = 0;
    model.addListener(() => told++);
    model.opened(id);
    await Future<void>.delayed(Duration.zero);
    expect(model.client.image('k1')!.data, [9, 9]);
    expect(told, greaterThan(0), reason: 'the chat drawn again with it');
  });
}
