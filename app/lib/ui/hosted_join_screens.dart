// The screens of a join on a hosted account (docs/e2e.md, section 6),
// only in a build with PIRC_HOSTED:
//
//   - AddDeviceScreen, at the account's phone: the code scanned or pasted;
//     then, once the new device's offer has checked out, what is about to
//     happen by role, in words; the person confirms that they hold, or sit
//     at, the device showing the code; then the outcome.
//   - ShowCodeScreen, at a phone joining an account: the code as a QR code
//     and as text, how long it works, then the outcome.
import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import '../hosted/join.dart';
import 'invite.dart' show QrView;
import 'look.dart';

/// The account's phone's side of a join, as the screen uses it (AddDevice).
abstract interface class DeviceAdder {
  Future<Offered> start(String text);

  /// The version published; JoinFailed, perhaps carrying one, otherwise.
  Future<Uint8List> confirm();
  void cancel();

  /// Completes when the device ends the join.
  Future<void> get ended;
}

/// AddDevice as the screen uses it.
class AddDeviceAdder implements DeviceAdder {
  AddDeviceAdder(this.add);
  final AddDevice add;
  @override
  Future<Offered> start(String text) => add.start(text);
  @override
  Future<Uint8List> confirm() => add.confirm();
  @override
  void cancel() => add.cancel();
  @override
  Future<void> get ended => add.ended;
}

/// What the phone says a device will be able to do, by role, before
/// anything is added: [computers] is how many the account has now.
String offeredText(Offered o, int computers) {
  if (o.isComputer) return 'A computer: you will be able to control it from here.';
  final all = switch (computers) {
    0 => 'every computer you add to this account',
    1 => 'your computer',
    _ => 'all $computers of your computers',
  };
  return o.isPhone ? 'Another phone: it will have full control of $all.' : 'A new browser or app: it will have full control of $all.';
}

enum _Step { code, checking, offered, adding, added, failed }

class AddDeviceScreen extends StatefulWidget {
  const AddDeviceScreen({super.key, required this.adder, required this.computers, required this.published, this.scan});

  /// A version of the list the relay took: the account's newest from now
  /// on, whether or not the join then finished.
  final void Function(Uint8List list) published;

  /// A fresh join's side, for each code tried.
  final DeviceAdder Function() adder;

  /// The account's computers now.
  final int computers;

  /// Opens the camera for a QR code; null where there is none.
  final Future<String?> Function()? scan;

  @override
  State<AddDeviceScreen> createState() => _AddDeviceScreenState();
}

class _AddDeviceScreenState extends State<AddDeviceScreen> {
  final _text = TextEditingController();
  var _step = _Step.code;
  DeviceAdder? _adder;
  Offered? _offered;
  String? _error;

  @override
  void dispose() {
    // Leaving before the end declines: the device is told, nothing is added.
    if (_step == _Step.checking || _step == _Step.offered) _adder?.cancel();
    _text.dispose();
    super.dispose();
  }

  Future<void> _go(String text) async {
    if (text.trim().isEmpty) return;
    final adder = widget.adder();
    setState(() {
      _adder = adder;
      _step = _Step.checking;
      _error = null;
    });
    try {
      final o = await adder.start(text);
      if (!mounted) return adder.cancel();
      setState(() {
        _offered = o;
        _step = _Step.offered;
      });
      // The device may end the join while the person is asked.
      unawaited(adder.ended.then((_) {
        if (mounted && identical(_adder, adder) && _step == _Step.offered) {
          setState(() {
            _step = _Step.failed;
            _error = 'the device ended the join; nothing was added';
          });
        }
      }));
    } catch (e) {
      if (mounted) {
        setState(() {
          _step = _Step.code;
          _error = e is JoinFailed ? e.message : 'the join failed: $e';
        });
      }
    }
  }

  Future<void> _confirm() async {
    setState(() => _step = _Step.adding);
    try {
      widget.published(await _adder!.confirm());
      if (mounted) setState(() => _step = _Step.added);
    } catch (e) {
      if (e is JoinFailed && e.published != null) widget.published(e.published!);
      if (mounted) {
        setState(() {
          _step = _Step.failed;
          _error = e is JoinFailed ? e.message : 'the join failed: $e';
        });
      }
    }
  }

