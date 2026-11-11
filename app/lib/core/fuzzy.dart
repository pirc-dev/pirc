// Fuzzy matching for pickers. A port of web/core/fuzzy.ts: positions index
// the text's UTF-16 code units, as JavaScript's do.
class FuzzyMatch {
  const FuzzyMatch(this.score, this.positions);

  final double score;
  // Indexes into the text of the characters that matched.
  final List<int> positions;

  Map<String, Object?> toJson() => {'score': score, 'positions': positions};
}

const _separators = ' /-_.:()[]';

bool _wordStart(String text, int i) => i == 0 || _separators.contains(text[i - 1]);

FuzzyMatch? _matchWord(String word, String text) {
  FuzzyMatch? best;
  for (var at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    final score = 100 + word.length * 10 + (_wordStart(text, at) ? 50 : 0) - at * 0.1;
    if (best == null || score > best.score) best = FuzzyMatch(score, [for (var k = 0; k < word.length; k++) at + k]);
  }
  if (best != null) return best;
  for (var at = text.indexOf(word[0]); at >= 0; at = text.indexOf(word[0], at + 1)) {
    final positions = [at];
    var score = _wordStart(text, at) ? 8.0 : 0.0;
    for (var i = at + 1; i < text.length && positions.length < word.length; i++) {
      if (text[i] != word[positions.length]) continue;
      final together = positions.last == i - 1;
      if (!together && !_wordStart(text, i)) continue;
      score += together ? 5 : 8 - (i - positions.last - 1 < 10 ? i - positions.last - 1 : 10);
      positions.add(i);
    }
    if (positions.length == word.length && (best == null || score > best.score)) best = FuzzyMatch(score, positions);
  }
  return best;
}

// Lowercase letter by letter, keeping the text's length where a whole
// lowercase would change it ("İ"); Greek's final sigma as any other.
String _lower(String text) {
  final out = StringBuffer();
  for (final r in text.runes) {
    final c = String.fromCharCode(r);
    final l = c.toLowerCase();
    out.write(l.length == c.length ? l : c);
  }
  return out.toString().replaceAll('ς', 'σ');
}

final _space = RegExp(r'\s+');

// The query against the text, ignoring case; null when a word is missing.
// An empty query matches everything with no score.
FuzzyMatch? fuzzy(String query, String text) {
  final low = _lower(text);
  final seen = <int>{};
  var score = 0.0;
  for (final word in _lower(query).split(_space).where((w) => w.isNotEmpty)) {
    final m = _matchWord(word, low);
    if (m == null) return null;
    score += m.score;
    seen.addAll(m.positions);
  }
  return FuzzyMatch(score, seen.toList()..sort());
}

// The items that match, best first; ties keep their order. With no query,
// every item, in order.
List<({T item, FuzzyMatch match})> rank<T>(String query, List<T> items, String Function(T) text) {
  final out = <({T item, FuzzyMatch match, int i})>[];
  for (final (i, item) in items.indexed) {
    final match = fuzzy(query, text(item));
    if (match != null) out.add((item: item, match: match, i: i));
  }
  out.sort((a, b) {
    final c = b.match.score.compareTo(a.match.score);
    return c != 0 ? c : a.i - b.i;
  });
  return [for (final x in out) (item: x.item, match: x.match)];
}
