// The shared cases of cases/e2e/ (cases/README.md) that the app's Dart
// runs: framed.json, list.json, and the opening and names of sealed.json
// and names.json. Shared by the unit test, which reads
// the files from the tree, and the integration test, which runs them on a
// phone or simulator from copies it fetches (integration_test/serve_e2e_cases.dart). Each file's shape is
// checked as strictly as the TypeScript and Go runners check it.
import 'dart:convert';
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';
import 'package:sodium/sodium_sumo.dart';

import 'package:pirc/e2e/bytes.dart';
import 'package:pirc/e2e/framed.dart';
import 'package:pirc/e2e/list.dart';
import 'package:pirc/e2e/names.dart';
import 'package:pirc/e2e/sealed.dart';
import 'package:pirc/gen/pirc/v1alpha2/account.pb.dart';

/// The parts the app has: it checks lists in both modes, at a join, and
/// makes them; opens announcements, notices and names, and makes names. It
/// does not seal: a computer does, in TypeScript.
const has = {'first-mode', 'self', 'make-list', 'announcement', 'notice', 'names', 'make-names'};

typedef Json = Map<String, Object?>;

Uint8List _unhex(Object? s) {
  final h = s as String;
  if (h.length.isOdd || !RegExp(r'^[0-9a-f]*$').hasMatch(h)) throw FormatException('not hex: $h');
  return Uint8List.fromList([for (var i = 0; i < h.length; i += 2) int.parse(h.substring(i, i + 2), radix: 16)]);
}

String _hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

/// A JSON value's type, as the shape tables name it.
String _type(Object? v) => switch (v) {
      String() => 'string',
      List() => 'array',
      Map() => 'object',
      bool() => 'bool',
      int() => 'number',
      _ => 'none',
    };

const _keyTypes = {
  'check': 'string', 'about': 'string', 'context': 'string', 'value': 'string', 'bytes': 'string', //
  'phoneKey': 'string', 'mode': 'string', 'highest': 'string', 'accountId': 'string', 'seed': 'string',
  'counter': 'string', 'previousBody': 'string', 'key': 'string', 'message': 'string', 'signature': 'string',
  'sealed': 'string', 'recipientSecretKey': 'string', 'now': 'string', 'boxSecretKey': 'string', 'ordering': 'string',
  'phoneSeed': 'string', 'phoneBoxSecretKey': 'string',
  'needs': 'array', 'parts': 'array', 'devices': 'array', 'nonces': 'array', 'recipientSecretKeys': 'array', 'names': 'array',
  'expect': 'object', 'go': 'object', 'self': 'object', 'slot': 'object', 'list': 'object', 'body': 'object',
  'valid': 'bool', 'throws': 'bool',
};

class _Shape {
  const _Shape(this.required, {this.optional = const [], this.oneOf = const [], this.expectKeys = _expectKeys});
  final List<String> required;
  final List<String> optional;
  final List<String> oneOf;

  /// The keys expect (and go) may hold; a result, or the throws that stands in for it, or for copies.
  final Set<String> expectKeys;
}

const _shapes = {
  'framed': _Shape(['check', 'about', 'needs', 'context', 'parts'], oneOf: ['bytes', 'throws']),
  'number': _Shape(['check', 'about', 'needs', 'value'], oneOf: ['bytes', 'throws']),
  'list': _Shape(['check', 'about', 'needs', 'bytes', 'phoneKey', 'mode', 'highest', 'expect'], optional: ['accountId', 'self', 'go']),
  'make-list': _Shape(['check', 'about', 'needs', 'seed', 'accountId', 'counter', 'previousBody', 'devices', 'bytes']),
  'verify': _Shape(['check', 'about', 'needs', 'key', 'message', 'signature', 'valid']),
  'open': _Shape(['check', 'about', 'needs', 'sealed', 'slot', 'recipientSecretKey', 'list', 'now', 'expect'],
      optional: ['highest'], expectKeys: {'result', 'reason', 'ordering', 'body'}),
  'seal': _Shape(['check', 'about', 'needs', 'list', 'boxSecretKey', 'slot', 'ordering', 'body', 'nonces', 'recipientSecretKeys', 'expect'],
      expectKeys: {'copies', 'skipped', 'opened', 'throws'}),
  'open-names': _Shape(['check', 'about', 'needs', 'sealed', 'accountId', 'list', 'phoneKey', 'recipientSecretKey', 'now', 'expect'],
      optional: ['highest'], expectKeys: {'result', 'reason', 'ordering', 'listCounter', 'names', 'dropped'}),
  'make-names': _Shape(['check', 'about', 'needs', 'accountId', 'list', 'phoneSeed', 'phoneBoxSecretKey', 'ordering', 'names', 'nonces', 'expect'],
      expectKeys: {'copies', 'skipped'}),
};
const _expectKeys = {'result', 'reason', 'counter', 'hash', 'list', 'throws'};
const _slotKeys = {'accountId', 'computerKey', 'sessionId', 'kind'};
const _deviceKeys = {'role', 'signingKey', 'channelKey', 'boxKey', 'readOnlyKey', 'notificationKey'};
const _listKeys = {'accountId', 'counter', 'previousHash', 'devices'};

