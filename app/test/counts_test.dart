// The list's counts: each session once, by its status.
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc/core/view.dart';
import 'package:pirc/ui/look.dart';

SessionView session(String id, {bool working = false, bool asks = false}) => SessionView(
      id: id,
      sessionId: id,
      hostLabel: 'laptop',
      hostname: 'laptop',
      name: '',
      cwd: '/src',
      working: working,
      compacting: false,
      piVersion: '1.5.2',
      extensionVersion: '0.3.8',
      questions: asks ? const [QuestionView(id: 'q', kind: 'confirm', title: 'Sure?', answerable: true, askedAt: 0)] : null,
    );

void main() {
  test('a session that asks, works and finished since last opened counts once, as asking', () {
    final c = counts([session('a', working: true, asks: true), session('b', working: true), session('c'), session('d')], {'a', 'b', 'c'});
    expect((c.asking, c.working, c.fresh), (1, 1, 1), reason: 'd idle: with it, four in all');
  });
}