  void _decline() {
    _adder?.cancel();
    Navigator.of(context).maybePop();
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final busy = _step == _Step.checking || _step == _Step.adding;
    final children = switch (_step) {
      _Step.code || _Step.checking => [
          _title(look, 'Add a device', 'On the computer, run /pirc join; in a browser or on another phone, open its join screen. '
              'Then scan the code it shows, or paste its text below.'),
          if (widget.scan != null) ...[
            CupertinoButton.filled(
              onPressed: busy
                  ? null
                  : () async {
                      final text = await widget.scan!();
                      if (text != null) await _go(text);
                    },
              child: Text('Scan the code', style: look.text(color: look.onAccent, weight: FontWeight.w600)),
            ),
            const SizedBox(height: 20),
          ],
          CupertinoTextField(
            controller: _text,
            placeholder: 'PIRC1…',
            placeholderStyle: look.text(color: look.secondary),
            style: look.text(),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: look.card, borderRadius: BorderRadius.circular(10)),
            autocorrect: false,
            enableSuggestions: false,
            enabled: !busy,
          ),
          const SizedBox(height: 10),
          CupertinoButton(
            onPressed: busy ? null : () => _go(_text.text),
            child: busy ? const CupertinoActivityIndicator() : Text('Use the text', style: look.text(color: look.accent)),
          ),
          if (_error != null) Text(_error!, textAlign: TextAlign.center, style: look.text(size: 15, color: look.failed)),
        ],
      _Step.offered || _Step.adding => [
          _title(look, 'Is this your device?', offeredText(_offered!, widget.computers)),
          Text(
            'Go on only if you are holding, or sitting at, the device that shows this code. '
            'Anyone who has the code could otherwise join their own device to your account.',
            textAlign: TextAlign.center,
            style: look.text(size: 15, color: look.secondary),
          ),
          const SizedBox(height: 28),
          CupertinoButton.filled(
            onPressed: busy ? null : _confirm,
            child: busy ? CupertinoActivityIndicator(color: look.onAccent) : Text('It is mine: add it', style: look.text(color: look.onAccent, weight: FontWeight.w600)),
          ),
          const SizedBox(height: 10),
          CupertinoButton(onPressed: busy ? null : _decline, child: Text('Cancel', style: look.text(color: look.accent))),
        ],
      _Step.added => [
          _title(look, 'Added', _offered!.isComputer ? 'The computer is on your account. Its sessions show here once pi runs there.' : 'The device is on your account.'),
          CupertinoButton(onPressed: () => Navigator.of(context).maybePop(), child: Text('Done', style: look.text(color: look.accent))),
        ],
      _Step.failed => [
          _title(look, 'Not added', _error ?? ''),
          CupertinoButton(onPressed: () => Navigator.of(context).maybePop(), child: Text('Close', style: look.text(color: look.accent))),
        ],
    };
    return CupertinoPageScaffold(
      backgroundColor: look.page,
      navigationBar: CupertinoNavigationBar(backgroundColor: look.page, border: null),
      child: SafeArea(child: ListView(padding: const EdgeInsets.fromLTRB(24, 12, 24, 24), children: children)),
    );
  }
}

Widget _title(Look look, String title, String sub) => Padding(
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(children: [
        Text(title, textAlign: TextAlign.center, style: look.text(size: 28, weight: FontWeight.w700)),
        const SizedBox(height: 10),
        Text(sub, textAlign: TextAlign.center, style: look.text(size: 15, color: look.secondary)),
      ]),
    );

/// A phone joining an account: its code until the join ends.
class ShowCodeScreen extends StatefulWidget {
  const ShowCodeScreen({super.key, required this.text, required this.done, required this.cancel, this.joined});

  final String text;
  final Future<Joined> done;
  final VoidCallback cancel;

  /// Once joined, what to do next (the app's: on to the account).
  final void Function(Joined j)? joined;

  @override
  State<ShowCodeScreen> createState() => _ShowCodeScreenState();
}

class _ShowCodeScreenState extends State<ShowCodeScreen> {
  Joined? _joined;
  String? _error;

  @override
  void initState() {
    super.initState();
    widget.done.then((j) {
      if (!mounted) return;
      setState(() => _joined = j);
      widget.joined?.call(j);
    }, onError: (Object e) {
      if (mounted) setState(() => _error = e is JoinFailed ? e.message : '$e');
    });
  }

  @override
  void dispose() {
    if (_joined == null && _error == null) widget.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final j = _joined;
    final List<Widget> children = j != null
        ? [_title(look, 'Joined', "Approved by '${j.phoneName.isEmpty ? "the account's phone" : j.phoneName}'.")]
        : _error != null
            ? [_title(look, 'Not joined', _error!)]
            : [
                _title(look, 'Join an account', "On the account's phone, open Settings, tap Add a device, and scan this code or paste its text. "
                    'Keep it to yourself: whoever uses it first puts this phone on their account. It works once, for ten minutes.'),
                Center(child: QrView(widget.text)),
                const SizedBox(height: 16),
                Text(widget.text, textAlign: TextAlign.center, style: look.text(size: 13, color: look.secondary)),
                CupertinoButton(
                  onPressed: () => Clipboard.setData(ClipboardData(text: widget.text)),
                  child: Text('Copy the text', style: look.text(color: look.accent)),
                ),
              ];
    return CupertinoPageScaffold(
      backgroundColor: look.page,
      navigationBar: CupertinoNavigationBar(backgroundColor: look.page, border: null),
      child: SafeArea(child: ListView(padding: const EdgeInsets.fromLTRB(24, 12, 24, 24), children: children)),
    );
  }
}
