// How a chat shows: how its items group into runs, what its end holds, and
// a tool's time and diff. A port of web/core/chat.ts.
import 'view.dart';

// An item, or tool calls folded into one line.
sealed class Part {
  const Part();
  String get key;
}

class ItemPart extends Part {
  const ItemPart(this.item);
  final ChatItem item;
  @override
  String get key => item.id;
}

class ToolsPart extends Part {
  const ToolsPart(this.tools);
  final List<ToolItem> tools;
  @override
  String get key => tools.first.id;
}

// Tool calls one after another read as one log: they are kept together.
// Within it, two or more in a row that finished well fold into one line;
// one running or failed stays in sight. pi's mostly empty messages between
// calls do not break the run.
List<List<Part>> runs(List<ChatItem> items) {
  final out = <List<Part>>[];
  List<Part>? run;
  var fine = <ToolItem>[];
  void flush() {
    if (fine.length > 1) {
      run?.add(ToolsPart(fine));
    } else {
      for (final t in fine) {
        run?.add(ItemPart(t));
      }
    }
    fine = [];
  }

  for (final it in items) {
    if (run != null && _blank(it)) continue;
    if (it is! ToolItem) {
      flush();
      run = null;
      out.add([ItemPart(it)]);
      continue;
    }
    if (run == null) {
      run = [];
      out.add(run);
    }
    if (it.result != null && !it.result!.isError) {
      fine.add(it);
    } else {
      flush();
      run.add(ItemPart(it));
    }
  }
  flush();
  return out;
}

// A reply with nothing to show: finished, no text or thought, no error, not
// stopped.
bool _blank(ChatItem it) =>
    it is AssistantItem &&
    !it.streaming &&
    (it.error ?? '').isEmpty &&
    it.stop != 'aborted' &&
    it.stop != 'error' &&
    it.blocks.every((b) => b.text.trim().isEmpty);

// What the end of the chat holds, to tell when more has come.
String signature(ChatItem? it) => switch (it) {
      null => '',
      AssistantItem() => '${it.id}:${it.blocks.fold<int>(0, (n, b) => n + b.text.length)}:${it.streaming}',
      ToolItem() => '${it.id}:${it.result != null}',
      _ => it.id,
    };

// A duration, shortly: "0.4s", "12s", "2m 05s".
String took(int ms) {
  if (ms < 10000) return '${((ms < 0 ? 0 : ms) / 1000).toStringAsFixed(1)}s';
  final s = (ms / 1000).round();
  return s < 60 ? '${s}s' : '${s ~/ 60}m ${(s % 60).toString().padLeft(2, '0')}s';
}

final _header = RegExp(r'^(---|\+\+\+|Index:|={3,}|diff )');

// A unified diff's lines that say something: the changes and the context
// around them, not the file headers.
List<({String kind, String text})> diffLines(String diff) => [
      for (final l in diff.split('\n'))
        if (!_header.hasMatch(l))
          (
            kind: l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : 'same',
            text: l,
          ),
    ];
