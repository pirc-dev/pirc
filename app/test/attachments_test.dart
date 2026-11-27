// Files sent with a message: their chunks, in order and paced, then the
// Prompt naming them; refused where the session does not take them.
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc/app/model.dart';
import 'package:pirc/core/attachments.dart';
import 'package:pirc/core/protocol.dart';
import 'package:pirc/core/view.dart';
import 'package:pirc/ui/files.dart';

final hostKey = List<int>.filled(32, 1);
final ref = SessionRef(hostKey: hostKey, sessionId: 's-1', instanceId: 'i1');

// A model with one session that lists requests, its frames kept in sent;
// backlog as the connection's.
(PircModel, List<SessionMessage>) model(List<String> requests, {int Function(SessionRef)? backlog}) {
  final sent = <SessionMessage>[];
  var n = 0;
  final m = PircModel(
    send: (f) {
      if (f.hasRouted()) sent.add(SessionMessage.fromBuffer(f.routed.payload));
      return true;
    },
    newId: () => 'id-${++n}',
    backlog: backlog,
  );
  m.client.onState(const RelayView(state: 'ready'));
  m.client.onFrame(Frame(sessionList: SessionList(sessions: [
    SessionEntry(session: ref, hostLabel: 'laptop', payload: SessionAnnouncement(cwd: '/src', requests: requests).writeToBuffer()),
  ])));
  // Its history asked for: none yet.
  final asked = sent.where((s) => s.hasHistoryRequest()).single.historyRequest.requestId;
  m.client.onFrame(Frame(routed: Routed(session: ref, payload: SessionMessage(history: History(requestId: asked, seq: Int64(1))).writeToBuffer())));
  sent.clear();
  return (m, sent);
}

String idOf(PircModel m) => m.sessions.single.id;

void answer(PircModel m, String requestId) =>
    m.client.onFrame(Frame(routed: Routed(session: ref, payload: SessionMessage(accepted: Accepted(requestId: requestId)).writeToBuffer())));

Uint8List bytes(int n) => Uint8List.fromList([for (var i = 0; i < n; i++) i & 0xff]);

