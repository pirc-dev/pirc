// Machines asking to join the relay (docs/design.md, 5.3), as the web
// page's Hosts.tsx: a line on the session list for each, and a sheet to
// approve or reject one once its key matches the one the machine shows.
import 'package:flutter/cupertino.dart';

import '../app/model.dart';
import '../core/names.dart';
import '../core/view.dart';
import 'look.dart';
import 'sheet.dart';

// The lines, none when no machine asks.
class JoinRequests extends StatelessWidget {
  const JoinRequests({super.key, required this.model, required this.day});
  final PircModel model;
  // How a date is written, for when it asked (sessions_screen.dart).
  final String Function(int at, bool weekday) day;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final hosts = model.pendingHosts;
    if (hosts.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 6, children: [
        for (final h in hosts)
          Semantics(
            button: true,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => showSheet<void>(context, (_) => DecideSheet(model: model, hostKey: h.key, day: day)),
              child: Container(
                constraints: const BoxConstraints(minHeight: 44),
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                decoration: BoxDecoration(color: look.workWash, borderRadius: BorderRadius.circular(10)),
                child: Row(spacing: 10, children: [
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('${h.label.isNotEmpty ? h.label : 'A machine'} asks to join',
                          maxLines: 1, overflow: TextOverflow.ellipsis, style: look.text(size: 14.5, weight: FontWeight.w600, color: look.work, spacing: 0)),
                      Text('key ${h.key.substring(0, h.key.length < 16 ? h.key.length : 16)}…',
                          maxLines: 1, overflow: TextOverflow.ellipsis, style: look.mono(size: 12, color: look.work.withValues(alpha: 0.8))),
                    ]),
                  ),
                  Icon(CupertinoIcons.chevron_right, size: 16, color: look.work),
                ]),
              ),
            ),
          ),
      ]),
    );
  }
}

// Approving or rejecting one machine; it closes once the relay no longer
// lists it, decided here or elsewhere, or expired.
class DecideSheet extends StatefulWidget {
  const DecideSheet({super.key, required this.model, required this.hostKey, required this.day});
  final PircModel model;
  final String hostKey;
  final String Function(int at, bool weekday) day;

  @override
  State<DecideSheet> createState() => _DecideSheetState();
}

class _DecideSheetState extends State<DecideSheet> {
  // As the relay last listed it: its details may change while it asks.
  PendingHostView? _host;
  late final _label = TextEditingController(text: _listed()?.label ?? '');
  var _busy = false;
  var _gone = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    widget.model.addListener(_changed);
  }

  @override
  void dispose() {
    widget.model.removeListener(_changed);
    _label.dispose();
    super.dispose();
  }

  PendingHostView? _listed() => widget.model.pendingHosts.where((h) => h.key == widget.hostKey).firstOrNull;

  void _changed() {
    if (_gone) return;
    final listed = _listed();
    if (listed != null) return setState(() => _host = listed);
    _gone = true;
    // This sheet only, wherever it is: it may be closing already, or have
    // a chat opened over it.
    final route = ModalRoute.of(context);
    if (route != null && route.isActive) Navigator.of(context).removeRoute(route);
  }

  Future<void> _decide(bool approve) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await widget.model.client.decide(widget.hostKey, approve, approve ? _label.text.trim() : '');
      // Done: the list no longer has it, and the sheet closes with it.
      if (!r.ok && mounted && !_gone) setState(() => _error = r.message);
    } on Object catch (e) {
      if (mounted && !_gone) setState(() => _error = '$e');
    } finally {
      if (mounted && !_gone) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    // Gone before it was first drawn: nothing to decide, and it closes.
    final h = _host ??= _listed();
    if (h == null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => mounted ? _changed() : null);
      return const SizedBox.shrink();
    }
    final when = ago(h.firstSeen, widget.model.now(), widget.day);
    return Sheet(title: 'Add this machine?', sub: 'Asked ${when == 'now' ? 'just now' : '$when ago'}${h.remote.isNotEmpty ? ' from ${h.remote}' : ''}', children: [
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 14, children: [
          SheetText([
            const TextSpan(text: 'Approve it only if this key is the one '),
            TextSpan(text: '/pirc\u00a0status', style: look.mono(size: 14, color: look.ink)),
            const TextSpan(text: ' shows on that machine. Its sessions then appear here, and what you send them runs there.'),
          ]),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(color: look.wash, borderRadius: BorderRadius.circular(10)),
            child: Text(h.key, style: look.mono(size: 14, color: look.ink).copyWith(height: 1.6)),
          ),
          if (h.software.isNotEmpty) Text('It runs ${h.software}.', style: look.text(size: 13, color: look.ink2, spacing: 0)),
          Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 4, children: [
            Text('Name it', style: look.text(size: 13, color: look.ink2, spacing: 0)),
            CupertinoTextField(
              controller: _label,
              placeholder: h.label.isNotEmpty ? h.label : 'A name for this machine',
              maxLength: 128,
              autocorrect: false,
              enableSuggestions: false,
              textCapitalization: TextCapitalization.none,
              textInputAction: TextInputAction.done,
              style: look.text(size: 16, spacing: 0),
              placeholderStyle: look.text(size: 16, color: look.ink3, spacing: 0),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
              decoration: BoxDecoration(color: look.sheetCard, borderRadius: BorderRadius.circular(12), border: Border.all(color: look.rule)),
            ),
          ]),
          if (_error != null) Semantics(liveRegion: true, child: Text(_error!, style: look.text(size: 14, color: look.block, spacing: 0))),
          Answers(cancel: () => _decide(false), cancelLabel: 'Reject', label: _busy ? '…' : 'Approve', disabled: _busy, go: () => _decide(true)),
        ]),
      ),
    ]);
  }
}
