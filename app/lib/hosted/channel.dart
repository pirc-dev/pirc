// A client's end of a channel with a pi process (docs/e2e.md, section 4;
// channel.proto): Noise IK as the initiator, knowing the computer's channel
// key from the list; the client's newest list first, then the computer's
// ListState, then the session's frames both ways, cut into pieces and sent
// no faster than the computer takes them. The computer's side is
// extension/src/channel.ts.
//
// Any fault ends the channel: a piece that does not decrypt, a bad piece,
// a frame out of place, a count that is not one. The caller opens a new one.
import 'dart:async';
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';
import 'package:sodium/sodium_sumo.dart' show SecureKey;

import '../e2e/list.dart' show E2e;
import '../e2e/noise.dart';
import '../gen/pirc/v1alpha1/common.pbenum.dart';
import '../gen/pirc/v1alpha2/channel.pb.dart';
import '../gen/pirc/v1alpha2/relay.pb.dart';

/// A piece's data: a Noise message's plaintext less its flag byte.
const pieceDataMax = 65518;
const frameMax = (1 << 20) + 4096;
const _last = 1;
const _more = 0;

// Flow, as extension/src/channel.ts has it: at most 16 Noise messages and
// 256 KiB in flight beyond the other side's count; a count once 8 messages
// or 128 KiB were taken since the last. `received` itself is outside the
// window and not counted.
const windowMessages = 16;
const windowBytes = 256 * 1024;
const ackMessages = 8;
const ackBytes = 128 * 1024;

/// The channels a client keeps at once. Each computer may have a window
/// in flight toward this phone (16 messages, 256 KiB of Noise bytes), so 8
/// keep the relay's queue toward this connection (256 frames, 4 MiB) at
/// half its caps, the frames' overhead, the computers' counts and the
/// relay's own frames included, without holding counts back.
const maxChannels = 8;

/// What the client holds back for one channel before giving it up.
const queueBytes = 4 << 20;

/// How long the computer has to answer the handshake and the list.
const openTimeout = Duration(seconds: 30);

/// A frame's pieces, each a Noise message's plaintext.
List<Uint8List> pieces(Uint8List frame) {
  final out = <Uint8List>[];
  for (var at = 0;; at += pieceDataMax) {
    final end = at + pieceDataMax >= frame.length ? frame.length : at + pieceDataMax;
    final last = end == frame.length;
    final p = Uint8List(1 + end - at);
    p[0] = last ? _last : _more;
    p.setRange(1, p.length, frame, at);
    out.add(p);
    if (last) return out;
  }
}

/// Joins pieces into frames.
class Joiner {
  final _parts = <Uint8List>[];
  var _size = 0;

  bool get empty => _parts.isEmpty;

  /// A whole frame when one ends, null for more; throws FormatException for
  /// a bad flag or past the cap.
  Uint8List? push(Uint8List piece) {
    if (piece.isEmpty || (piece[0] != _last && piece[0] != _more)) throw const FormatException('a bad piece');
    final data = Uint8List.sublistView(piece, 1);
    _size += data.length;
    if (_size > frameMax) throw const FormatException('a frame past the cap');
    _parts.add(data);
    if (piece[0] == _more) return null;
    final frame = Uint8List(_size);
    var at = 0;
    for (final p in _parts) {
      frame.setRange(at, at + p.length, p);
      at += p.length;
    }
    _parts.clear();
    _size = 0;
    return frame;
  }
}

enum ChannelPhase { opening, handshake, waiting, ready, closed }

/// What a channel tells its owner.
abstract class ChannelEvents {
  /// The computer answered the list: its counter, and its newer list if it
  /// had one, unchecked.
  void listState(HostedChannel ch, Int64 counter, Uint8List? newer);

  /// A session's frame from the computer.
  void session(HostedChannel ch, SessionFrame s);

  /// The channel is over, with why, for the log.
  void closed(HostedChannel ch, String why);
}

int _opens = 0;

