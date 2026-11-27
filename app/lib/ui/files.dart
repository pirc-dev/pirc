// Files for a message (docs/design.md, "A client's files"): any the person
// picks with the phone's document picker, within what is left of the
// message's 10 MiB, sent as they are; shown as chips by name and size.
import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import '../app/outside.dart';
import '../core/attachments.dart';
import 'look.dart';
import 'adaptive.dart';

const pickChannel = MethodChannel('dev.pirc.app/pick');

// The files picked, those that fit in room bytes together; with why any
// were left out.
Future<({List<OutgoingFile> files, String? problem})> pickFiles(int room) async {
  final List<Object?>? got;
  try {
    got = await goingOutside(() => pickChannel.invokeListMethod<Object?>('files', {'max': room}));
  } on PlatformException catch (e) {
    return (files: const <OutgoingFile>[], problem: e.message ?? 'The files could not be opened.');
  }
  return fitFiles([for (final f in got ?? const []) f as Map<Object?, Object?>], room);
}

// The picker's files, in order, while they fit in room together: each a
// name, a type, a size, and its bytes when it came with them.
({List<OutgoingFile> files, String? problem}) fitFiles(List<Map<Object?, Object?>> got, int room) {
  final files = <OutgoingFile>[];
  final left = <String>[];
  for (final f in got) {
    final name = f['name'] as String? ?? 'file';
    final data = f['data'] as Uint8List?;
    if (data == null || data.length > room) {
      left.add(name);
      continue;
    }
    room -= data.length;
    files.add(OutgoingFile(name: name, mimeType: f['mimeType'] as String? ?? 'application/octet-stream', data: data));
  }
  final most = sizeText(attachmentsMax);
  final problem = left.isEmpty
      ? null
      : left.length == 1
          ? '${left.single} is too large: the files of a message come to $most at most.'
          : '${left.length} files are too large: the files of a message come to $most at most.';
  return (files: files, problem: problem);
}

// Files in order, each kept while they come to attachmentsMax together.
List<OutgoingFile> fitTogether(List<OutgoingFile> files) {
  var room = attachmentsMax;
  final kept = <OutgoingFile>[];
  for (final f in files) {
    if (f.data.length > room) continue;
    room -= f.data.length;
    kept.add(f);
  }
  return kept;
}

// Files as chips: each one's name and size, with a button to take it out
// when onRemove is given.
class FileChips extends StatelessWidget {
  const FileChips({super.key, required this.files, this.onRemove, this.onAccent = false});

  final List<({String name, int size})> files;
  final void Function(int index)? onRemove;
  // In a sent message's bubble, on the accent.
  final bool onAccent;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final ink = onAccent ? look.onAccent : look.ink;
    final ink2 = onAccent ? look.onAccent.withValues(alpha: 0.8) : look.ink3;
    return Wrap(
      spacing: 6,
      runSpacing: 6,
      children: [
        for (final (i, f) in files.indexed)
          Semantics(
            label: '${f.name}, ${sizeText(f.size)}',
            excludeSemantics: onRemove == null,
            child: Container(
              constraints: const BoxConstraints(maxWidth: 240),
              padding: EdgeInsets.fromLTRB(8, 5, onRemove == null ? 10 : 2, 5),
              decoration: onAccent
                  ? BoxDecoration(color: look.onAccent.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(8))
                  : BoxDecoration(color: look.wash, borderRadius: BorderRadius.circular(8), border: Border.all(color: look.rule)),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(CupertinoIcons.doc, size: 16, color: ink2),
                const SizedBox(width: 6),
                Flexible(child: Text(f.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: look.text(size: 14, color: ink, spacing: 0))),
                const SizedBox(width: 6),
                Text(sizeText(f.size), style: look.text(size: 12, color: ink2, spacing: 0)),
                if (onRemove != null)
                  Press(
                    padding: const EdgeInsets.symmetric(horizontal: 6),
                    minimumSize: const Size(32, 28),
                    onPressed: () => onRemove!(i),
                    child: Icon(CupertinoIcons.xmark_circle_fill, size: 18, color: look.ink3, semanticLabel: 'Remove ${f.name}'),
                  ),
              ]),
            ),
          ),
      ],
    );
  }
}
