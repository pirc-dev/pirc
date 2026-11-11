// What a reply's Markdown may open, a code block's file from its fence
// (lib/ui/markdown.dart, as web/page/src/fence.ts), and its highlighting
// (lib/ui/highlight.dart).
import 'package:flutter/painting.dart';
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
}