class HostedChannel {
  HostedChannel({
    required E2e e2e,
    required SecureKey channelKey,
    required this.hostKey,
    required this.hostChannelKey,
    required this.instanceId,
    required Uint8List accountId,
    required this.list,
    required this.send,
    required this.events,
    Duration timeout = openTimeout,
  }) : _handshake = e2e.noise.ikInitiator(staticKey: channelKey, responderKey: hostChannelKey, accountId: accountId) {
    _timer = Timer(timeout, () => close(ErrorCode.ERROR_CODE_TIMEOUT, 'the computer did not answer in time'));
  }

  /// The computer's signing key and channel key, from the list.
  final Uint8List hostKey;
  final Uint8List hostChannelKey;
  final String instanceId;

  /// The client's newest list, sent first.
  final Uint8List list;

  /// Sends a frame to the relay; false when it could not.
  final bool Function(Frame f) send;
  final ChannelEvents events;

  final requestId = 'c${++_opens}';
  Int64? id;
  ChannelPhase phase = ChannelPhase.opening;
  NoiseHandshake? _handshake;
  NoiseTransport? _transport;
  final _joiner = Joiner();
  late final Timer _timer;

  // Pieces waiting for the window, and each message sent and not yet
  // counted, with its size, 0 for a count of ours.
  final _queue = <Uint8List>[];
  var _queued = 0;
  final _inFlight = <int>[];
  var _inFlightBytes = 0;
  var _inFlightMessages = 0;
  var _sent = Int64.ZERO;
  var _acked = Int64.ZERO;
  var _taken = Int64.ZERO;
  var _sinceMessages = 0;
  var _sinceBytes = 0;

  /// The computer's list counter, once it answered.
  Int64? hostCounter;

  /// Whether OpenChannel went to the relay.
  var sentOpen = false;

  bool get ready => phase == ChannelPhase.ready;
  bool get over => phase == ChannelPhase.closed;

  /// Sends OpenChannel with IK's first message; false when it could not.
  bool open() {
    final r = _handshake!.writeMessage();
    if (!r.ok) {
      close(ErrorCode.ERROR_CODE_INTERNAL, 'the handshake failed: ${r.reason}', tell: false);
      return false;
    }
    if (!send(Frame(openChannel: OpenChannel(requestId: requestId, hostKey: hostKey, instanceId: instanceId, message: r.message)))) {
      close(ErrorCode.ERROR_CODE_SESSION_GONE, 'not connected', tell: false);
      return false;
    }
    sentOpen = true;
    return true;
  }

  /// The relay's answer to the open.
  void opened(Int64 channelId) {
    if (phase != ChannelPhase.opening) return;
    id = channelId;
    phase = ChannelPhase.handshake;
  }

  /// The relay refused the open.
  void refused(String why) => close(ErrorCode.ERROR_CODE_SESSION_GONE, why, tell: false);

  /// A Noise message from the computer.
  void message(Uint8List m) {
    if (over) return;
    if (phase == ChannelPhase.handshake) {
      final r = _handshake!.readMessage(m);
      if (!r.ok || r.transport == null) return close(ErrorCode.ERROR_CODE_PERMISSION_DENIED, 'the computer\'s answer did not check out');
      _transport = r.transport;
      _handshake = null;
      phase = ChannelPhase.waiting;
      _queuePieces(ChannelFrame(list: list));
      _pump();
      return;
    }
    final t = _transport;
    if (t == null) return close(ErrorCode.ERROR_CODE_INVALID, 'a message before the handshake');
    final r = t.receive(m);
    if (!r.ok) return close(ErrorCode.ERROR_CODE_PERMISSION_DENIED, 'a message did not decrypt');
    final plain = r.plaintext!;
    _taken += 1;
    final whole = _joiner.empty && plain.isNotEmpty && plain[0] == _last;
    final Uint8List? frame;
    try {
      frame = _joiner.push(plain);
    } on FormatException catch (e) {
      return close(ErrorCode.ERROR_CODE_INVALID, e.message);
    }
    // A count of the computer's is not counted back.
    final counts = frame == null ? true : _frame(frame) || !whole;
    if (over) return;
    if (counts) {
      _sinceMessages++;
      _sinceBytes += m.length;
      if (_sinceMessages >= ackMessages || _sinceBytes >= ackBytes) _count();
    }
  }

