// What a reply's Markdown may open, a code block's file from its fence
// (lib/ui/markdown.dart, as web/page/src/fence.ts), and its highlighting
// (lib/ui/highlight.dart).
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/ui/highlight.dart';
import 'package:pirc/ui/look.dart';
import 'package:pirc/ui/markdown.dart';

void main() {
  test('opens http, https and mailto links only', () {
    expect(openable('https://example.com/a?b=1')?.host, 'example.com');
    expect(openable('HTTP://example.com'), isNotNull);
    expect(openable('mailto:me@example.com'), isNotNull);
    for (final href in ['javascript:alert(1)', 'file:///etc/passwd', 'intent://x#Intent;end', 'tel:123', 'sms:1', 'pirc://join?token=x', '/relative', '', null]) {
      expect(openable(href), isNull, reason: '$href');
    }
  });

  test("a fence's language and file", () {
    expect(fence('ts', 'src/a.ts'), (lang: 'ts', file: 'src/a.ts'));
    expect(fence('ts', 'title="src/a b.ts"'), (lang: 'ts', file: 'src/a b.ts'));
    expect(fence('ts:src/a.ts', null), (lang: 'ts', file: 'src/a.ts'));
    expect(fence('src/sync.sh', null), (lang: 'sh', file: 'src/sync.sh'));
    expect(fence('sh', null), (lang: 'sh', file: null));
    expect(fence('python', '1.2'), (lang: 'python', file: null), reason: 'a version is no file');
    expect(fence('sh', 'https://example.com/x.sh'), (lang: 'sh', file: null), reason: 'nor a URL');
  });

  test('highlights a block that names its language, in Native\'s colours', () {
    const look = Look.light;
    const base = TextStyle(fontSize: 13);
    // Each piece of text in the colour it is drawn in, its own or the one
    // around it.
    final colours = <String, Color?>{};
    void walk(InlineSpan s, Color? around) {
      if (s is! TextSpan) return;
      final c = s.style?.color ?? around;
      if (s.text != null && s.text!.trim().isNotEmpty) colours[s.text!.trim()] = c;
      for (final k in s.children ?? const <InlineSpan>[]) {
        walk(k, c);
      }
    }

    walk(highlight('// sum\nconst n = 1 + "a";', 'ts', look, base)!, null);
    expect(colours['// sum'], look.ink3);
    expect(colours['const'], look.accent);
    expect(colours['"a"'], look.done);
    expect(colours['1'], look.work);
    expect(highlight('x', 'nosuchlanguage', look, base), isNull, reason: 'plain, as the web leaves it');
    expect(highlight('x', null, look, base), isNull, reason: 'no guessing');
    expect(highlight('x = 1', 'PYTHON', look, base), isNotNull, reason: 'names in any case');
  });

  test('keeps the blocks still drawn as a reply streams', () {
    const look = Look.light;
    const base = TextStyle(fontSize: 13);
    final done = highlight('const a = 1;', 'ts', look, base);
    // The finished block drawn with each piece of the one still streaming.
    for (var i = 0; i < 100; i++) {
      expect(identical(highlight('const a = 1;', 'ts', look, base), done), isTrue, reason: 'piece $i');
      highlight('const b = ${'1' * i}', 'ts', look, base);
    }
  });

  group('a reply being written, in blocks (blocksOf), as the web page splits it', () {
    test('paragraphs, headings and a closed fence split at their blank lines', () {
      expect(blocksOf('## A\n\nOne.\n\n```ts\nx\n\ny\n```\n\nTwo.'), ['## A', 'One.', '```ts\nx\n\ny\n```', 'Two.']);
    });
    test('a fence still open keeps the rest whole, its blank lines included', () {
      expect(blocksOf('One.\n\n```sh\nls\n\npwd'), ['One.', '```sh\nls\n\npwd']);
    });
    test('a loose list stays one block, and ends where a paragraph follows it', () {
      expect(blocksOf('- a\n\n- b\n\n  more of b\n\n1. c\n\nAfter.'), ['- a\n\n- b\n\n  more of b\n\n1. c', 'After.']);
    });
    test('a table and a quote are not split from their next lines', () {
      expect(blocksOf('| a |\n| - |\n\n| b |\n\n> q\n\n> r\n\nEnd.'), ['| a |\n| - |\n\n| b |\n\n> q\n\n> r', 'End.']);
    });
    test('reference links or footnotes keep the reply whole', () {
      const text = 'See [the RFC][1].\n\nMore.\n\n[1]: https://example.com';
      expect(blocksOf(text), [text]);
    });
  });

  testWidgets('a reply being written: only its last block is parsed again with each word', (tester) async {
    Widget reply(String text, {bool writing = true}) => Directionality(
          textDirection: TextDirection.ltr,
          child: LookScope(look: Look.light, child: Markdown(text, writing: writing)),
        );
    const done = '## Part one\n\nThe relay holds each connection.\n\n```ts\nconst a = 1;\n```\n\n';
    await tester.pumpWidget(reply('${done}The phone'));
    final before = markdownParses;
    for (final more in [' sleeps', ' and wakes', ' again.']) {
      await tester.pumpWidget(reply('${done}The phone sleeps and wakes again.'.substring(0, '${done}The phone'.length) + more));
    }
    expect(markdownParses - before, 3, reason: 'the growing paragraph alone, once a word');
    // Written: drawn whole, once.
    final whole = markdownParses;
    await tester.pumpWidget(reply('${done}The phone sleeps.', writing: false));
    expect(markdownParses - whole, 1);
  });
}
