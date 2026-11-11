// The protocol's Dart types, generated from proto/ (buf.gen.dart.yaml),
// read every frame of the recorded exchanges as the shared cases write
// them: Protocol Buffers' JSON form, with Routed payloads given as
// "message" and session entries' as "announcement" (cases/README.md).
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/gen/pirc/v1alpha1/relay.pb.dart';
import 'package:pirc/gen/pirc/v1alpha1/session.pb.dart';

// Parses the decoded payloads out of a frame, and returns the frame without
// them.
Map<String, dynamic> payloads(Map<String, dynamic> frame) {
  final f = Map<String, dynamic>.of(frame);
  Map<String, dynamic> entry(Map<String, dynamic> e) {
    final out = Map<String, dynamic>.of(e);
    final a = out.remove('announcement');
    if (a != null) SessionAnnouncement().mergeFromProto3Json(a);
    return out;
  }

  final routed = f['routed'] as Map<String, dynamic>?;
  if (routed != null) {
    final r = Map<String, dynamic>.of(routed);
    final m = r.remove('message');
    if (m != null) SessionMessage().mergeFromProto3Json(m);
    f['routed'] = r;
  }
  final list = f['sessionList'] as Map<String, dynamic>?;
  if (list != null) {
    f['sessionList'] = {
      ...list,
      'sessions': [for (final e in (list['sessions'] as List? ?? [])) entry(e as Map<String, dynamic>)],
    };
  }
  final updated = f['sessionUpdated'] as Map<String, dynamic>?;
  if (updated != null) f['sessionUpdated'] = {'entry': entry(updated['entry'] as Map<String, dynamic>)};
  return f;
}

void main() {
  test('every frame in the recorded exchanges parses, sent or received', () {
    final files = Directory('../cases/exchanges').listSync().whereType<File>().where((f) => f.path.endsWith('.json')).toList();
    expect(files, isNotEmpty);
    var n = 0;
    for (final f in files) {
      final steps = (jsonDecode(f.readAsStringSync()) as Map<String, dynamic>)['steps'] as List;
      for (final step in steps.cast<Map<String, dynamic>>()) {
        final frames = [if (step['in'] != null) step['in'], ...(step['sent'] as List? ?? [])];
        for (final frame in frames.cast<Map<String, dynamic>>()) {
          final parsed = Frame()..mergeFromProto3Json(payloads(frame));
          expect(parsed.whichBody(), isNot(Frame_Body.notSet), reason: '${f.path}: $frame');
          n++;
        }
      }
    }
    expect(n, greaterThan(50));
  });
}
