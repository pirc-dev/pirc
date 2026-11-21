// A device's view of its account's list (docs/e2e.md, section 3): the
// branch it follows from version 1, the versions it has seen off that
// branch, and the withdrawals. Versions are taken only when they check
// against the version they chain from, and the branch only grows: it
// follows a version when it is the only one chaining from its tip, and
// nothing, a withdrawal least of all, takes one off it. Two versions of
// one number are a fork, which the caller acts on, unless the one off the
// branch was withdrawn by its own signer: the device is then on the side
// that won.
// A port of crypto/chain.ts; persisted by the caller as `saved()` and
// loaded again with `Chain.load`.
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';

import '../gen/pirc/v1alpha2/e2e.pb.dart';
import 'bytes.dart';
import 'list.dart';
import 'objects.dart' as objects;
import 'u64.dart';

class RefusedObject {
  RefusedObject(this.object, this.reason);
  final SignedObject object;
  final String reason;
}

// What a change did: versions taken onto the branch, the forks the device
// holds (forks()), and objects refused. A branch only grows.
class Change {
  final taken = <Version>[];
  final forks = <Version>[];
  final refused = <RefusedObject>[];
}

class Saved {
  Saved(this.branch, this.others, this.withdrawals);
  final List<SignedObject> branch;
  final List<SignedObject> others;
  final List<SignedObject> withdrawals;
}

const _cmp = compareU64;

// How many withdrawals of versions not seen a chain keeps, in all and of
// one signer.
const maxUnchecked = 64;
const maxUncheckedPerSigner = 8;

class Chain {
  Chain._(this.accountId, Version first) : _branch = [first];

  final Uint8List accountId;
  final List<Version> _branch;
  // Every checked version off the branch, by hash.
  final _others = <String, Version>{};
  // Withdrawals checked against the version they withdraw, by its hash.
  final _withdrawn = <String, SignedObject>{};
  // Withdrawals of versions not seen, kept to check when they are, and to pass on.
  final _unchecked = <String, SignedObject>{};

  // From version 1, which the account ID must be the hash of.
  static Future<Chain> start(SignedObject v1, [List<int>? accountId]) async {
    final first = await checkFirst(v1);
    if (accountId != null && !equal(first.hash, accountId)) throw Refused("version 1 is not this account's");
    return Chain._(first.hash, first);
  }

  // A chain as saved: the branch replayed first, so that the same branch is followed.
  static Future<Chain> load(Saved s, [List<int>? accountId]) async {
    if (s.branch.isEmpty) throw Refused('no version 1');
    final c = await Chain.start(s.branch.first, accountId);
    // The branch alone first: with the others beside it, a fork this
    // client had taken a side of would read as undecided again.
    final branch = await c.add(s.branch.skip(1).toList());
    final rest = await c.add(s.others, s.withdrawals);
    final refused = [...branch.refused, ...rest.refused];
    if (refused.isNotEmpty) throw Refused('saved chain: ${refused.first.reason}');
    return c;
  }

  Version get latest => _branch.last;

  // The branch's version with that number, if it reaches it.
  Version? at(Int64 number) {
    final i = number.toInt() - 1;
    return i >= 0 && i < _branch.length ? _branch[i] : null;
  }

  // The branch's versions from `from` on.
  List<Version> from(Int64 from) {
    // Compared unsigned before it is an index: from 2^63 on, toInt() is
    // negative.
    if (compareU64(from, Int64(_branch.length)) > 0) return const [];
    final i = from.toInt() - 1;
    return _branch.sublist(i < 0 ? 0 : i);
  }

  List<Version> get branch => List.unmodifiable(_branch);

  // Every withdrawal known, checked or not.
  // In hash order, then the signer's, so that the same withdrawals save
  // the same bytes in any order.
  List<SignedObject> withdrawals() {
    final all = [..._withdrawn.values, ..._unchecked.values];
    String order(SignedObject w) {
      final b = WithdrawalBody.fromBuffer(w.body);
      return '${hex(b.withdrawn.hash)}/${hex(b.signer)}';
    }

    return all..sort((a, b) => order(a).compareTo(order(b)));
  }

  bool isWithdrawn(List<int> h) => _withdrawn.containsKey(hex(h));

  List<Version> _nextOf(String tip) => [for (final v in _others.values) if (hex(v.body.previous) == tip) v];

  // A fork at the branch's tip: two versions or more chaining from it, so
  // that this device adopted neither (docs/e2e.md, section 3, Forks).
  Version? undecided() {
    final next = _nextOf(hex(latest.hash));
    return next.length > 1 ? next.first : null;
  }

  // The forks this device holds: each version off the branch that chains
  // from it, unless its own signer withdrew it, which says the device is
  // on the side that won an honest race. A withdrawn version on the branch
  // explains nothing: the device is on the side that lost, and the fork
  // stands, whatever else is withdrawn beside it.
  List<Version> forks() {
    final onBranch = {for (final v in _branch) hex(v.hash)};
    bool stands(Version v) {
      final mine = at(v.body.number);
      return !_withdrawn.containsKey(hex(v.hash)) || (mine != null && _withdrawn.containsKey(hex(mine.hash)));
    }

    return [
      for (final v in _others.values)
        if (onBranch.contains(hex(v.body.previous)) && stands(v)) v
    ];
  }

  // Whether number and hash name a version on the branch.
  bool onBranch(Int64 number, List<int> h) {
    final v = at(number);
    return v != null && equal(v.hash, h);
  }