  // Acts on a whole frame; false for a count of the computer's.
  bool _frame(Uint8List bytes) {
    final ChannelFrame f;
    try {
      f = ChannelFrame.fromBuffer(bytes);
    } catch (_) {
      close(ErrorCode.ERROR_CODE_INVALID, 'a frame did not parse');
      return true;
    }
    if (f.whichBody() == ChannelFrame_Body.received) {
      _ack(f.received);
      return false;
    }
    if (phase == ChannelPhase.waiting) {
      if (!f.hasListState()) {
        close(ErrorCode.ERROR_CODE_INVALID, 'the computer sent something before its list state');
        return true;
      }
      phase = ChannelPhase.ready;
      _timer.cancel();
      hostCounter = f.listState.counter;
      events.listState(this, f.listState.counter, f.listState.list.isEmpty ? null : Uint8List.fromList(f.listState.list));
      return true;
    }
    if (phase != ChannelPhase.ready) return true;
    if (f.hasSession() && f.session.sessionId.isNotEmpty) {
      events.session(this, f.session);
    } else {
      close(ErrorCode.ERROR_CODE_INVALID, 'a frame out of place');
    }
    return true;
  }

  void _count() {
    _sinceMessages = 0;
    _sinceBytes = 0;
    _transmit(pieces(ChannelFrame(received: _taken).writeToBuffer()).single, windowed: false);
  }

  void _ack(Int64 n) {
    if (n < _acked || n > _sent) return close(ErrorCode.ERROR_CODE_INVALID, 'a count of messages not sent');
    for (; _acked < n; _acked += 1) {
      final size = _inFlight.removeAt(0);
      if (size > 0) {
        _inFlightBytes -= size;
        _inFlightMessages--;
      }
    }
    _pump();
  }

  /// Sends a session's message; false if the channel is not ready.
  bool sendSession(String sessionId, Uint8List message) {
    if (!ready) return false;
    _queuePieces(ChannelFrame(session: SessionFrame(sessionId: sessionId, message: message)));
    if (_queued > queueBytes) {
      close(ErrorCode.ERROR_CODE_RATE_LIMITED, 'the computer is not reading');
      return false;
    }
    _pump();
    return ready;
  }

  void _queuePieces(ChannelFrame f) {
    for (final p in pieces(f.writeToBuffer())) {
      _queue.add(p);
      _queued += p.length;
    }
  }

  void _pump() {
    while ((phase == ChannelPhase.ready || phase == ChannelPhase.waiting) &&
        _queue.isNotEmpty &&
        _inFlightMessages < windowMessages &&
        _inFlightBytes + _queue.first.length <= windowBytes) {
      final p = _queue.removeAt(0);
      _queued -= p.length;
      _transmit(p, windowed: true);
    }
  }

  void _transmit(Uint8List p, {required bool windowed}) {
    final r = _transport!.send(p);
    if (!r.ok) return close(ErrorCode.ERROR_CODE_INTERNAL, 'encrypting failed: ${r.reason}');
    final size = r.message!.length;
    _inFlight.add(windowed ? size : 0);
    if (windowed) {
      _inFlightBytes += size;
      _inFlightMessages++;
    }
    _sent += 1;
    if (!send(Frame(channelMessage: ChannelMessage(channelId: id, message: r.message)))) {
      close(ErrorCode.ERROR_CODE_SESSION_GONE, 'not connected', tell: false);
    }
  }

  /// Ends the channel, telling the relay unless it was the relay that did.
  void close(ErrorCode code, String why, {bool tell = true}) {
    if (over) return;
    final hadId = id != null;
    phase = ChannelPhase.closed;
    _timer.cancel();
    _transport?.close();
    _transport = null;
    _handshake = null;
    _queue.clear();
    _queued = 0;
    if (tell && hadId) send(Frame(closeChannel: CloseChannel(channelId: id, code: code)));
    events.closed(this, why);
  }
}
