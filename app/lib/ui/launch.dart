// Opening a new pi beside a running one, as the web page's Launch.tsx, in
// its tmux session or herdr workspace (docs/design.md, section 4): in that
// pi's folder, one this machine's sessions have used, or one typed in; its
// window named after the folder unless named here. A folder tapped is only
// chosen (this pi's at first); Start opens the new pi. Once it connects,
// its chat opens.
import 'dart:async';

import 'package:flutter/cupertino.dart';

import '../app/model.dart';
import '../core/protocol.dart';
import '../core/view.dart';
import 'look.dart';
import 'sheet.dart';
import 'adaptive.dart';

// How long a new pi has to connect before the sheet stops waiting for it.
const connectMs = 45000;

String _hostOf(SessionView s) => s.hostLabel.isNotEmpty ? s.hostLabel : s.hostname;

// Where a new pi beside s opens, as the sheet says it.
String besideWhere(SessionView s) {
  final group = s.place?.group ?? '';
  return group.isNotEmpty ? '$group on ${_hostOf(s)}' : _hostOf(s);
}

// The session a group's new pi opens beside: the most recent one that can.
SessionView? launchable(List<SessionView> sessions) {
  int at(SessionView s) => s.last?.at ?? s.startedAt ?? 0;
  return ([for (final s in sessions) if (s.launcher != null) s]..sort((a, b) => at(b) - at(a))).firstOrNull;
}

// The window name a folder gives: its last part ("" for ~ or /, which
// leaves it to the multiplexer).
String folderName(String cwd) {
  final last = cwd.replaceFirst(RegExp(r'/+$'), '').split('/').last;
  return last == '~' ? '' : last;
}

class LaunchSheet extends StatefulWidget {
  const LaunchSheet({super.key, required this.model, required this.beside, required this.open});
  final PircModel model;
  final SessionView beside;
  // Opens a session's chat: the new pi's, once it has connected.
  final void Function(String id) open;

  @override
  State<LaunchSheet> createState() => _LaunchSheetState();
}

class _LaunchSheetState extends State<LaunchSheet> {
  var _past = const <String>[];
  final _typed = TextEditingController();
  final _name = TextEditingController();
  // The folder chosen from the list; one typed in wins while there is one.
  late var _chosen = widget.beside.cwd;
  // Starting: the request and its folder; or why it failed.
  ({String requestId, String cwd})? _starting;
  String? _failed;
  Timer? _waiting;
  var _opened = false;

  @override
  void initState() {
    super.initState();
    // The folders of the host's saved sessions, newest first; quietly.
    widget.model.act(widget.beside.id, (r) => SessionMessage(listPastSessions: ListPastSessions(requestId: r, allFolders: true))).then((o) {
      if (mounted && o.ok && o.result?['kind'] == 'pastSessions') setState(() => _past = [for (final x in o.result!['sessions'] as List) (x as Json)['cwd'] as String]);
    });
    widget.model.addListener(_connected);
    _typed.addListener(() => setState(() {}));
    _name.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    widget.model.removeListener(_connected);
    _waiting?.cancel();
    _typed.dispose();
    _name.dispose();
    super.dispose();
  }

  // The new pi, once it has connected: the sheet closes and its chat opens.
  // Until then the host's live folders change as sessions come and go.
  void _connected() {
    final starting = _starting;
    if (_opened) return;
    if (starting == null) return setState(() {});
    final started = widget.model.sessions.where((x) => x.launchId == starting.requestId).firstOrNull;
    if (started == null) return;
    _opened = true;
    _waiting?.cancel();
    Navigator.of(context).pop();
    WidgetsBinding.instance.addPostFrameCallback((_) => widget.open(started.id));
  }

