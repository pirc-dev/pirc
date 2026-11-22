// Opening what a computer sealed for the relay to keep (docs/e2e.md,
// section 5): a session's announcement, sealed to each client's box key,
// and its notice, sealed to each phone's notification key. Opening checks
// the copy against the slot the relay names it by and the caller's newest
// list. The steps, their order and the names of results and reasons are
// those of e2e/sealed.ts, and on a body as a computer's maker writes it
// (fields in order, each with its declared wire type, varints and lengths
// in their shortest form) the two agree on every input. A body only a
// listed computer could seal in another encoding (a known field with
// another wire type, deeply nested unknown groups) can read differently in
// different languages: protobuf-es reads a known field as its declared
// type, Dart's protobuf keeps it as an unknown field. That is by design: the
// checks defend against everyone but a listed computer, which seals each
// recipient's copy itself. No input bytes make opening throw; only a
// caller's mistake does.
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';

import '../gen/pirc/v1alpha2/account.pb.dart';
import 'bytes.dart';
import 'framed.dart';
import 'list.dart';

const announcementContext = 'pirc-e2e-v2 announcement';
const noticeContext = 'pirc-e2e-v2 notice';
const sealedMaxBytes = 65536;
const sessionIdMaxBytes = 128;
const nonceBytes = 24;
const macBytes = 16;

/// How far ahead of now an ordering value may be, in milliseconds.
const futureMs = 86400000;

const _keyBytes = 32;

/// Each field's cap in bytes of UTF-8.
const announcementCaps = {'sessionName': 200, 'folder': 1024, 'model': 200, 'computerName': 200, 'notice': 4096};
const noticeCaps = {'sessionName': 200, 'computerName': 200, 'notice': 4096};

enum SealedKind {
  announcement(announcementContext),
  notice(noticeContext);

  const SealedKind(this.context);
  final String context;
}

/// The slot a sealed copy is kept in, but for its kind: whose, from which
/// computer, for which session.
class Slot {
  const Slot({required this.accountId, required this.computerKey, required this.sessionId});

  final List<int> accountId;

  /// The computer's signing key.
  final List<int> computerKey;

  /// The session ID's UTF-8 bytes exactly as the protocol carries them.
  final List<int> sessionId;
}

/// What an opened announcement holds.
class AnnouncementText {
  const AnnouncementText({required this.sessionName, required this.folder, required this.model, required this.computerName, required this.notice});

  final String sessionName;
  final String folder;
  final String model;
  final String computerName;
  final String notice;
}

/// What an opened notice holds.
class NoticeText {
  const NoticeText({required this.sessionName, required this.computerName, required this.notice});

  final String sessionName;
  final String computerName;
  final String notice;
}

/// What opening gives: [result] is accepted or refused; [reason] is set for
/// refused; [ordering] and [body] for accepted ([body] is an
/// [AnnouncementText] or a [NoticeText]).
class OpenResult<T> {
  const OpenResult._(this.result, {this.reason, this.ordering, this.body});

  final String result;
  final String? reason;
  final Int64? ordering;
  final T? body;

  static OpenResult<T> refused<T>(String reason) => OpenResult._('refused', reason: reason);
}

/// A caller's mistake in what it passed to [SealedOpening.openSealed].
class SealedCallError extends ArgumentError {
  SealedCallError(String super.message);
}

/// Whether a session ID is 1 to 128 bytes of valid UTF-8.
bool goodSessionId(List<int> id) => id.isNotEmpty && id.length <= sessionIdMaxBytes && utf8Text(id) != null;

/// The plaintext's start for a slot: framed(context, account ID, computer
/// key, session ID), then the ordering part's length.
Uint8List _prefix(SealedKind kind, Slot slot) =>
    Uint8List.fromList([...framed(kind.context, [slot.accountId, slot.computerKey, slot.sessionId]), 8]);

extension SealedOpening on E2e {
  /// Opens a copy of a session's announcement sealed to this client's box key.
  /// [highest] is the highest ordering value seen for the slot, null if none;
  /// [now] is the time in milliseconds. [recipientSecretKey] is 32 bytes.
  OpenResult<AnnouncementText> openAnnouncement({
    required List<int> sealed,
    required Slot slot,
    required List<int> recipientSecretKey,
    required ListBody list,
    Int64? highest,
    required Int64 now,
  }) =>
      _open(SealedKind.announcement, sealed, slot, recipientSecretKey, list, highest, now, (t) {
        return AnnouncementText(
            sessionName: t['sessionName']!, folder: t['folder']!, model: t['model']!, computerName: t['computerName']!, notice: t['notice']!);
      });