void main() {
  test('a file in 512 KiB chunks from offset 0, then the Prompt naming it', () async {
    final (m, sent) = model(['prompt', 'attachment_chunk', 'history_request']);
    final data = bytes(chunkBytes * 2 + 100);
    final done = m.prompt(idOf(m), '', files: [OutgoingFile(name: 'notes.pdf', mimeType: 'application/pdf', data: data), OutgoingFile(name: 'empty.txt', mimeType: 'text/plain', data: Uint8List(0))]);
    await pumpEventQueue();
    final chunks = sent.where((s) => s.hasAttachmentChunk()).map((s) => s.attachmentChunk).toList();
    final p = sent.last.prompt;
    final (a, b) = (p.attachments[0].id, p.attachments[1].id);
    expect(a == b, isFalse);
    expect([for (final c in chunks) (c.id, c.offset.toInt(), c.data.length)], [
      (a, 0, chunkBytes),
      (a, chunkBytes, chunkBytes),
      (a, 2 * chunkBytes, 100),
      (b, 0, 0),
    ]);
    expect(chunks.expand((c) => c.data).take(data.length).toList(), data, reason: 'the bytes as they were');
    expect([for (final x in p.attachments) (x.name, x.mimeType, x.size)], [
      ('notes.pdf', 'application/pdf', Int64(data.length)),
      ('empty.txt', 'text/plain', Int64(0)),
    ]);
    expect(p.text, '');
    answer(m, p.requestId);
    expect((await done).ok, isTrue);
    expect(m.pending(idOf(m)).single.state, 'sent', reason: 'shown until pi\'s copy comes');
  });

  test('a session that does not list attachment_chunk: refused here, nothing sent', () async {
    final (m, sent) = model(['prompt', 'history_request']);
    final o = await m.prompt(idOf(m), 'see this', files: [OutgoingFile(name: 'a.txt', mimeType: 'text/plain', data: bytes(10))]);
    expect((o.ok, o.message), (false, "this session's extension does not take files; update it"));
    expect(sent, isEmpty);
    expect(m.pending(idOf(m)).single.state, 'failed');
    expect(m.pending(idOf(m)).single.files!.single.name, 'a.txt', reason: 'kept, to send again');
  });

  test('chunks wait while the connection holds back more than backlogMax', () async {
    var held = backlogMax + 1;
    final (m, sent) = model(['prompt', 'attachment_chunk', 'history_request'], backlog: (_) => held);
    final done = m.prompt(idOf(m), 'two', files: [OutgoingFile(name: 'a.bin', mimeType: 'application/octet-stream', data: bytes(10))]);
    await Future<void>.delayed(const Duration(milliseconds: 120));
    expect(sent, isEmpty);
    held = 0;
    await Future<void>.delayed(const Duration(milliseconds: 120));
    expect(sent.map((s) => s.whichBody()), [SessionMessage_Body.attachmentChunk, SessionMessage_Body.prompt]);
    answer(m, sent.last.prompt.requestId);
    expect((await done).ok, isTrue);
  });

  test('a message sent while files upload waits for their Prompt; a second message of files waits too', () async {
    var held = backlogMax + 1;
    final (m, sent) = model(['prompt', 'attachment_chunk', 'history_request'], backlog: (_) => held);
    final id = idOf(m);
    final a = m.prompt(id, 'A', files: [OutgoingFile(name: 'a.bin', mimeType: 'application/octet-stream', data: bytes(10))]);
    final b = m.prompt(id, 'B');
    final c = m.prompt(id, 'C', files: [OutgoingFile(name: 'c.bin', mimeType: 'application/octet-stream', data: bytes(10))]);
    await Future<void>.delayed(const Duration(milliseconds: 120));
    expect(sent, isEmpty, reason: 'B waits behind A\'s files');
    held = 0;
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect([for (final x in sent) x.hasPrompt() ? x.prompt.text : 'chunk'], ['chunk', 'A', 'B', 'chunk', 'C']);
    for (final x in sent.where((x) => x.hasPrompt())) {
      answer(m, x.prompt.requestId);
    }
    expect([for (final o in await Future.wait([a, b, c])) o.ok], [true, true, true]);
  });

  test('files over the cap together are refused before any chunk goes', () async {
    final (m, sent) = model(['prompt', 'attachment_chunk', 'history_request']);
    final o = await m.prompt(idOf(m), 'big', files: [
      OutgoingFile(name: 'a', mimeType: 'application/octet-stream', data: Uint8List(attachmentsMax ~/ 2 + 1)),
      OutgoingFile(name: 'b', mimeType: 'application/octet-stream', data: Uint8List(attachmentsMax ~/ 2 + 1)),
    ]);
    expect((o.ok, o.message), (false, 'the files come to more than 10 MB'));
    expect(sent, isEmpty);
    expect(fitTogether(m.pending(idOf(m)).single.files!).length, 1, reason: 'Edit puts back what fits');
  });

  test('a retry sends the chunks again from offset 0', () async {
    final (m, sent) = model(['prompt', 'attachment_chunk', 'history_request']);
    final id = idOf(m);
    final first = m.prompt(id, '/look', files: [OutgoingFile(name: 'a.txt', mimeType: 'text/plain', data: bytes(10))]);
    await pumpEventQueue();
    final firstId = sent.first.attachmentChunk.id;
    m.client.onFrame(Frame(routed: Routed(session: ref, payload: SessionMessage(error: Error(requestId: sent.last.prompt.requestId, code: ErrorCode.ERROR_CODE_INVALID, message: 'a.txt is short')).writeToBuffer())));
    expect((await first).message, 'a.txt is short');
    sent.clear();
    final again = m.retry(id, m.pending(id).single);
    await pumpEventQueue();
    expect([for (final s in sent.where((s) => s.hasAttachmentChunk())) s.attachmentChunk.offset.toInt()], [0]);
    expect(sent.firstWhere((s) => s.hasAttachmentChunk()).attachmentChunk.id, firstId, reason: 'the same upload, started afresh');
    answer(m, sent.last.prompt.requestId);
    expect((await again).ok, isTrue);
    expect(m.pending(id).single.state, 'sent', reason: 'with files, "/" is no command: its copy comes');
  });

  test('history: the files by name, type and size; a message of files alone named so', () async {
    final (m, _) = model(['prompt', 'attachment_chunk', 'history_request']);
    await pumpEventQueue();
    final h = SessionMessage(event: SessionEvent(seq: Int64(2), item: ConversationItem(entryId: 'e1', turnId: 't', userMessage: UserMessage(attachments: [Attachment(name: 'notes.pdf', mimeType: 'application/pdf', size: Int64(2048))]))));
    m.client.onFrame(Frame(routed: Routed(session: ref, payload: h.writeToBuffer())));
    final u = m.chat(idOf(m))!.items.whereType<UserItem>().single;
    expect([for (final a in u.attachments) (a.name, a.mimeType, a.size)], [('notes.pdf', 'application/pdf', 2048)]);
    expect(UserItem.fromJson(u.toJson()).attachments.single.name, 'notes.pdf');
    expect(lastOf([u])?.text, 'notes.pdf');
    final plain = UserItem(id: 'u', turnId: 't', at: 0, text: 'hi', images: const []);
    expect(plain.toJson().containsKey('attachments'), isFalse, reason: 'left out when none, as the web has it');
  });

  test('picked files kept while they fit in what is left; the others said', () {
    final r = fitFiles([
      {'name': 'a.txt', 'mimeType': 'text/plain', 'size': 6, 'data': bytes(6)},
      {'name': 'big.mov', 'mimeType': 'video/quicktime', 'size': 50 << 20},
      {'name': 'b.txt', 'size': 5, 'data': bytes(5)},
    ], 10);
    expect([for (final f in r.files) (f.name, f.mimeType, f.data.length)], [('a.txt', 'text/plain', 6)]);
    expect(r.problem, '2 files are too large: the files of a message come to 10 MB at most.');
    expect(sizeText(820), '820 bytes');
    expect(sizeText(14 * 1000), '14 KB');
    expect(sizeText(3200 * 1000), '3.2 MB');
  });
}
