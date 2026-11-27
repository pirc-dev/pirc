// Files sent with a message (docs/design.md, "A client's files"): their
// bytes go first, in AttachmentChunks, and the Prompt names them.
import 'dart:math' show min;
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';

import 'protocol.dart';

// The files of one message together, as the extension takes them.
const attachmentsMax = 10 << 20;
// The bytes in one AttachmentChunk, well within a channel's frame.
const chunkBytes = 512 << 10;
// The request a session lists when it takes files.
const takesFiles = 'attachment_chunk';

class OutgoingFile {
  const OutgoingFile({required this.name, required this.mimeType, required this.data});

  // Without a directory.
  final String name;
  final String mimeType;
  final Uint8List data;
}

// A file's chunks, in order from offset 0; a file of no bytes has one, empty.
Iterable<AttachmentChunk> chunksOf(String id, Uint8List data) sync* {
  var off = 0;
  do {
    final end = min(off + chunkBytes, data.length);
    yield AttachmentChunk(id: id, offset: Int64(off), data: Uint8List.sublistView(data, off, end));
    off = end;
  } while (off < data.length);
}

// The size as people read it: "820 bytes", "14 KB", "3.2 MB".
String sizeText(int n) {
  if (n < 1000) return '$n bytes';
  if (n < 1000 * 1000) return '${(n / 1000).round()} KB';
  final mb = n / (1000 * 1000);
  return '${mb < 10 ? mb.toStringAsFixed(1) : mb.round()} MB';
}
