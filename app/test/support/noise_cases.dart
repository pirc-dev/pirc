// cases/noise/'s published vectors and cases/e2e/channel.json
// (cases/README.md) over the app's Noise core (lib/e2e/noise_core.dart), as
// e2e/test/channel.ts runs them. Shared by the unit test, which reads the
// files from the tree, and the integration test, which runs them on a phone
// or simulator from copies it fetches (integration_test/serve_e2e_cases.dart).
// Each file's shape is checked as strictly as the TypeScript runner checks
// it. A run gives an outcome per vector or case, with what differed.
import 'dart:convert';
import 'dart:typed_data';

import 'package:sodium/sodium_sumo.dart';

import 'package:pirc/e2e/noise.dart';
import 'package:pirc/e2e/noise_core.dart';

typedef Json = Map<String, Object?>;

/// One vector's or case's outcome: what it is, and why it failed, or null.
typedef Outcome = ({String about, String? failure});

Uint8List unhex(Object? s) {
  final h = s as String;
  if (h.length.isOdd || !RegExp(r'^[0-9a-f]*$').hasMatch(h)) throw FormatException('not hex: ${h.length > 40 ? h.substring(0, 40) : h}');
  return Uint8List.fromList([for (var i = 0; i < h.length; i += 2) int.parse(h.substring(i, i + 2), radix: 16)]);
}

String hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

bool _sameKeys(Map m, Iterable<String> keys) => m.length == keys.length && m.keys.toSet().containsAll(keys);

// ------------------------------------------------------------ cases/noise/

const patterns = {'Noise_IK_25519_ChaChaPoly_SHA512': ik, 'Noise_XXpsk3_25519_ChaChaPoly_SHA512': xxpsk3};
const _vectorKeys = {'protocol_name', 'init_prologue', 'init_static', 'init_ephemeral', 'resp_prologue', 'resp_static', 'resp_ephemeral', 'messages'};
const _vectorOptional = {'init_psks', 'init_remote_static', 'resp_psks', 'handshake_hash'};

/// Why a vector file is not the shape this runner reads, or null.
String? _vectorFileError(String name, Object? decoded) {
  if (decoded is! Map || !_sameKeys(decoded, ['about', 'source', 'commit', 'licence', 'vectors'])) return '$name: its keys';
  for (final k in ['about', 'source', 'commit', 'licence']) {
    if (decoded[k] is! String) return '$name: $k is not a string';
  }
  final commit = decoded['commit'] as String;
  if (!RegExp(r'^[0-9a-f]{40}$').hasMatch(commit)) return '$name: its commit';
  if (!(decoded['source'] as String).contains(commit)) return '$name: the source at its commit';
  final vectors = decoded['vectors'];
  if (vectors is! List || vectors.isEmpty) return '$name: no vectors';
  for (final v in vectors) {
    if (v is! Map<String, Object?>) return '$name: a vector is not an object';
    for (final k in _vectorKeys) {
      if (!v.containsKey(k)) return '$name, ${v['protocol_name']}: no $k';
    }
    for (final MapEntry(:key, :value) in v.entries) {
      if (!_vectorKeys.contains(key) && !_vectorOptional.contains(key)) return '$name, ${v['protocol_name']}: unknown key $key';
      final isList = key == 'messages' || key.endsWith('_psks');
      if (isList ? value is! List : value is! String) return '$name, ${v['protocol_name']}: $key';
    }
    if (!patterns.containsKey(v['protocol_name'])) return '$name: ${v['protocol_name']}';
    for (final m in v['messages'] as List) {
      if (m is! Map || !_sameKeys(m, ['payload', 'ciphertext']) || m['payload'] is! String || m['ciphertext'] is! String) return '$name: a message\'s keys';
    }
    for (final k in ['init_psks', 'resp_psks']) {
      for (final p in v[k] as List? ?? const []) {
        if (p is! String) return '$name: a PSK is not a string';
      }
    }
  }
  return null;
}

/// Every vector of a file of cases/noise/, through the core with payloads,
/// both sides, every message, handshake and transport.
List<Outcome> runVectors(String name, String text, SodiumSumo sodium) {
  final decoded = jsonDecode(text);
  final shape = _vectorFileError(name, decoded);
  if (shape != null) return [(about: name, failure: shape)];
  return [
    for (final v in ((decoded as Json)['vectors'] as List).cast<Json>()) (about: '$name, ${v['protocol_name']}', failure: _runVector(v, sodium)),
  ];
}

