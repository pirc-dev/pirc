// The account's device list (docs/e2e.md, section 3): checking a version
// against the one before it, a withdrawal against the version it
// withdraws, and a pre-key against the list. Pure, so that the relay, the
// hosts and the clients decide alike; cases/e2e holds what they must
// decide. A port of crypto/list.ts.
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';
import 'package:protobuf/well_known_types/google/protobuf/timestamp.pb.dart';

import '../gen/pirc/v1alpha2/e2e.pb.dart';
import 'bytes.dart';
import 'objects.dart' as objects;

class Version {
  Version(this.body, this.hash, this.object);
  final ListVersionBody body;
  final Uint8List hash;
  final SignedObject object;
}

// Why a version, a withdrawal or a pre-key is refused.
class Refused implements Exception {
  Refused(this.message);
  final String message;

  @override
  String toString() => 'Refused: $message';
}

const _roles = {DeviceRole.DEVICE_ROLE_HOST, DeviceRole.DEVICE_ROLE_CLIENT, DeviceRole.DEVICE_ROLE_READ_ONLY};
// An account's caps (docs/e2e.md, section 3): 256 hosts, and 32 clients,
// each with at most its read-only key.
const maxHosts = 256;
const maxClients = 32;

// Why devices hold more of a role than the caps allow; null when they do not.
String? overCaps(Iterable<Device> devices) {
  int n(DeviceRole r) => devices.where((d) => d.role == r).length;
  if (n(DeviceRole.DEVICE_ROLE_HOST) > maxHosts) return 'more than 256 hosts';
  if (n(DeviceRole.DEVICE_ROLE_CLIENT) > maxClients || n(DeviceRole.DEVICE_ROLE_READ_ONLY) > maxClients) return 'more than 32 clients';
  return null;
}

// Milliseconds since 1970, or -1 when the time is not there.
BigInt _time(bool present, Timestamp t) =>
    present ? BigInt.parse(t.seconds.toString()) * BigInt.from(1000) + BigInt.from((t.nanos / 1e6).floor()) : -BigInt.one;

// A uint64 as the number it is (an Int64 holds its bits).
BigInt _u64(Int64 n) => BigInt.parse(n.toStringUnsigned());

Device? device(ListVersionBody v, List<int> key) {
  for (final d in v.devices) {
    if (equal(d.publicKey, key)) return d;
  }
  return null;
}

bool isClient(ListVersionBody v, List<int> key) => device(v, key)?.role == DeviceRole.DEVICE_ROLE_CLIENT;

// What every version must be on its own.
void _checkShape(ListVersionBody v) {
  if (v.devices.isEmpty || v.devices.length > maxHosts + 2 * maxClients) throw Refused('wrong number of devices');
  final over = overCaps(v.devices);
  if (over != null) throw Refused(over);
  for (var i = 0; i < v.devices.length; i++) {
    final d = v.devices[i];
    if (d.publicKey.length != 32) throw Refused('a device key is not 32 bytes');
    if (!_roles.contains(d.role)) throw Refused('a device has no role');
    if (i > 0 && compare(v.devices[i - 1].publicKey, d.publicKey) >= 0) {
      throw Refused('devices not in order, or repeated');
    }
    if (!d.hasAddedAt()) throw Refused('a device has no time added');
    if (d.role == DeviceRole.DEVICE_ROLE_READ_ONLY) {
      if (!isClient(v, d.owner)) throw Refused('a read-only key whose client is not on the list');
    } else if (d.owner.isNotEmpty) {
      throw Refused('an owner on a device that is not a read-only key');
    }
  }
  if (!v.devices.any((d) => d.role == DeviceRole.DEVICE_ROLE_CLIENT)) throw Refused('no client left');
  if (v.withdrawn.any((h) => h.length != 32)) throw Refused('a withdrawn hash is not 32 bytes');
}

const _badSignature = 'the signature does not check, or the body names another signer';

