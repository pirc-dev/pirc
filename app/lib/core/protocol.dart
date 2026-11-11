// Small helpers over the generated types. A port of protocol/helpers.ts.
import 'package:protobuf/protobuf.dart';
import 'package:protobuf/well_known_types/google/protobuf/timestamp.pb.dart';

import '../gen/pirc/v1alpha1/common.pb.dart';
import '../gen/pirc/v1alpha1/session.pb.dart';

export '../gen/pirc/v1alpha1/common.pb.dart';
export '../gen/pirc/v1alpha1/common.pbenum.dart';
export '../gen/pirc/v1alpha1/relay.pb.dart';
export '../gen/pirc/v1alpha1/relay.pbenum.dart';
export '../gen/pirc/v1alpha1/session.pb.dart';
export '../gen/pirc/v1alpha1/session.pbenum.dart';
export 'package:protobuf/well_known_types/google/protobuf/timestamp.pb.dart' show Timestamp;

SessionMessage errorReply(String requestId, ErrorCode code, String message) =>
    SessionMessage(error: Error(requestId: requestId, code: code, message: message));

// The message in a message's oneof (a frame's or a session message's
// body); null when none is set.
GeneratedMessage? bodyOf(GeneratedMessage m) {
  final tag = m.$_whichOneof(0);
  return tag == 0 ? null : m.getField(tag) as GeneratedMessage;
}

// A request's name as SessionAnnouncement.requests lists it: its field in
// SessionMessage ("list_past_sessions").
String requestName(SessionMessage m) {
  final tag = m.$_whichOneof(0);
  return tag == 0 ? '' : m.info_.fieldInfo[tag]!.protoName;
}

// The request ID of a request or a reply's body; "" for one without.
String requestIdOf(GeneratedMessage? body) {
  final f = body?.info_.byName['requestId'];
  return f == null ? '' : body!.getField(f.tagNumber) as String;
}

String hex(List<int> b) => [for (final x in b) x.toRadixString(16).padLeft(2, '0')].join();

bool sameBytes(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

bool sameRef(SessionRef a, SessionRef b) => a.sessionId == b.sessionId && a.instanceId == b.instanceId && sameBytes(a.hostKey, b.hostKey);

// ErrorCode's name without its prefix, e.g. "BUSY".
String errorName(ErrorCode code) => code.name.replaceFirst('ERROR_CODE_', '');

// pi's names for its thinking levels, as PiRC's clients show them.
const thinkingNames = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// A level's name; null for UNSPECIFIED, or a level newer than this code.
String? thinkingName(ThinkingLevel level) {
  final i = level.value - ThinkingLevel.THINKING_LEVEL_OFF.value;
  return i >= 0 && i < thinkingNames.length ? thinkingNames[i] : null;
}

// Milliseconds since the epoch, as @bufbuild/protobuf's timestampMs.
int timestampMs(Timestamp t) => t.seconds.toInt() * 1000 + (t.nanos / 1000000).round();
