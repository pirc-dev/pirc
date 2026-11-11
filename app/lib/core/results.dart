// A session's answers to requests, as results. A port of
// web/core/results.ts; a result is the TypeScript's JSON.
import 'protocol.dart';
import 'view.dart';

class Outcome {
  const Outcome.ok(Json this.result)
      : ok = true,
        code = '',
        message = '';
  const Outcome.failed(this.code, this.message)
      : ok = false,
        result = null;

  final bool ok;
  // The result, with its "kind": accepted, models, stats, pastSessions or
  // tree.
  final Json? result;
  // ErrorCode's name without its prefix, e.g. "BUSY", "TIMEOUT".
  final String code;
  final String message;

  Json toJson() => ok ? {'ok': true, 'result': result} : {'ok': false, 'code': code, 'message': message};
}

int _ms(Timestamp t) => timestampMs(t);

Outcome outcome(SessionMessage m) {
  switch (m.whichBody()) {
    case SessionMessage_Body.accepted:
      return const Outcome.ok({'kind': 'accepted'});
    case SessionMessage_Body.error:
      return Outcome.failed(errorName(m.error.code), m.error.message);
    case SessionMessage_Body.models:
      Json? choice(ModelInfo i) => i.hasModel()
          ? {
              'model': {'provider': i.model.provider, 'id': i.model.id, 'name': i.model.name},
              'reasoning': i.reasoning,
              'contextWindow': i.contextWindow.toInt(),
              'images': i.images,
            }
          : null;
      final v = m.models;
      final current = v.hasCurrent() ? choice(v.current) : null;
      return Outcome.ok({
        'kind': 'models',
        'models': [for (final i in v.models) ?choice(i)],
        'current': ?current,
      });
    case SessionMessage_Body.stats:
      final v = m.stats;
      final t = v.total;
      return Outcome.ok({
        'kind': 'stats',
        'cost': t.cost,
        'input': t.inputTokens.toInt(),
        'output': t.outputTokens.toInt(),
        'cacheRead': t.cacheReadTokens.toInt(),
        'cacheWrite': t.cacheWriteTokens.toInt(),
        if (v.hasContextTokens()) 'contextTokens': v.contextTokens.toInt(),
        'contextWindow': v.contextWindow.toInt(),
      });
    case SessionMessage_Body.pastSessions:
      final v = m.pastSessions;
      return Outcome.ok({
        'kind': 'pastSessions',
        'sessions': [
          for (final p in v.sessions)
            {
              'path': p.path,
              'sessionId': p.sessionId,
              'cwd': p.cwd,
              'name': p.name,
              'firstPrompt': p.firstPrompt,
              'created': p.hasCreatedAt() ? _ms(p.createdAt) : 0,
              'modified': p.hasModifiedAt() ? _ms(p.modifiedAt) : 0,
              'messages': p.messageCount,
            },
        ],
        'truncated': v.truncated,
      });
    case SessionMessage_Body.tree:
      final v = m.tree;
      return Outcome.ok({
        'kind': 'tree',
        'branches': [
          for (final x in v.branches)
            {
              'leafId': x.leafId,
              'current': x.current,
              'prompt': x.prompt,
              'last': x.last,
              'modified': x.hasModifiedAt() ? _ms(x.modifiedAt) : 0,
              'messages': x.messageCount,
            },
        ],
        'truncated': v.truncated,
      });
    default:
      final name = requestName(m);
      return Outcome.failed('INVALID', 'unexpected answer: ${name.isEmpty ? 'empty' : _camel(name)}');
  }
}

// "past_sessions" as TypeScript's oneof case, "pastSessions".
String _camel(String s) => s.replaceAllMapped(RegExp(r'_([a-z])'), (m) => m[1]!.toUpperCase());