/// A need, and what in a case makes it need it.
final Map<String, bool Function(Json)> _evidence = {
  'first-mode': (c) => c['mode'] == 'first',
  'self': (c) => c.containsKey('self'),
  'make-list': (c) => c['check'] == 'make-list',
  'seal': (c) => c['check'] == 'seal',
  'announcement': (c) => c['check'] == 'open' && (c['slot'] as Map?)?['kind'] == 'announcement',
  'notice': (c) => c['check'] == 'open' && (c['slot'] as Map?)?['kind'] == 'notice',
  'names': (c) => c['check'] == 'open-names',
  'make-names': (c) => c['check'] == 'make-names',
};

/// The checks each file holds.
const _checks = {
  'framed.json': {'framed', 'number'},
  'list.json': {'list', 'make-list', 'verify'},
  'sealed.json': {'open', 'seal'},
  'names.json': {'open-names', 'make-names'},
};

/// Why a file is not the shape this runner reads, or null.
String? _shapeError(String name, Json file) {
  if (!(file.keys.toSet().containsAll(['about', 'cases']) && file.length == 2)) return '$name: its keys are not about and cases';
  final cases = file['cases'];
  if (cases is! List || cases.isEmpty) return '$name: no cases';
  for (var i = 0; i < cases.length; i++) {
    final c = cases[i];
    final where = '$name, case $i';
    if (c is! Map<String, Object?>) return '$where: not an object';
    final shape = _checks[name]!.contains(c['check']) ? _shapes[c['check']] : null;
    if (shape == null) return '$where: check ${c['check']} is not one of $name\'s';
    for (final k in shape.required) {
      if (!c.containsKey(k)) return '$where: no $k';
    }
    if (shape.oneOf.isNotEmpty && shape.oneOf.where(c.containsKey).length != 1) return '$where: not exactly one of ${shape.oneOf}';
    final allowed = {...shape.required, ...shape.optional, ...shape.oneOf};
    for (final MapEntry(:key, :value) in c.entries) {
      if (!allowed.contains(key)) return '$where: key $key is not a ${c['check']} case\'s';
      if (_type(value) != _keyTypes[key]) return '$where: $key is ${_type(value)}';
    }
    final needs = c['needs'] as List;
    for (final n in needs) {
      if (n is! String) return '$where: a need is not a string';
    }
    // A list case in first mode needs first-mode; other checks have no mode.
    for (final MapEntry(key: need, value: shows) in _evidence.entries) {
      if (needs.contains(need) != shows(c)) return '$where: needs $need exactly when the case shows it';
    }
    for (final n in needs) {
      if (!_evidence.containsKey(n)) return '$where: unknown need $n';
    }
    for (final k in ['expect', 'go']) {
      final e = c[k];
      if (e == null) continue;
      e as Map<String, Object?>;
      for (final ek in e.keys) {
        if (!shape.expectKeys.contains(ek)) return '$where: unknown key $k.$ek';
      }
      final standsFor = shape.expectKeys.contains('result') ? 'result' : 'copies';
      if (e.containsKey(standsFor) == e.containsKey('throws')) return '$where: $k has not exactly one of $standsFor and throws';
      final l = e['list'];
      if (l != null) {
        if (l is! Map || !(l.keys.toSet().containsAll(_listKeys) && l.length == _listKeys.length)) return '$where: $k.list\'s keys';
        for (final d in l['devices'] as List) {
          if (d is! Map || !(d.keys.toSet().containsAll(_deviceKeys) && d.length == _deviceKeys.length)) return '$where: a listed device\'s keys';
        }
      }
    }
    for (final d in [if (c['self'] != null) c['self'], ...(c['devices'] as List? ?? const [])]) {
      if (d is! Map || !(d.keys.toSet().containsAll(_deviceKeys) && d.length == _deviceKeys.length)) return '$where: a device\'s keys';
    }
    final slot = c['slot'];
    if (slot != null && (slot is! Map || slot.length != _slotKeys.length || !slot.keys.toSet().containsAll(_slotKeys))) return '$where: the slot\'s keys';
    final view = c['list'];
    if (view != null) {
      if (view is! Map || view.length != 2 || !view.keys.toSet().containsAll(['counter', 'devices'])) return '$where: the list\'s keys';
      for (final d in view['devices'] as List) {
        if (d is! Map || !(d.keys.toSet().containsAll(_deviceKeys) && d.length == _deviceKeys.length)) return '$where: a list device\'s keys';
      }
    }
    for (final n in c['names'] as List? ?? const []) {
      if (n is! Map || n.length != 2 || !n.keys.toSet().containsAll(['signingKey', 'name'])) return '$where: a name\'s keys';
    }
  }
  return null;
}