  Future<void> _launch(String cwd) async {
    final name = _name.text.trim();
    // Set by the time act returns: act builds the request before its first
    // await.
    late final String requestId;
    final answer = widget.model.act(widget.beside.id, (id) {
      requestId = id;
      return SessionMessage(launch: Launch(requestId: id, cwd: cwd, name: name.isEmpty ? folderName(cwd) : name));
    });
    // The request made, its ID known: waiting for the new pi, from now, as
    // the web page's sheet does.
    setState(() {
      _starting = (requestId: requestId, cwd: cwd);
      _failed = null;
    });
    _waiting?.cancel();
    _waiting = Timer(const Duration(milliseconds: connectMs), () {
      if (!mounted || _opened) return;
      setState(() {
        _starting = null;
        _failed = 'pi opened in $cwd but has not connected yet; it shows in the list once it does.';
      });
    });
    final r = await answer;
    if (!mounted || _opened || _starting?.requestId != requestId) return;
    if (!r.ok) {
      _waiting?.cancel();
      setState(() {
        _starting = null;
        _failed = r.message;
      });
      return;
    }
    // It may have connected before the answer came.
    _connected();
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final s = widget.beside;
    final here = [for (final x in widget.model.sessions) if (_hostOf(x) == _hostOf(s) && x.id != s.id) x.cwd];
    final folders = {for (final f in [s.cwd, ...here, ..._past]) if (f.isNotEmpty) f}.toList();
    final starting = _starting != null;
    Widget say(String text, {bool bad = false}) => Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
          child: Semantics(liveRegion: true, child: Text(text, style: look.text(size: 14.5, color: bad ? look.block : look.ink2, spacing: 0))),
        );
    // The name is the request's; another folder may be typed meanwhile.
    Widget field(TextEditingController c, String placeholder, {bool mono = false, ValueChanged<String>? submitted}) => CupertinoTextField(selectionControls: fieldHandles, contextMenuBuilder: fieldMenu, magnifierConfiguration: fieldMagnifier, 
          controller: c,
          enabled: c != _name || !starting,
          placeholder: placeholder,
          autocorrect: false,
          enableSuggestions: false,
          textCapitalization: TextCapitalization.none,
          textInputAction: submitted == null ? TextInputAction.done : TextInputAction.go,
          onSubmitted: submitted,
          style: mono ? look.mono(size: 15) : look.text(size: 16, spacing: 0),
          placeholderStyle: (mono ? look.mono(size: 15) : look.text(size: 16, spacing: 0)).copyWith(color: look.ink3),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(color: look.sheetCard, borderRadius: BorderRadius.circular(12), border: Border.all(color: look.rule)),
        );
    final cwd = _typed.text.trim().isNotEmpty ? _typed.text.trim() : _chosen;
    final can = cwd.isNotEmpty && !starting;
    void start() {
      if (can) _launch(cwd);
    }

    return Sheet(title: 'New agent', sub: 'Beside this one, in ${besideWhere(s)}', done: 'Cancel', children: [
      if (_starting != null) say('Opening pi in ${_starting!.cwd}…'),
      if (_failed != null) say(_failed!, bad: true),
      SheetGroup(children: [
        for (final (i, f) in folders.indexed)
          SheetRow(
            label: f,
            sub: i == 0 ? "This agent's folder" : null,
            disabled: starting,
            checked: _typed.text.trim().isEmpty && f == _chosen,
            onTap: () => setState(() {
              _chosen = f;
              _typed.clear();
            }),
          ),
      ]),
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 0),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 12, children: [
          field(_typed, 'Another folder: ~/src/…', mono: true),
          field(_name, folderName(cwd).isEmpty ? 'Window name' : 'Window name: ${folderName(cwd)}', submitted: (_) => start()),
          Semantics(
            button: true,
            enabled: can,
            label: 'Start agent',
            excludeSemantics: true,
            onTap: can ? start : null,
            child: GestureDetector(
              onTap: start,
              child: Opacity(
                opacity: can ? 1 : 0.4,
                child: Container(
                  height: 50,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(color: look.accent, borderRadius: BorderRadius.circular(14)),
                  child: Text('Start agent', style: look.text(size: 16, weight: FontWeight.w600, color: look.onAccent, spacing: 0)),
                ),
              ),
            ),
          ),
        ]),
      ),
    ]);
  }
}