  Saved saved() {
    final others = _others.values.toList()
      ..sort((a, b) {
        final n = _cmp(a.body.number, b.body.number);
        return n != 0 ? n : hex(a.hash).compareTo(hex(b.hash));
      });
    return Saved([for (final v in _branch) v.object], [for (final v in others) v.object], withdrawals());
  }

  Version? _known(String h) {
    final o = _others[h];
    if (o != null) return o;
    for (final v in _branch) {
      if (hex(v.hash) == h) return v;
    }
    return null;
  }

  // Takes versions (any order) and withdrawals, as a relay or a request carries them.
  Future<Change> add(List<SignedObject> versions, [List<SignedObject> withdrawals = const []]) async {
    final change = Change();
    final pending = <({SignedObject obj, Int64 number, String previous, String hash})>[];
    for (final obj in versions) {
      final body = await objects.open(objects.Kind.list, accountId, obj);
      if (body == null) {
        change.refused.add(RefusedObject(obj, 'the signature does not check, or the body names another signer'));
        continue;
      }
      pending.add((obj: obj, number: body.number, previous: hex(body.previous), hash: hex(await objects.hash(obj))));
    }
    // Oldest first, so that each finds the one it chains from; by hash
    // within a number, so that every language takes them in one order.
    pending.sort((a, b) {
      final n = _cmp(a.number, b.number);
      return n != 0 ? n : a.hash.compareTo(b.hash);
    });
    for (final p in pending) {
      if (_known(p.hash) != null) continue;
      final parent = _known(p.previous);
      if (parent == null || parent.body.number + 1 != p.number) {
        change.refused.add(RefusedObject(p.obj, 'does not chain from a version this device has'));
        continue;
      }
      try {
        _others[p.hash] = await checkNext(accountId, parent, p.obj);
      } on Refused catch (e) {
        change.refused.add(RefusedObject(p.obj, e.message));
      }
    }
    for (final w in [...withdrawals, ..._unchecked.values]) {
      await _takeWithdrawal(w, change);
    }
    _settle(change);
    return change;
  }

  // A withdrawal counts once its version and the winner it names are both
  // here, and only if the winner is what docs/e2e.md (section 3, Adopting
  // a version) says a withdrawal names: another device's version of the
  // same number, chaining from the same version. A device removed since
  // has no such version to name, so it cannot take back an old one of its
  // own and send every device back to a list it is on. It depends on the
  // versions alone, never on this device's branch, so that the same
  // objects give the same withdrawals in any order, and on a load.
  Future<void> _takeWithdrawal(SignedObject obj, Change change) async {
    final body = await objects.open(objects.Kind.withdrawal, accountId, obj);
    final key = body != null && body.hasWithdrawn() ? hex(body.withdrawn.hash) : '';
    if (body == null || key.isEmpty) {
      change.refused.add(RefusedObject(obj, 'the signature does not check, or the body names another signer'));
      return;
    }
    // Kept until it can be checked by hash, signer and winner: another key
    // naming the same hash first, or the signer naming another winner, does
    // not take its place.
    final slot = '$key/${hex(body.signer)}/${hex(body.winner.hash)}';
    if (_withdrawn.containsKey(key)) {
      _unchecked.remove(slot);
      return;
    }
    final v = _known(key);
    final winner = body.hasWinner() ? _known(hex(body.winner.hash)) : null;
    if (v == null || winner == null) {
      // Kept to check when both come, and to pass on: only one signed by
      // a key some version has as a client, and only so many, so that a
      // relay cannot grow what every later version must carry.
      if (![..._branch, ..._others.values].any((x) => isClient(x.body, body.signer))) {
        change.refused.add(RefusedObject(obj, 'a withdrawal of a version not seen, by a key no version has as a client'));
        return;
      }
      if (!_unchecked.containsKey(slot)) {
        // A few per signer, the oldest let go first, so that one key, a
        // removed device's, cannot push out the others'.
        final mine = [for (final MapEntry(:key, :value) in _unchecked.entries) if (equal(_signerOf(value), body.signer)) key];
        if (mine.length >= maxUncheckedPerSigner) _unchecked.remove(mine.first);
        if (_unchecked.length >= maxUnchecked) _unchecked.remove(_unchecked.keys.first);
      }
      _unchecked[slot] = obj;
      return;
    }
    _unchecked.remove(slot);
    try {
      await checkWithdrawal(accountId, v, obj);
    } on Refused catch (e) {
      change.refused.add(RefusedObject(obj, e.message));
      return;
    }
    if (winner.body.number != v.body.number || !equal(winner.body.previous, v.body.previous) || equal(winner.body.signer, v.body.signer)) {
      change.refused.add(RefusedObject(obj, "the winner it names is not another device's version beside it"));
      return;
    }
    _withdrawn[key] = obj;
  }

  static List<int> _signerOf(SignedObject w) => WithdrawalBody.fromBuffer(w.body).signer;

  // Follows the branch as far as one version leads, and finds the forks.
  //
  // A device never leaves the branch it follows, whatever a withdrawal
  // says (docs/e2e.md, section 3, Forks): with an honest relay no device
  // but its signer ever holds a version that lost, so none needs to, and
  // a withdrawal signed by a device removed since must not be able to
  // move it back to a list that device is on. Nor does a withdrawal choose
  // for it at a fork it has not taken a side of: it takes neither.
  void _settle(Change change) {
    for (;;) {
      final next = _nextOf(hex(latest.hash));
      if (next.length != 1) break;
      final n = next.single;
      _others.remove(hex(n.hash));
      _branch.add(n);
      change.taken.add(n);
    }
    change.forks.addAll(forks());
  }
}