Device _device(Object? j) {
  final d = j as Json;
  return Device(
    role: d['role'] as int,
    signingKey: _unhex(d['signingKey']),
    channelKey: _unhex(d['channelKey']),
    boxKey: _unhex(d['boxKey']),
    readOnlyKey: _unhex(d['readOnlyKey']),
    notificationKey: _unhex(d['notificationKey']),
  );
}

Json _deviceJson(Device d) => {
      'role': d.role,
      'signingKey': _hex(d.signingKey),
      'channelKey': _hex(d.channelKey),
      'boxKey': _hex(d.boxKey),
      'readOnlyKey': _hex(d.readOnlyKey),
      'notificationKey': _hex(d.notificationKey),
    };

/// An unsigned 64-bit decimal as Dart's Int64 holds it, 2^63 and above as
/// negative; a decimal outside 0 to 2^64-1 is a mistake in the file.
Int64 _u64(Object? s) {
  final v = BigInt.parse(s as String);
  if (v.isNegative || v.bitLength > 64) throw FormatException('not a 64-bit unsigned number: $s');
  return Int64.parseHex(v.toRadixString(16));
}

/// A check's result as the files write it.
Json expectOf(ListResult r) => {
      'result': r.result,
      if (r.reason != null) 'reason': r.reason,
      if (r.counter != null) 'counter': r.counter!.toStringUnsigned(),
      if (r.hash != null) 'hash': _hex(r.hash!),
      if (r.list != null)
        'list': {
          'accountId': _hex(r.list!.accountId),
          'counter': r.list!.counter.toStringUnsigned(),
          'previousHash': _hex(r.list!.previousHash),
          'devices': [for (final d in r.list!.devices) _deviceJson(d)],
        },
    };

/// One case's outcome: what it is, and why it failed, or null.
typedef Outcome = ({String about, String? failure});

bool _runnable(Json c) => (c['needs'] as List).every(has.contains);

/// Every case of framed.json the app can run: all of them.
List<Outcome> runFramed(String text) {
  final file = jsonDecode(text) as Json;
  final shape = _shapeError('framed.json', file);
  if (shape != null) return [(about: 'the file', failure: shape)];
  final out = <Outcome>[];
  for (final c in (file['cases'] as List).cast<Json>()) {
    final about = c['about'] as String;
    if (!_runnable(c)) {
      out.add((about: about, failure: 'needs what the app lacks'));
      continue;
    }
    Uint8List run() => c['check'] == 'framed'
        ? framed(c['context'] as String, [for (final p in c['parts'] as List) _unhex(p)])
        : framedNumber(_u64(c['value']));
    String? failure;
    if (c['throws'] == true) {
      // A context the rule refuses is an ArgumentError; a number out of
      // range, a RangeError, as framed.dart throws them.
      try {
        run();
        failure = 'did not throw';
      } on RangeError {
        failure = c['check'] == 'number' ? null : 'threw a RangeError, not an ArgumentError';
      } on ArgumentError {
        failure = c['check'] == 'framed' ? null : 'threw an ArgumentError, not a RangeError';
      }
    } else {
      final got = _hex(run());
      failure = got == c['bytes'] ? null : 'gave $got';
    }
    out.add((about: about, failure: failure));
  }
  return out;
}

