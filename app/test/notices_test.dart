import 'package:flutter_test/flutter_test.dart';
import 'package:pirc/app/notices.dart';

void main() {
  test('the Android notices read as one entry per text, with its packages', () {
    final entries = androidNotices('[{"packages":["androidx.core:core","Abseil"],"text":"Apache License\\n\\nVersion 2.0\\n${'-' * 80}\\nmore"}]').toList();
    expect(entries, hasLength(1));
    expect(entries.single.packages, ['androidx.core:core', 'Abseil']);
    expect(entries.single.paragraphs.last.text, endsWith('more'));
  });
}