String? _runVector(Json v, SodiumSumo sodium) {
  final pattern = patterns[v['protocol_name']]!;
  Uint8List? psk(Object? p) => p is List && p.isNotEmpty ? unhex(p.first) : null;
  final keys = <SecureKey>[];
  SecureKey key(Object? hexKey) {
    final k = sodium.secureCopy(unhex(hexKey));
    keys.add(k);
    return k;
  }

  final problems = <String>[];
  try {
    final init = Handshake(
      pattern: pattern,
      initiator: true,
      staticKey: key(v['init_static']),
      remoteStatic: v['init_remote_static'] == null ? null : unhex(v['init_remote_static']),
      prologue: unhex(v['init_prologue']),
      psk: psk(v['init_psks']),
      ephemeral: unhex(v['init_ephemeral']),
      payloads: true,
    );
    final resp = Handshake(
      pattern: pattern,
      initiator: false,
      staticKey: key(v['resp_static']),
      prologue: unhex(v['resp_prologue']),
      psk: psk(v['resp_psks']),
      ephemeral: unhex(v['resp_ephemeral']),
      payloads: true,
    );
    Transport? ti;
    Transport? tr;
    final messages = (v['messages'] as List).cast<Json>();
    for (var i = 0; i < messages.length; i++) {
      final m = messages[i];
      final fromInit = i.isEven;
      final where = 'message $i';
      final payload = unhex(m['payload']);
      Uint8List sent;
      Uint8List got;
      if (i < pattern.messages.length) {
        final w = (fromInit ? init : resp).writeMessage(payload);
        if (!w.ok) return [...problems, '$where: writing failed, ${w.reason!.name}'].join('; ');
        sent = w.message!;
        if (w.transport != null) fromInit ? ti = w.transport : tr = w.transport;
        final r = (fromInit ? resp : init).readMessage(unhex(m['ciphertext']));
        if (!r.ok) return [...problems, '$where: reading failed, ${r.reason!.name}'].join('; ');
        got = r.payload!;
        if (r.transport != null) fromInit ? tr = r.transport : ti = r.transport;
      } else {
        if (ti == null || tr == null) return [...problems, '$where: no transport'].join('; ');
        final w = (fromInit ? ti : tr).send(payload);
        if (!w.ok) return [...problems, '$where: sending failed, ${w.reason!.name}'].join('; ');
        sent = w.bytes!;
        final r = (fromInit ? tr : ti).receive(unhex(m['ciphertext']));
        if (!r.ok) return [...problems, '$where: receiving failed, ${r.reason!.name}'].join('; ');
        got = r.bytes!;
      }
      if (hex(sent) != m['ciphertext']) problems.add('$where: ciphertext ${hex(sent)}');
      if (hex(got) != m['payload']) problems.add('$where: payload ${hex(got)}');
    }
    if (ti == null || tr == null) return [...problems, 'the handshake did not finish'].join('; ');
    final hash = v['handshake_hash'];
    if (hash != null) {
      if (hex(ti.handshakeHash) != hash) problems.add('the initiator\'s handshake hash');
      if (hex(tr.handshakeHash) != hash) problems.add('the responder\'s handshake hash');
    }
    ti.close();
    tr.close();
  } finally {
    for (final k in keys) {
      k.dispose();
    }
  }
  return problems.isEmpty ? null : problems.join('; ');
}

// ------------------------------------------------------- cases/e2e/channel.json

const checkPatterns = {'IK': ik, 'XXpsk3': xxpsk3};
const reasons = {'length', 'dh', 'decrypt', 'dead'};

const _partyKeys = {
  'IK initiator': ['role', 'staticKey', 'ephemeralKey', 'responderKey'],
  'IK responder': ['role', 'staticKey', 'ephemeralKey'],
  'XXpsk3 initiator': ['role', 'staticKey', 'ephemeralKey', 'prologue', 'psk'],
  'XXpsk3 responder': ['role', 'staticKey', 'ephemeralKey', 'prologue', 'psk'],
};
const _stepKeys = {
  'write': [
    ['bytes'],
    ['bytes', 'done'],
    ['fails'],
  ],
  'read': [
    ['bytes'],
    ['bytes', 'done'],
    ['bytes', 'fails'],
  ],
  'send': [
    ['plaintext', 'bytes'],
    ['plaintext', 'fails'],
    ['plaintext', 'throws'],
  ],
  'receive': [
    ['bytes', 'plaintext'],
    ['bytes', 'fails'],
  ],
};

/// A need, and what in a case makes it need it.
final Map<String, bool Function(Json)> _evidence = {
  'ik-responder': (c) => c['check'] == 'IK' && (c['parties'] as Map).values.any((p) => (p as Map)['role'] == 'responder'),
  'own-prologue': (c) => c['check'] == 'IK' && (c['parties'] as Map).values.any((p) => (p as Map).containsKey('prologue')),
  'xxpsk3': (c) => c['check'] == 'XXpsk3',
};