/// Every case of list.json the app can run, and how many it left out.
({List<Outcome> outcomes, int left}) runList(String text, E2e e2e, SodiumSumo sodium) {
  final file = jsonDecode(text) as Json;
  final shape = _shapeError('list.json', file);
  if (shape != null) return (outcomes: [(about: 'the file', failure: shape)], left: 0);
  final out = <Outcome>[];
  var left = 0;
  for (final c in (file['cases'] as List).cast<Json>()) {
    final about = c['about'] as String;
    if (!_runnable(c)) {
      left++;
      continue;
    }
    String? failure;
    switch (c['check']) {
      case 'verify':
        bool got;
        try {
          got = sodium.crypto.sign.verifyDetached(message: _unhex(c['message']), signature: _unhex(c['signature']), publicKey: _unhex(c['key']));
        } catch (_) {
          got = false;
        }
        failure = got == c['valid'] ? null : 'verify gave $got';
      case 'make-list':
        final accountId = _unhex(c['accountId']);
        final previous = _unhex(c['previousBody']);
        final phone = sodium.crypto.sign.seedKeyPair(sodium.secureCopy(_unhex(c['seed'])));
        final got = e2e.makeList(
          phone: phone,
          devices: [for (final d in c['devices'] as List) _device(d)],
          accountId: accountId.isEmpty ? null : accountId,
          previousBody: previous.isEmpty ? null : previous,
          counter: _u64(c['counter']),
        );
        failure = _hex(got) == c['bytes'] ? null : 'made ${_hex(got)}';
      case 'list':
        final mode = switch (c['mode']) {
          'first' => ListMode.first,
          'later' => ListMode.later,
          _ => null,
        };
        if (mode == null) {
          failure = 'unknown mode ${c['mode']}';
          break;
        }
        ListResult check() => e2e.checkList(
              bytes: _unhex(c['bytes']),
              phoneKey: _unhex(c['phoneKey']),
              mode: mode,
              accountId: c.containsKey('accountId') ? _unhex(c['accountId']) : null,
              highest: _u64(c['highest']),
              self: c.containsKey('self') ? _device(c['self']) : null,
            );
        final want = c['expect'] as Json;
        if (want['throws'] == true) {
          try {
            check();
            failure = 'did not throw';
          } on ListCallError {
            failure = null;
          }
        } else {
          final got = jsonEncode(expectOf(check()));
          failure = got == jsonEncode(want) ? null : 'gave $got';
        }
      default:
        failure = 'unknown check ${c['check']}';
    }
    out.add((about: about, failure: failure));
  }
  return (outcomes: out, left: left);
}

ListBody _listBody(Object? j) {
  final l = j as Json;
  return ListBody(counter: _u64(l['counter']), devices: [for (final d in l['devices'] as List) _device(d)]);
}

Slot _slot(Object? j) {
  final s = j as Json;
  return Slot(accountId: _unhex(s['accountId']), computerKey: _unhex(s['computerKey']), sessionId: _unhex(s['sessionId']));
}

/// A value with every map's keys in order, so that two compare equal when
/// they hold the same, as the other runners' deep equality does.
Object? _sorted(Object? v) => switch (v) {
      Map() => {for (final k in (v.keys.toList()..sort())) k: _sorted(v[k])},
      List() => [for (final x in v) _sorted(x)],
      _ => v,
    };

String? _differs(Json got, Object? want) {
  final g = jsonEncode(_sorted(got));
  return g == jsonEncode(_sorted(want)) ? null : 'gave $g';
}

Json _textJson(Object body) => switch (body) {
      AnnouncementText b => {'sessionName': b.sessionName, 'folder': b.folder, 'model': b.model, 'computerName': b.computerName, 'notice': b.notice},
      NoticeText b => {'sessionName': b.sessionName, 'computerName': b.computerName, 'notice': b.notice},
      _ => throw ArgumentError('not a body'),
    };

/// An opened announcement or notice as the files write it.
Json openExpectOf(OpenResult<Object> r) => r.result == 'accepted'
    ? {'result': r.result, 'ordering': r.ordering!.toStringUnsigned(), 'body': _textJson(r.body!)}
    : {'result': r.result, 'reason': r.reason};

