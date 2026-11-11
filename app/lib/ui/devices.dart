// The hosts or the clients registered with the relay (docs/design.md, 5.3),
// as the web page's Devices.tsx: rows of one of Settings' sections, each
// online or not; one tapped opens a sheet to rename or remove it; below
// them, adding one (invite.dart). The names are the relay's, shared by
// every client. This phone's own row has
// no Remove: the relay refuses a key's removing itself.
import 'package:flutter/cupertino.dart';

import '../app/model.dart';
import '../core/client.dart' show RelayAnswer;
import '../core/view.dart';
import 'invite.dart';
import 'look.dart';
import 'sessions_screen.dart' show day;
import 'sheet.dart';

class DeviceList extends StatelessWidget {
  const DeviceList({super.key, required this.model, required this.role, this.relay});
  final PircModel model;
  // "host" or "client".
  final String role;
  // The relay's address, for adding one; none, no adding.
  final String? relay;

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
        // This phone first among the clients, the rest in the relay's order.
        final listed = [for (final d in model.client.snapshot().devices) if (d.role == role) d];
        final shown = [...listed.where((d) => d.self), ...listed.where((d) => !d.self)];
        final relay = this.relay;
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (shown.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Text(role == 'host' ? 'No hosts yet.' : 'No apps yet.', style: look.text(size: 14, color: look.ink2, spacing: 0)),
            ),
          for (final (i, d) in shown.indexed) ...[
            if (i > 0) Container(height: 0.5, color: look.rule),
            _Row(d, onTap: () => showSheet<void>(context, (_) => DeviceSheet(model: model, deviceKey: d.key))),
          ],
          if (relay != null) ...[
            Container(height: 0.5, color: look.rule),
            _Add(role == 'host' ? 'Add a host' : 'Add an app', onTap: () => showSheet<void>(context, (_) => InviteSheet(model: model, relay: relay, role: role))),
          ],
        ]);
      },
    );
  }
}

// This phone shows as what it is, its label in its sheet.
String deviceName(DeviceView d) => d.self ? 'This phone' : d.label.isNotEmpty ? d.label : 'Unnamed';

String _line(DeviceView d) =>
    // An app the relay wakes when a turn ends, even when closed.
    '${d.online ? 'Online' : 'Offline'}${d.push ? ' · Notifications on' : ''} · key ${d.key.substring(0, d.key.length < 8 ? d.key.length : 8)}…';

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

class _Row extends StatelessWidget {
  const _Row(this.d, {required this.onTap});
  final DeviceView d;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Semantics(
      button: true,
      label: '${deviceName(d)}: rename${d.self ? '' : ' or remove'}',
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
                Text(deviceName(d), maxLines: 1, overflow: TextOverflow.ellipsis, style: look.text(size: 16, spacing: 0)),
                Text(_line(d), maxLines: 1, overflow: TextOverflow.ellipsis, style: look.text(size: 13, color: look.ink2, spacing: 0)),
              ]),
            ),
            Icon(CupertinoIcons.chevron_right, size: 14, color: look.ink3),
          ]),
        ),
      ),
    );
  }
}

// Renaming or removing one; it closes once the relay no longer lists it,
// removed here or elsewhere, or with the relay out of reach.
class DeviceSheet extends StatefulWidget {
  const DeviceSheet({super.key, required this.model, required this.deviceKey});
  final PircModel model;
  final String deviceKey;

  @override
  State<DeviceSheet> createState() => _DeviceSheetState();
}

class _DeviceSheetState extends State<DeviceSheet> {
  DeviceView? _device;
  late final _label = TextEditingController(text: _listed()?.label ?? '');
  var _removing = false;
  var _busy = false;
  var _gone = false;
  String? _error;

  DeviceView? _listed() => widget.model.client.snapshot().devices.where((d) => d.key == widget.deviceKey).firstOrNull;

  @override
  void initState() {
    super.initState();
    widget.model.addListener(_changed);
    _label.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    // Closed already: a late answer has nothing to close.
    _gone = true;
    widget.model.removeListener(_changed);
    _label.dispose();
    super.dispose();
  }

