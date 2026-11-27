// The app's text colours against what they sit on: ink2 and ink3, its
// secondary and tertiary text, at least 4.5:1 (WCAG AA) on every
// background of both looks, a grey wash laid over each; and red text on
// its pale red.
import 'dart:math' as math;
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:pirc/ui/look.dart';

double _lum(Color c) {
  double ch(double v) => v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

double contrast(Color a, Color b) {
  final (x, y) = (_lum(a), _lum(b));
  return (math.max(x, y) + 0.05) / (math.min(x, y) + 0.05);
}

void main() {
  for (final (name, look) in [('light', Look.light), ('dark', Look.dark)]) {
    test('secondary and tertiary text are 4.5:1 or more, $name', () {
      final grounds = {'page': look.page, 'card': look.card, 'sheet': look.sheet, 'sheet card': look.sheetCard};
      for (final MapEntry(key: g, value: c) in [...grounds.entries]) {
        grounds['wash on $g'] = Color.alphaBlend(look.wash, c);
      }
      for (final (t, ink) in [('ink2', look.ink2), ('ink3', look.ink3)]) {
        for (final MapEntry(key: g, value: c) in grounds.entries) {
          expect(contrast(ink, c), greaterThanOrEqualTo(4.5), reason: '$t on $g');
        }
      }
      // Stop's word, and errors, red on their pale red.
      for (final MapEntry(key: g, value: c) in {'page': look.page, 'card': look.card}.entries) {
        expect(contrast(look.block, Color.alphaBlend(look.blockWash, c)), greaterThanOrEqualTo(4.5), reason: 'block on its wash on $g');
      }
      // Still a step between them.
      expect(contrast(look.ink2, look.card), greaterThan(contrast(look.ink3, look.card) * 1.15));
    });
  }
}