  /// Opens a copy of a session's notice sealed to this phone's notification
  /// key; [recipientSecretKey] is the notification secret key. The rest is
  /// as for [openAnnouncement].
  OpenResult<NoticeText> openNotice({
    required List<int> sealed,
    required Slot slot,
    required List<int> recipientSecretKey,
    required ListBody list,
    Int64? highest,
    required Int64 now,
  }) =>
      _open(SealedKind.notice, sealed, slot, recipientSecretKey, list, highest, now, (t) {
        return NoticeText(sessionName: t['sessionName']!, computerName: t['computerName']!, notice: t['notice']!);
      });

  OpenResult<T> _open<T>(
    SealedKind kind,
    List<int> sealed,
    Slot slot,
    List<int> recipientSecretKey,
    ListBody list,
    Int64? highest,
    Int64 now,
    T Function(Map<String, String> text) make,
  ) {
    if (recipientSecretKey.length != _keyBytes) throw SealedCallError('the recipient secret key is 32 bytes');
    if (highest != null && highest.isNegative) throw SealedCallError('highest is 0 to 2^63-1, or null');
    if (now.isNegative) throw SealedCallError('now is 0 to 2^63-1');
    OpenResult<T> refused(String reason) => OpenResult.refused(reason);
    // 1. The slot as the relay names it.
    if (!goodSessionId(slot.sessionId)) return refused('slot');
    // 2. Size.
    if (sealed.length > sealedMaxBytes || sealed.length < nonceBytes + macBytes) return refused('size');
    // 3. The sender, a computer on the caller's newest list.
    final computer = list.devices.where((d) => d.role == roleComputer && bytesEqual(d.signingKey, slot.computerKey)).firstOrNull;
    if (computer == null) return refused('computer-not-listed');
    // 4. The box, from that computer's box key. Anything libsodium refuses,
    // such as a key it will not use, is a refused box.
    final bytes = Uint8List.fromList(sealed);
    final raw = Uint8List.fromList(recipientSecretKey);
    final secret = sodium.secureCopy(raw);
    raw.fillRange(0, raw.length, 0);
    final Uint8List plaintext;
    try {
      plaintext = sodium.crypto.box.openEasy(
        cipherText: Uint8List.sublistView(bytes, nonceBytes),
        nonce: Uint8List.sublistView(bytes, 0, nonceBytes),
        publicKey: Uint8List.fromList(computer.boxKey),
        secretKey: secret,
      );
    } catch (_) {
      return refused('box');
    } finally {
      secret.dispose();
    }
    // 5. The slot and kind it was sealed for, then 8 bytes of ordering.
    final start = _prefix(kind, slot);
    if (plaintext.length < start.length + 8 || !bytesEqual(Uint8List.sublistView(plaintext, 0, start.length), start)) return refused('prefix');
    // 6. The ordering value; Dart reads 2^63 and above as negative.
    final ordering = Int64.fromBytesBigEndian(Uint8List.sublistView(plaintext, start.length, start.length + 8));
    if (ordering.isNegative) return refused('range');
    if (highest != null && ordering <= highest) return refused('ordering');
    if (ordering - now > Int64(futureMs)) return refused('future');
    // 7. The body, and its text.
    final rest = Uint8List.sublistView(plaintext, start.length + 8);
    final Map<String, List<int>> fields;
    try {
      fields = switch (kind) {
        SealedKind.announcement => _announcementFields(Announcement.fromBuffer(rest)),
        SealedKind.notice => _noticeFields(Notice.fromBuffer(rest)),
      };
    } catch (_) {
      return refused('parse');
    }
    final caps = kind == SealedKind.announcement ? announcementCaps : noticeCaps;
    final text = <String, String>{};
    for (final MapEntry(key: k, value: cap) in caps.entries) {
      final b = fields[k]!;
      final t = b.length <= cap ? utf8Text(b) : null;
      if (t == null) return refused('text');
      text[k] = t;
    }
    return OpenResult._('accepted', ordering: ordering, body: make(text));
  }
}

Map<String, List<int>> _announcementFields(Announcement a) =>
    {'sessionName': a.sessionName, 'folder': a.folder, 'model': a.model, 'computerName': a.computerName, 'notice': a.notice};

Map<String, List<int>> _noticeFields(Notice n) => {'sessionName': n.sessionName, 'computerName': n.computerName, 'notice': n.notice};