  void _changed() {
    if (_gone) return;
    final listed = widget.model.relay.state == 'ready' ? _listed() : null;
    if (listed != null) return setState(() => _device = listed);
    _close();
  }

  // This sheet only, wherever it is: it may be closing already, or have a
  // chat opened over it.
  void _close() {
    if (_gone) return;
    _gone = true;
    final route = ModalRoute.of(context);
    if (route != null && route.isActive) Navigator.of(context).removeRoute(route);
  }

  Future<void> _ask(Future<RelayAnswer> Function() request) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await request();
      if (r.ok) return _close();
      if (mounted && !_gone) setState(() => _error = r.message);
    } on Object catch (e) {
      if (mounted && !_gone) setState(() => _error = '$e');
    } finally {
      if (mounted && !_gone) setState(() => _busy = false);
    }
  }

  Future<void> _save(DeviceView d) async {
    final name = _label.text.trim();
    if (name.isEmpty) return;
    if (name == d.label) return _close();
    await _ask(() => widget.model.client.rename(d.key, name));
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final d = _device ??= _listed();
    if (d == null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => mounted ? _close() : null);
      return const SizedBox.shrink();
    }
    final host = d.role == 'host';
    final error = _error == null ? null : Semantics(liveRegion: true, child: Text(_error!, style: look.text(size: 14, color: look.block, spacing: 0)));
    if (_removing) {
      return Sheet(title: 'Remove ${d.label.isNotEmpty ? d.label : host ? 'this host' : 'this app'}?', children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 14, children: [
            SheetText(host
                ? [
                    const TextSpan(text: 'Its sessions end here and in every other app, and it stops connecting to the relay. To bring it back, run '),
                    TextSpan(text: '/pirc enrol', style: look.mono(size: 14, color: look.ink)),
                    const TextSpan(text: ' on it and approve it again.'),
                  ]
                : const [TextSpan(text: 'It loses access to every host at once, and is signed out of the relay. To bring it back, enrol it again.')]),
            ?error,
            Answers(
              cancel: () => setState(() {
                _removing = false;
                _error = null;
              }),
              cancelLabel: 'Back',
              label: _busy ? '…' : 'Remove',
              danger: true,
              disabled: _busy,
              go: () => _ask(() => widget.model.client.remove(d.key)),
            ),
          ]),
        ),
      ]);
    }
    final added = DateTime.fromMillisecondsSinceEpoch(d.addedAt);
    final name = _label.text.trim();
    return Sheet(title: d.self ? 'This phone' : host ? 'This host' : 'This app', sub: 'Added ${day(d.addedAt, false)}, ${added.year}', children: [
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 14, children: [
          SheetText([TextSpan(text: host ? 'The name its sessions show under, here and in every other app.' : 'The name the relay knows it by, the same in every app.')]),
          Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 4, children: [
            Text('Name', style: look.text(size: 13, color: look.ink2, spacing: 0)),
            CupertinoTextField(
              controller: _label,
              maxLength: 128,
              autocorrect: false,
              enableSuggestions: false,
              textCapitalization: TextCapitalization.none,
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => _save(d),
              style: look.text(size: 16, spacing: 0),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
              decoration: BoxDecoration(color: look.sheetCard, borderRadius: BorderRadius.circular(12), border: Border.all(color: look.rule)),
            ),
          ]),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(color: look.wash, borderRadius: BorderRadius.circular(10)),
            child: Text(d.key, style: look.mono(size: 13, color: look.ink2).copyWith(height: 1.6)),
          ),
          ?error,
          Answers(cancel: () => Navigator.of(context).maybePop(), label: _busy ? '…' : 'Save', disabled: _busy || name.isEmpty, go: () => _save(d)),
        ]),
      ),
      if (!d.self)
        Padding(
          padding: const EdgeInsets.only(top: 12),
          child: SheetGroup(children: [
            SheetRow(
              label: host ? 'Remove this host' : 'Remove this app',
              sub: host ? 'Its sessions end and it stops connecting' : 'It loses access to every host',
              danger: true,
              onTap: () => setState(() {
                _removing = true;
                _error = null;
              }),
            ),
          ]),
        ),
    ]);
  }
}