// Version 1: its body's hash is the account ID; one client, which signs it.
Future<Version> checkFirst(SignedObject obj) async {
  final body = await objects.open(objects.Kind.list, empty, obj);
  if (body == null) throw Refused(_badSignature);
  if (body.number != Int64.ONE || body.previous.isNotEmpty) throw Refused('not version 1');
  _checkShape(body);
  final d = body.devices.first;
  if (body.devices.length != 1 || d.role != DeviceRole.DEVICE_ROLE_CLIENT) throw Refused('version 1 holds one client');
  if (!equal(d.publicKey, body.signer) || d.addedBy.isNotEmpty) throw Refused('version 1 is signed by its one device');
  if (body.withdrawn.isNotEmpty) throw Refused('version 1 withdraws nothing');
  return Version(body, await objects.hash(obj), obj);
}

// A version after prev: chained, signed by a client in prev, changing devices only as a client may.
Future<Version> checkNext(List<int> accountId, Version prev, SignedObject obj) async {
  final body = await objects.open(objects.Kind.list, accountId, obj);
  if (body == null) throw Refused(_badSignature);
  if (_u64(body.number) != _u64(prev.body.number) + BigInt.one) throw Refused('not the next number');
  if (!equal(body.previous, prev.hash)) throw Refused('does not chain from the version before');
  if (!isClient(prev.body, body.signer)) throw Refused('not signed by a client in the version before');
  _checkShape(body);
  for (final d in body.devices) {
    final before = device(prev.body, d.publicKey);
    if (before != null) {
      if (before.role != d.role ||
          !equal(before.addedBy, d.addedBy) ||
          !equal(before.owner, d.owner) ||
          _time(before.hasAddedAt(), before.addedAt) != _time(d.hasAddedAt(), d.addedAt)) {
        throw Refused('a device kept but changed');
      }
    } else {
      if (!equal(d.addedBy, body.signer)) throw Refused('a new device not added by the signer');
      if (d.role == DeviceRole.DEVICE_ROLE_READ_ONLY && !equal(d.owner, body.signer)) {
        throw Refused('a read-only key added by another client than its own');
      }
    }
  }
  for (final h in prev.body.withdrawn) {
    if (!body.withdrawn.any((w) => equal(w, h))) throw Refused('a withdrawal dropped');
  }
  return Version(body, await objects.hash(obj), obj);
}

// A withdrawal of withdrawn, by its own signer, in favour of another version with its number.
Future<WithdrawalBody> checkWithdrawal(List<int> accountId, Version withdrawn, SignedObject obj) async {
  final body = await objects.open(objects.Kind.withdrawal, accountId, obj);
  if (body == null) throw Refused(_badSignature);
  if (!equal(body.signer, withdrawn.body.signer)) throw Refused('not withdrawn by its own signer');
  final w = body.withdrawn, win = body.winner;
  if (!body.hasWithdrawn() || !body.hasWinner() || w.number != withdrawn.body.number || !equal(w.hash, withdrawn.hash)) {
    throw Refused('names another version');
  }
  if (win.number != w.number || win.hash.length != 32 || equal(win.hash, w.hash)) {
    throw Refused('the winner is not another version with its number');
  }
  return body;
}

final preKeyMaxMs = BigInt.from(14 * 24 * 3600 * 1000);

// A pre-key of a client or a read-only key on list, current at nowMs.
Future<PreKeyBody> checkPreKey(List<int> accountId, ListVersionBody list, SignedObject obj, int nowMs) async {
  final body = await objects.open(objects.Kind.preKey, accountId, obj);
  if (body == null) throw Refused(_badSignature);
  final role = device(list, body.signer)?.role;
  if (role != DeviceRole.DEVICE_ROLE_CLIENT && role != DeviceRole.DEVICE_ROLE_READ_ONLY) {
    throw Refused("not a client's or a read-only key's");
  }
  if (body.preKey.length != 32) throw Refused('the pre-key is not 32 bytes');
  final made = _time(body.hasMadeAt(), body.madeAt), expires = _time(body.hasExpiresAt(), body.expiresAt);
  if (made < BigInt.zero || expires <= made || expires - made > preKeyMaxMs) throw Refused('lives longer than 14 days');
  if (BigInt.from(nowMs) >= expires) throw Refused('expired');
  return body;
}