/// What the app's Dart has: everything, the IK responder and XXpsk3 through
/// their test entry points.
const has = {'ik-responder', 'own-prologue', 'xxpsk3'};

/// Why a case is not the shape this runner reads, or null.
String? _caseError(String where, Object? c) {
  if (c is! Map<String, Object?>) return '$where: not an object';
  if (c['about'] is! String) return '$where: no about';
  if (c['needs'] is! List || (c['needs'] as List).any((n) => n is! String)) return '$where: needs';
  final needs = (c['needs'] as List).cast<String>();
  if (c['check'] == 'prologue') {
    if (!_sameKeys(c, ['check', 'about', 'needs', 'accountId', 'bytes'])) return '$where: its keys';
    if (needs.isNotEmpty) return '$where: needs';
    if (c['accountId'] is! String || c['bytes'] is! String) return '$where: accountId and bytes';
    return null;
  }
  if (!checkPatterns.containsKey(c['check'])) return '$where: unknown check ${c['check']}';
  if (!_sameKeys(c, ['check', 'about', 'needs', 'parties', 'steps'])) return '$where: its keys';
  final parties = c['parties'];
  if (parties is! Map<String, Object?> || parties.isEmpty) return '$where: parties';
  for (final MapEntry(key: name, value: p) in parties.entries) {
    if (p is! Map<String, Object?>) return '$where: party $name';
    final shape = _partyKeys['${c['check']} ${p['role']}'];
    if (shape == null) return '$where: party $name\'s role';
    final keys = [...shape, if (c['check'] == 'IK') p.containsKey('accountId') ? 'accountId' : 'prologue'];
    if (!_sameKeys(p, keys)) return '$where: party $name\'s keys';
    if (p.values.any((x) => x is! String)) return '$where: party $name\'s values';
  }
  for (final n in needs) {
    if (!_evidence.containsKey(n)) return '$where: unknown need $n';
  }
  for (final MapEntry(key: n, value: shows) in _evidence.entries) {
    if (needs.contains(n) != shows(c)) return '$where: needs $n exactly when the case shows it';
  }
  final steps = c['steps'];
  if (steps is! List || steps.isEmpty) return '$where: no steps';
  final failed = <String>{};
  for (var i = 0; i < steps.length; i++) {
    final s = steps[i];
    final at = '$where, step $i';
    if (s is! Map<String, Object?>) return '$at: not an object';
    if (!parties.containsKey(s['party'])) return '$at: no party ${s['party']}';
    final forms = _stepKeys[s['call']];
    if (forms == null) return '$at: unknown call ${s['call']}';
    final keys = s.keys.where((k) => k != 'party' && k != 'call').toList()..sort();
    if (!forms.any((f) => (List.of(f)..sort()).join(',') == keys.join(','))) return '$at: keys ${keys.join(', ')}';
    for (final k in ['bytes', 'plaintext', 'fails']) {
      if (s.containsKey(k) && s[k] is! String) return '$at: $k is not a string';
    }
    if (s.containsKey('fails') && !reasons.contains(s['fails'])) return '$at: reason ${s['fails']}';
    if (s.containsKey('throws') && s['throws'] != true) return '$at: throws';
    final done = s['done'];
    if (done != null) {
      if (done is! Map || !_sameKeys(done, ['handshakeHash', 'remoteStatic', 'confirmed'])) return '$at: done\'s keys';
      if (done['handshakeHash'] is! String || done['remoteStatic'] is! String || done['confirmed'] is! bool) return '$at: done\'s values';
    }
    // After a failure or a throw, every call of that party gives dead.
    final party = s['party'] as String;
    if (failed.contains(party) && s['fails'] != 'dead') return '$at: not dead after a failure';
    if ((s.containsKey('fails') && s['fails'] != 'dead') || s.containsKey('throws')) failed.add(party);
  }
  return null;
}

/// Why channel.json is not the shape this runner reads, or null.
String? channelFileError(Object? decoded) {
  if (decoded is! Map || !_sameKeys(decoded, ['about', 'cases'])) return 'channel.json: its keys';
  final cases = decoded['cases'];
  if (cases is! List || cases.isEmpty) return 'channel.json: no cases';
  for (var i = 0; i < cases.length; i++) {
    final e = _caseError('channel.json, case $i', cases[i]);
    if (e != null) return e;
  }
  return null;
}

