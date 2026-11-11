// Scanning a join code with the camera: what the camera is for, said once
// before the system asks for it; then the camera, which closes on the first
// PiRC join link it reads, giving it back. Nothing it sees is kept.
import 'package:flutter/cupertino.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../join.dart';
import 'look.dart';

const _white = Color(0xFFFFFFFF);
const _black = Color(0xFF000000);

class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key, required this.explained, required this.onExplained});

  // Whether what the camera is for has been said before.
  final bool explained;
  final VoidCallback onExplained;

  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  late var _explained = widget.explained;
  String? _wrong;
  var _done = false;
  // The camera refused or failed: its page shows, without the frame.
  var _refused = false;

  void _seen(BarcodeCapture capture) {
    if (_done) return;
    for (final b in capture.barcodes) {
      final v = b.rawValue;
      if (v == null) continue;
      if (parseJoinLink(v) != null) {
        _done = true;
        Navigator.of(context).pop(v);
        return;
      }
      if (_wrong == null) {
        setState(() => _wrong = 'That code is not a PiRC join link.');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final cancel = CupertinoButton(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      onPressed: () => Navigator.of(context).pop(),
      child: Text('Cancel', style: look.text(color: _explained ? _white : look.accent)),
    );
    if (!_explained) {
      return CupertinoPageScaffold(
        backgroundColor: look.page,
        child: SafeArea(
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Align(alignment: Alignment.centerLeft, child: cancel),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 32),
                child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                  Icon(CupertinoIcons.qrcode_viewfinder, size: 56, color: look.accent),
                  const SizedBox(height: 20),
                  Text('Scan the join code', textAlign: TextAlign.center, style: look.text(size: 24, weight: FontWeight.w700)),
                  const SizedBox(height: 12),
                  Text(
                    'PiRC uses the camera only to read the code from "Add an app", and keeps no picture. '
                    'Your phone will ask next whether PiRC may use it.',
                    textAlign: TextAlign.center,
                    style: look.text(size: 16, color: look.ink2, height: 1.45),
                  ),
                  const SizedBox(height: 28),
                  CupertinoButton.filled(
                    onPressed: () {
                      widget.onExplained();
                      setState(() => _explained = true);
                    },
                    child: Text('Continue', style: look.text(color: look.onAccent, weight: FontWeight.w600)),
                  ),
                ]),
              ),
            ),
          ]),
        ),
      );
    }
    return CupertinoPageScaffold(
      backgroundColor: _black,
      child: Stack(fit: StackFit.expand, children: [
        MobileScanner(
          onDetect: _seen,
          errorBuilder: (context, error) {
            if (!_refused) {
              WidgetsBinding.instance.addPostFrameCallback((_) {
                if (mounted) setState(() => _refused = true);
              });
            }
            return _Refused(error);
          },
        ),
        // Where to hold the code.
        if (!_refused)
          Center(
            child: Container(
              width: 240,
              height: 240,
              decoration: BoxDecoration(border: Border.all(color: const Color(0xCCFFFFFF), width: 2), borderRadius: BorderRadius.circular(24)),
            ),
          ),
        SafeArea(
          child: Column(children: [
            Align(alignment: Alignment.centerLeft, child: cancel),
            const Spacer(),
            if (!_refused)
              Padding(
                padding: const EdgeInsets.fromLTRB(32, 0, 32, 32),
                child: Text(
                  _wrong ?? 'Point the camera at the code from "Add an app".',
                  textAlign: TextAlign.center,
                  style: look.text(size: 16, color: _white, height: 1.4),
                ),
              ),
          ]),
        ),
      ]),
    );
  }
}

// The camera refused or missing: what to do instead.
class _Refused extends StatelessWidget {
  const _Refused(this.error);
  final MobileScannerException error;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final denied = error.errorCode == MobileScannerErrorCode.permissionDenied;
    return ColoredBox(
      color: _black,
      child: Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32),
          child: Text(
            denied
                ? "PiRC may not use the camera. Allow it in the phone's Settings, under PiRC, or go back and paste the link instead."
                : 'The camera could not start${error.errorDetails?.message == null ? '' : ': ${error.errorDetails!.message}'}. Go back and paste the link instead.',
            textAlign: TextAlign.center,
            style: look.text(size: 16, color: _white, height: 1.45),
          ),
        ),
      ),
    );
  }
}