/// Opened names as the files write them.
Json namesExpectOf(NamesResult r) {
  List<Json> named(List<DeviceName> ns) => [for (final n in ns) {'signingKey': hexOf(n.signingKey), 'name': n.name}];
  return switch (r.result) {
    'accepted' => {
        'result': r.result,
        'ordering': r.ordering!.toStringUnsigned(),
        'listCounter': r.listCounter!.toStringUnsigned(),
        'names': named(r.names),
        'dropped': named(r.dropped),
      },
    'later' => {'result': r.result},
    _ => {'result': r.result, 'reason': r.reason},
  };
}

/// Every case of sealed.json the app can run, and how many it left out:
/// the copies it opens, announcements and notices; sealing is a computer's.
({List<Outcome> outcomes, int left}) runSealed(String text, E2e e2e) {
  final file = jsonDecode(text) as Json;
  final shape = _shapeError('sealed.json', file);
  if (shape != null) return (outcomes: [(about: 'the file', failure: shape)], left: 0);
  final out = <Outcome>[];
  var left = 0;
  for (final c in (file['cases'] as List).cast<Json>()) {
    if (!_runnable(c)) {
      left++;
      continue;
    }
    final slot = c['slot'] as Json;
    final list = _listBody(c['list']);
    final highest = c.containsKey('highest') ? _u64(c['highest']) : null;
    final args = (
      sealed: _unhex(c['sealed']),
      slot: _slot(slot),
      recipientSecretKey: _unhex(c['recipientSecretKey']),
      list: list,
      highest: highest,
      now: _u64(c['now']),
    );
    final OpenResult<Object> got = switch (slot['kind']) {
      'announcement' => e2e.openAnnouncement(
          sealed: args.sealed, slot: args.slot, recipientSecretKey: args.recipientSecretKey, list: args.list, highest: args.highest, now: args.now),
      'notice' => e2e.openNotice(
          sealed: args.sealed, slot: args.slot, recipientSecretKey: args.recipientSecretKey, list: args.list, highest: args.highest, now: args.now),
      _ => OpenResult.refused('unknown kind ${slot['kind']}'),
    };
    out.add((about: c['about'] as String, failure: _differs(openExpectOf(got), c['expect'])));
  }
  return (outcomes: out, left: left);
}

/// Every case of names.json the app can run: all of them. Opening, and
/// making to exact bytes.
({List<Outcome> outcomes, int left}) runNames(String text, E2e e2e, SodiumSumo sodium) {
  final file = jsonDecode(text) as Json;
  final shape = _shapeError('names.json', file);
  if (shape != null) return (outcomes: [(about: 'the file', failure: shape)], left: 0);
  final out = <Outcome>[];
  var left = 0;
  for (final c in (file['cases'] as List).cast<Json>()) {
    final about = c['about'] as String;
    if (!_runnable(c)) {
      left++;
      continue;
    }
    String? failure;
    if (c['check'] == 'open-names') {
      final got = e2e.openNames(
        sealed: _unhex(c['sealed']),
        accountId: _unhex(c['accountId']),
        list: _listBody(c['list']),
        phoneKey: _unhex(c['phoneKey']),
        recipientSecretKey: _unhex(c['recipientSecretKey']),
        highest: c.containsKey('highest') ? _u64(c['highest']) : null,
        now: _u64(c['now']),
      );
      failure = _differs(namesExpectOf(got), c['expect']);
    } else {
      final nonces = [for (final n in c['nonces'] as List) _unhex(n)];
      final box = sodium.secureCopy(_unhex(c['phoneBoxSecretKey']));
      try {
        final made = e2e.makeNamesWithNonces(
          accountId: _unhex(c['accountId']),
          list: _listBody(c['list']),
          phone: sodium.crypto.sign.seedKeyPair(sodium.secureCopy(_unhex(c['phoneSeed']))),
          phoneBoxSecretKey: box,
          ordering: _u64(c['ordering']),
          names: [for (final n in c['names'] as List) DeviceName(_unhex((n as Json)['signingKey']), n['name'] as String)],
          nonceFor: (i) => nonces[i],
        );
        failure = _differs({
          'copies': [for (final x in made.copies) {'signingKey': hexOf(x.signingKey), 'recipientKey': hexOf(x.recipientKey), 'sealed': hexOf(x.sealed)}],
          'skipped': [for (final k in made.skipped) hexOf(k)],
        }, c['expect']);
      } finally {
        box.dispose();
      }
    }
    out.add((about: about, failure: failure));
  }
  return (outcomes: out, left: left);
}