/// A party's handshake through the core, PiRC's way: no payloads; the IK
/// prologue built from the account ID as the public API builds it.
Handshake partyHandshake(String check, Json p, SecureKey staticKey) => Handshake(
      pattern: checkPatterns[check]!,
      initiator: p['role'] == 'initiator',
      staticKey: staticKey,
      remoteStatic: p.containsKey('responderKey') ? unhex(p['responderKey']) : null,
      prologue: p.containsKey('accountId') ? channelPrologue(unhex(p['accountId'])) : unhex(p['prologue']),
      psk: p.containsKey('psk') ? unhex(p['psk']) : null,
      ephemeral: unhex(p['ephemeralKey']),
      payloads: false,
    );

/// A value with every map's keys in order, so that two compare equal when
/// they hold the same.
Object? _sorted(Object? v) => switch (v) {
      Map() => {for (final k in (v.keys.cast<String>().toList()..sort())) k: _sorted(v[k])},
      List() => [for (final x in v) _sorted(x)],
      _ => v,
    };
bool _same(Object? a, Object? b) => jsonEncode(_sorted(a)) == jsonEncode(_sorted(b));

/// Which roles each case runs, by the cases' checks: for the report.
typedef Roles = Map<String, int>;

/// Every case of channel.json the app can run, how many it left out, and
/// how many parties of each pattern and role it ran.
({List<Outcome> outcomes, int left, Roles roles}) runChannel(String text, SodiumSumo sodium) {
  final decoded = jsonDecode(text);
  final shape = channelFileError(decoded);
  if (shape != null) return (outcomes: [(about: 'channel.json', failure: shape)], left: 0, roles: {});
  final out = <Outcome>[];
  final roles = <String, int>{};
  var left = 0;
  for (final c in ((decoded as Json)['cases'] as List).cast<Json>()) {
    if (!(c['needs'] as List).every(has.contains)) {
      left++;
      continue;
    }
    if (c['check'] != 'prologue') {
      for (final p in (c['parties'] as Map).values) {
        final role = '${c['check']} ${(p as Map)['role']}';
        roles[role] = (roles[role] ?? 0) + 1;
      }
    }
    out.add((about: c['about'] as String, failure: _runCase(c, sodium)));
  }
  return (outcomes: out, left: left, roles: roles);
}

String? _runCase(Json c, SodiumSumo sodium) {
  if (c['check'] == 'prologue') {
    final got = hex(channelPrologue(unhex(c['accountId'])));
    return got == c['bytes'] ? null : 'prologue $got';
  }
  final check = c['check'] as String;
  final problems = <String>[];
  final hs = <String, Handshake>{};
  final ts = <String, Transport>{};
  for (final MapEntry(key: name, value: p) in (c['parties'] as Map<String, Object?>).entries) {
    p as Json;
    // The handshake copies the key: this one is disposed at once.
    final key = sodium.secureCopy(unhex(p['staticKey']));
    try {
      hs[name] = partyHandshake(check, p, key);
    } finally {
      key.dispose();
    }
  }
  final steps = (c['steps'] as List).cast<Json>();
  for (var i = 0; i < steps.length; i++) {
    final s = steps[i];
    final party = s['party'] as String;
    final call = s['call'] as String;
    final where = 'step $i ($party $call)';
    final want = Map.of(s)
      ..remove('party')
      ..remove('call');
    Json got;
    if (call == 'write' || call == 'read') {
      final h = hs[party]!;
      final r = call == 'write' ? h.writeMessage() : h.readMessage(unhex(s['bytes']));
      if (call == 'read') want.remove('bytes');
      if (!r.ok) {
        got = {'fails': r.reason!.name};
      } else {
        got = {if (call == 'write') 'bytes': hex(r.message!)};
        final t = r.transport;
        if (t != null) {
          ts[party] = t;
          got['done'] = {'handshakeHash': hex(t.handshakeHash), 'remoteStatic': hex(t.remoteStatic!), 'confirmed': t.confirmed};
        }
      }
    } else {
      final t = ts[party];
      if (t == null) return [...problems, '$where: no transport'].join('; ');
      if (call == 'send') {
        want.remove('plaintext');
        try {
          final r = t.send(unhex(s['plaintext']));
          got = r.ok ? {'bytes': hex(r.bytes!)} : {'fails': r.reason!.name};
        } on NoiseCallError {
          got = {'throws': true};
        }
      } else {
        want.remove('bytes');
        final r = t.receive(unhex(s['bytes']));
        got = r.ok ? {'plaintext': hex(r.bytes!)} : {'fails': r.reason!.name};
        if (r.ok && !t.confirmed) problems.add('$where: not confirmed after a message decrypted');
      }
    }
    if (!_same(got, want)) {
      final g = jsonEncode(got);
      problems.add('$where: got ${g.length > 200 ? g.substring(0, 200) : g}');
    }
  }
  for (final t in ts.values) {
    t.close();
  }
  return problems.isEmpty ? null : problems.join('; ');
}
