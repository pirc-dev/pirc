// A question's text laid out as it was written: its lines and their
// indentation kept, an indented or bracketed block as code, a "Name: value"
// line as a label and its value, a blank line as a gap.

sealed class QuestionBlock {
  const QuestionBlock();
}

class QuestionText extends QuestionBlock {
  const QuestionText(this.text);
  final String text;
}

class QuestionField extends QuestionBlock {
  const QuestionField(this.label, this.value);
  final String label;
  final String value;
}

// A block of code, under the label of a "Name:" line before it, if any.
class QuestionCode extends QuestionBlock {
  const QuestionCode(this.code, {this.label});
  final String code;
  final String? label;
}

class QuestionGap extends QuestionBlock {
  const QuestionGap();
}

final _field = RegExp(r'^([A-Za-z][A-Za-z0-9 _-]{0,30}):(?:\s+(\S.*))?$');

bool _indented(String l) => l.startsWith(' ') || l.startsWith('\t');

// A line that opens a block: indented, or opening a bracket it does not
// close on the same line.
bool _opens(String l) => _indented(l) || _depth(l) > 0;

// How many more brackets the line opens than it closes.
int _depth(String l) {
  var d = 0;
  for (final c in l.runes) {
    if (c == 0x7B || c == 0x5B) d++;
    if (c == 0x7D || c == 0x5D) d--;
  }
  return d;
}

// The lines under a question's first: the rest of its title, then its
// message.
List<QuestionBlock> questionBlocks(String text) {
  final lines = text.replaceAll('\r\n', '\n').split('\n');
  final out = <QuestionBlock>[];
  String? label;
  var i = 0;
  while (i < lines.length) {
    final l = lines[i].trimRight();
    if (l.trim().isEmpty) {
      if (out.isNotEmpty && out.last is! QuestionGap) out.add(const QuestionGap());
      i++;
      continue;
    }
    if (_opens(l)) {
      final code = <String>[];
      var depth = 0;
      while (i < lines.length) {
        final c = lines[i].trimRight();
        if (code.isNotEmpty && depth <= 0 && !_indented(c)) break;
        if (c.trim().isEmpty && depth <= 0) break;
        code.add(c);
        depth += _depth(c);
        i++;
      }
      out.add(QuestionCode(_dedent(code).join('\n'), label: label));
      label = null;
      continue;
    }
    final f = _field.firstMatch(l);
    if (f != null && f.group(2) == null && i + 1 < lines.length && _opens(lines[i + 1].trimRight())) {
      label = f.group(1);
      i++;
      continue;
    }
    if (f != null && f.group(2) != null) {
      out.add(QuestionField(f.group(1)!, f.group(2)!));
    } else {
      out.add(QuestionText(l));
    }
    i++;
  }
  while (out.isNotEmpty && out.last is QuestionGap) {
    out.removeLast();
  }
  return out;
}

// The block's lines less the indentation they all share.
List<String> _dedent(List<String> lines) {
  final shared = lines.where((l) => l.trim().isNotEmpty).map((l) => l.length - l.trimLeft().length).fold<int?>(null, (a, b) => a == null || b < a ? b : a) ?? 0;
  return [for (final l in lines) l.length >= shared ? l.substring(shared) : l.trimLeft()];
}
