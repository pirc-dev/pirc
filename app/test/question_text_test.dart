// A question's text as it was written: code, label and value, text, gaps.
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc/core/question_text.dart';

String show(List<QuestionBlock> bs) => bs
    .map((b) => switch (b) {
          QuestionText(:final text) => 'text $text',
          QuestionField(:final label, :final value) => 'field $label = $value',
          QuestionCode(:final code, :final label) => 'code${label == null ? '' : ' ($label)'} ${code.replaceAll('\n', '⏎')}',
          QuestionGap() => 'gap',
        })
    .join('\n');

void main() {
  test("pi-automode's ask: the rule a field, the action code under its label, the question text", () {
    const text = 'Rule: bash(git push *)\n\nAction:\nbash {\n  "command": "git push nowhere main"\n}\n\nAllow this action to continue to auto-mode classification?';
    expect(show(questionBlocks(text)), [
      'field Rule = bash(git push *)',
      'gap',
      'code (Action) bash {⏎  "command": "git push nowhere main"⏎}',
      'gap',
      'text Allow this action to continue to auto-mode classification?',
    ].join('\n'));
  });

  test('indented lines are code, their shared indentation taken off, under the line naming them', () {
    expect(show(questionBlocks('It runs:\n    make test\n      --verbose\nthen stops.')), [
      'code (It runs) make test⏎  --verbose',
      'text then stops.',
    ].join('\n'));
  });

  test('a bracket left open runs to where it closes, blank lines inside kept', () {
    expect(show(questionBlocks('[\n  1,\n\n  2\n]\nDone.')), [
      'code [⏎  1,⏎⏎  2⏎]',
      'text Done.',
    ].join('\n'));
  });

  test('plain lines stay text, a colon mid-sentence too; gaps collapse and none trail', () {
    expect(show(questionBlocks('Overwrite it? It has changes: 3 files.\n\n\nSure?\n\n')), [
      'text Overwrite it? It has changes: 3 files.',
      'gap',
      'text Sure?',
    ].join('\n'));
    expect(questionBlocks(''), isEmpty);
  });
}
