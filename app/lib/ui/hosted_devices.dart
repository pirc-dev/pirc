// A hosted account's devices, for Settings (docs/e2e.md, sections 3 and
// 6): the computers, then the phones and browsers, from the newest list,
// each online or not, under the name the account's phone gave it (or a
// computer's own); a computer not yet on the newest version says so. On the
// account's phone, a device tapped is renamed, and "Add a device" opens the
// join; another phone shows the list only.
import 'package:flutter/cupertino.dart';

import '../app/model.dart';
import '../core/view.dart';
import 'look.dart';
import 'sheet.dart';
import 'adaptive.dart';

/// What the screens do with the account, as the app gives it.
abstract interface class HostedDevices {
  /// Whether this phone is the account's phone, which alone changes it.
  bool get isPhone;

  /// The computers not yet on the newest list, by key as DeviceView has it.
  Set<String> get behind;

  /// Opens the join of a new device.
  void addDevice(BuildContext context);

  /// Gives a device a name; why not, or null once done.
  Future<String?> rename(String key, String name);

  /// Takes a device off the account; why not, or null once the relay has
  /// the version without it.
  Future<String?> remove(String key);
}

/// What removing a device does, by role, before anything is asked.
String removalText(DeviceView d) => d.role == 'host'
    ? 'Its sessions end here, and no phone or browser of this account can reach it any more. To bring it back, run /pirc join on it and add it again.'
    : 'It loses every computer of this account at once, and forgets the account. To bring it back, add it again.';

String hostedName(DeviceView d) =>
    d.self ? 'This phone' : d.label.isNotEmpty ? d.label : d.role == 'host' ? 'A computer' : 'A phone or browser';

class HostedDeviceList extends StatelessWidget {
  const HostedDeviceList({super.key, required this.model, required this.role, required this.devices});
  final PircModel model;

  /// "host" or "client".
  final String role;
  final HostedDevices devices;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return ListenableBuilder(
      listenable: model,
      builder: (context, _) {
        if (model.relay.state != 'ready') {
          return Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Text('Not connected to the relay.', style: look.text(size: 14, color: look.ink2, spacing: 0)),
          );
        }
        final listed = [for (final d in model.client.snapshot().devices) if (d.role == role) d];
        final shown = [...listed.where((d) => d.self), ...listed.where((d) => !d.self)];
        final behind = devices.behind;
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (shown.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Text(role == 'host' ? 'No computers yet.' : 'No other phones or browsers.', style: look.text(size: 14, color: look.ink2, spacing: 0)),
            ),
          for (final (i, d) in shown.indexed) ...[
            if (i > 0) Container(height: 0.5, color: look.rule),
            _Row(
              d,
              behind: behind.contains(d.key),
              onTap: devices.isPhone ? () => showSheet<void>(context, (_) => _RenameSheet(device: d, rename: devices.rename, remove: d.self ? null : devices.remove)) : null,
            ),
          ],
          if (devices.isPhone) ...[
            if (shown.isNotEmpty) Container(height: 0.5, color: look.rule),
            _Add('Add a device', onTap: () => devices.addDevice(context)),
          ],
        ]);
      },
    );
  }
}

class _Row extends StatelessWidget {
  const _Row(this.d, {required this.behind, this.onTap});
  final DeviceView d;
  final bool behind;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final line = '${d.online ? 'Online' : 'Offline'}${d.push ? ' · Notifications on' : ''}';
    return Semantics(
      button: onTap != null,
      label: '${hostedName(d)}${onTap != null ? ': rename' : ''}',
      excludeSemantics: true,
      onTap: onTap,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 56),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          child: Row(spacing: 12, children: [
            Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(shape: BoxShape.circle, color: d.online ? look.done : null, border: d.online ? null : Border.all(color: look.ink3)),
            ),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(hostedName(d), maxLines: 1, overflow: TextOverflow.ellipsis, style: look.text(size: 16, spacing: 0)),
                Text(line, maxLines: 1, overflow: TextOverflow.ellipsis, style: look.text(size: 13, color: look.ink2, spacing: 0)),
                if (behind) Text('Has not yet confirmed the latest change to this account', style: look.text(size: 13, color: look.block, spacing: 0)),
              ]),
            ),
            if (onTap != null) Icon(CupertinoIcons.chevron_right, size: 14, color: look.ink3),
          ]),
        ),
      ),
    );
  }
}

class _Add extends StatelessWidget {
  const _Add(this.label, {required this.onTap});
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      onTap: onTap,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 52),
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Row(spacing: 12, children: [
            Icon(CupertinoIcons.plus, size: 18, color: look.accent),
            Text(label, style: look.text(size: 16, color: look.accent, spacing: 0)),
          ]),
        ),
      ),
    );
  }
}

class _RenameSheet extends StatefulWidget {
  const _RenameSheet({required this.device, required this.rename, this.remove});
  final DeviceView device;
  final Future<String?> Function(String key, String name) rename;

  /// None for this phone, which the list always holds.
  final Future<String?> Function(String key)? remove;

  @override
  State<_RenameSheet> createState() => _RenameSheetState();
}

class _RenameSheetState extends State<_RenameSheet> {
  late final _name = TextEditingController(text: widget.device.label);
  var _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  // Asked first, by what removing does.
  Future<void> _remove() async {
    if (_busy) return;
    final d = widget.device;
    final sure = await showAlert<bool>(
      context,
      title: Text('Remove ${hostedName(d)}?'),
      content: Text(removalText(d)),
      actions: [AlertAction('Cancel', false), AlertAction('Remove', true, destructive: true)],
    );
    if (sure != true || !mounted) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    String? error;
    try {
      error = await widget.remove!(d.key);
    } on Object catch (e) {
      error = '$e';
    }
    if (!mounted) return;
    if (error == null) {
      Navigator.of(context).maybePop();
      return;
    }
    setState(() {
      _busy = false;
      _error = error;
    });
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    if (name.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final error = await widget.rename(widget.device.key, name);
    if (!mounted) return;
    if (error == null) {
      Navigator.of(context).maybePop();
      return;
    }
    setState(() {
      _busy = false;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Sheet(title: hostedName(widget.device), children: [
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 14, children: [
          SheetText(const [TextSpan(text: 'The name every phone and browser of this account shows it by. Only they can read it: it is sealed to each of them.')]),
          CupertinoTextField(selectionControls: fieldHandles, contextMenuBuilder: fieldMenu, magnifierConfiguration: fieldMagnifier, 
            controller: _name,
            maxLength: 100,
            autocorrect: false,
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _save(),
            style: look.text(size: 16, spacing: 0),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
            decoration: BoxDecoration(color: look.sheetCard, borderRadius: BorderRadius.circular(12), border: Border.all(color: look.rule)),
          ),
          if (_error != null) Semantics(liveRegion: true, child: Text(_error!, style: look.text(size: 14, color: look.block, spacing: 0))),
          Answers(cancel: () => Navigator.of(context).maybePop(), label: _busy ? '…' : 'Save', disabled: _busy, go: _save),
        ]),
      ),
      if (widget.remove != null)
        Padding(
          padding: const EdgeInsets.only(top: 12),
          child: SheetGroup(children: [
            SheetRow(
              label: widget.device.role == 'host' ? 'Remove this computer' : 'Remove this phone or browser',
              sub: widget.device.role == 'host' ? 'Its sessions end, and it can no longer be reached' : 'It loses every computer at once',
              danger: true,
              onTap: _remove,
            ),
          ]),
        ),
    ]);
  }
}
