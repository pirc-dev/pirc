// A session's actions, as the web page's Native look has them (Chat.tsx's
// "…", SessionSheets.tsx's Actions, Resume, Branches and MessageSheet,
// ModelPicker.tsx): its model and thinking level; its cost and context;
// compacting, renaming, reloading; cloning it, switching to another of its
// branches, resuming a session pi has saved, a new session; and stopping
// pi. From one of the user's messages, going back to before it or forking
// from it. What an action answers, or why it failed, shows under the
// chat's header. A new agent beside it, from launch.dart.
import 'package:flutter/cupertino.dart';

import '../app/model.dart';
import '../core/fuzzy.dart';
import '../core/names.dart';
import '../core/protocol.dart';
import '../core/results.dart';
import '../core/view.dart';
import 'launch.dart';
import 'look.dart';
import 'sessions_screen.dart' show day;
import 'sheet.dart';

// Runs one of the session's actions; what it answers, or why it failed,
// is said under the header by the chat.
typedef Run = Future<Outcome> Function(SessionMessage Function(String requestId) request, {bool compacts});

// The short names of two thinking levels, which would not fit.
const _short = {'minimal': 'min', 'medium': 'med'};

// Whether the session's extension takes a request; one that lists none
// is asked anyway, and says if it cannot.
bool takes(SessionView s, String request) => s.requests == null || s.requests!.contains(request);

// Whether the session's extension moves in pi's tree.
bool movesInTree(SessionView s) => takes(s, 'navigate_tree');

// "$1.84", "<$0.01".
String dollars(num cost) => cost > 0 && cost < 0.005 ? '<\$0.01' : '\$${cost.toStringAsFixed(2)}';

// The header's figures: how full the context is and the cost so far,
// "61% · $1.84"; null when not known.
String? spend(Outcome r) {
  final st = r.result;
  if (!r.ok || st?['kind'] != 'stats') return null;
  final window = st!['contextWindow'] as int;
  final tokens = st['contextTokens'] as int?;
  final pct = window > 0 && tokens != null ? (tokens / window * 100).round() : null;
  final used = pct == null ? '' : pct == 0 && tokens! > 0 ? '<1% · ' : '$pct% · ';
  return '$used${dollars(st['cost'] as num)}';
}

// 1,234,567.
String _thousands(int n) => n.toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');

// The full figures, for the line under the header, in Markdown.
String? stats(Outcome r) {
  final st = r.result;
  if (!r.ok || st?['kind'] != 'stats') return null;
  final window = st!['contextWindow'] as int;
  final tokens = st['contextTokens'] as int?;
  final ctx = window == 0
      ? 'unknown'
      : tokens == null
          ? 'unknown until the next reply, of ${_thousands(window)} tokens'
          : '**${(tokens / window * 100).toStringAsFixed(1)}%**, ${_thousands(tokens)} of ${_thousands(window)} tokens';
  final cost = st['cost'] as num;
  return '**\$${cost < 0.1 ? cost.toStringAsFixed(4) : cost.toStringAsFixed(2)}** so far · '
      '${_thousands(st['input'] as int)} in, ${_thousands(st['output'] as int)} out, ${_thousands(st['cacheRead'] as int)} cached\n\nContext $ctx';
}

// The menu, and the sheets it leads to.
class SessionActions extends StatefulWidget {
  const SessionActions({super.key, required this.model, required this.id, required this.run, required this.say, this.open});
  final PircModel model;
  final String id;
  final Run run;
  final void Function(String text) say;
  // Opens a session's chat: a new agent's, once it has connected.
  final void Function(String id)? open;

  @override
  State<SessionActions> createState() => _ActionsState();
}

enum _Mode { menu, rename, resume, branches, fresh, launch, stop }

class _ActionsState extends State<SessionActions> {
  var _mode = _Mode.menu;
  List<Json>? _models;
  String? _cost;
  final _name = TextEditingController();

  @override
  void initState() {
    super.initState();
    _name.text = widget.model.session(widget.id)?.name ?? '';
    // Quietly: the sheet works without either.
    widget.model.act(widget.id, (r) => SessionMessage(listModels: ListModels(requestId: r))).then((o) {
      if (mounted && o.ok && o.result?['kind'] == 'models') setState(() => _models = (o.result!['models'] as List).cast<Json>());
    });
    widget.model.act(widget.id, (r) => SessionMessage(statsRequest: StatsRequest(requestId: r))).then((o) {
      final st = o.result;
      if (!mounted || !o.ok || st?['kind'] != 'stats') return;
      final window = st!['contextWindow'] as int;
      final tokens = st['contextTokens'] as int?;
      setState(() => _cost = '\$${(st['cost'] as num).toStringAsFixed(2)}${window > 0 && tokens != null ? ' · ${(tokens / window * 100).round()}%' : ''}');
    });
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  void _close() => Navigator.of(context).pop();

  // Closes the sheet, then runs the action; [done], said once it is done.
  Future<Outcome> _act(SessionMessage Function(String requestId) request, {bool compacts = false, String? done}) async {
    _close();
    final r = await widget.run(request, compacts: compacts);
    if (r.ok && done != null) widget.say(done);
    return r;
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: widget.model,
        builder: (context, _) {
          final s = widget.model.session(widget.id);
          // The session gone (pi quit, its host dropped): its menu goes too.
          if (s == null) {
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (mounted && ModalRoute.of(context)?.isCurrent == true) _close();
            });
            return const SizedBox.shrink();
          }
          return switch (_mode) {
            _Mode.menu => _menu(context, s),
            _Mode.rename => _rename(context, s),
            _Mode.resume => _Resume(model: widget.model, session: s, go: (x) {
                final name = pastTitle(x);
                _act((r) => SessionMessage(resume: Resume(requestId: r, path: x['path'] as String)), done: 'Resumed $name');
              }),
            _Mode.branches => _Branches(model: widget.model, session: s, go: (x, summarize) {
                final name = branchTitle(x);
                _act((r) => SessionMessage(navigateTree: NavigateTree(requestId: r, entryId: x['leafId'] as String, summarize: summarize)), compacts: true, done: 'Switched to the branch $name');
              }),
            _Mode.launch => LaunchSheet(model: widget.model, beside: s, open: widget.open!),
            _Mode.fresh => _confirm(context, s, 'Start a new session?', [
                const TextSpan(text: 'pi starts an empty conversation'),
                if (windowOf(s) != null) ...[const TextSpan(text: ' in '), TextSpan(text: windowOf(s), style: const TextStyle(fontStyle: FontStyle.italic))],
                const TextSpan(text: ". This one stays in pi's history, to resume later."),
              ], 'New session', () => _act((r) => SessionMessage(newSession: NewSession(requestId: r)))),
            _Mode.stop => _confirm(context, s, 'Stop pi?', [
                const TextSpan(text: 'pi quits, as it does at its terminal'),
                if (windowOf(s) != null) ...[const TextSpan(text: '; '), TextSpan(text: windowOf(s), style: const TextStyle(fontStyle: FontStyle.italic)), const TextSpan(text: ' closes if pi was all it ran')],
                const TextSpan(text: ". The conversation stays in pi's history, to resume later."),
              ], 'Stop pi', () async {
                _close();
                final r = await widget.model.act(widget.id, (r) => SessionMessage(stop: Stop(requestId: r)));
                // An answer lost as pi exits is still a stop.
                widget.say(r.ok || r.code == 'SESSION_GONE' ? 'pi has stopped' : '${r.code.isEmpty ? '' : '${r.code}: '}${r.message}');
              }, busyNote: 'pi is working; stop the turn first.'),
          };
        },
      );

  // A thinking level picked: the one it has closes the menu.
  void _think(SessionView s, String l, int i) => s.thinking == l
      ? _close()
      : _act((r) => SessionMessage(setThinkingLevel: SetThinkingLevel(requestId: r, level: ThinkingLevel.valueOf(ThinkingLevel.THINKING_LEVEL_OFF.value + i))));

  Widget _menu(BuildContext context, SessionView s) {
    final look = Look.of(context);
    final busy = s.working || s.compacting;
    final model = s.model;
    return Sheet(title: title(s), sub: where(s), done: 'Done', children: [
      SheetGroup(children: [
        SheetRow(
          label: 'Model',
          value: Row(mainAxisSize: MainAxisSize.min, spacing: 6, children: [
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 180),
              child: Text(model == null ? '—' : (model.name.isNotEmpty ? model.name : model.id), style: look.mono(size: 13.5), maxLines: 1, overflow: TextOverflow.ellipsis),
            ),
            Icon(CupertinoIcons.chevron_forward, size: 14, color: look.ink3),
          ]),
          onTap: () async {
            final picked = await Navigator.of(context).push(CupertinoPageRoute<ModelView>(fullscreenDialog: true, builder: (_) => ModelPicker(models: _models, current: model)));
            if (!mounted || picked == null) return;
            if (picked.provider == model?.provider && picked.id == model?.id) return _close();
            _act((r) => SessionMessage(setModel: SetModel(requestId: r, model: Model(provider: picked.provider, id: picked.id))));
          },
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 8, children: [
            Text('Thinking level', style: look.text(size: 16, spacing: 0)),
            Container(
              padding: const EdgeInsets.all(3),
              decoration: BoxDecoration(color: look.wash, borderRadius: BorderRadius.circular(10)),
              child: Row(spacing: 2, children: [
                for (final (i, l) in thinkingNames.indexed)
                  Expanded(
                    child: Semantics(
                      button: true,
                      selected: s.thinking == l,
                      label: l,
                      excludeSemantics: true,
                      onTap: () => _think(s, l, i),
                      child: GestureDetector(
                        onTap: () => _think(s, l, i),
                        child: Container(
                          height: 36,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(color: s.thinking == l ? look.accent : null, borderRadius: BorderRadius.circular(7)),
                          child: Text(_short[l] ?? l,
                              style: look.text(size: 12.5, weight: s.thinking == l ? FontWeight.w600 : FontWeight.w400, color: s.thinking == l ? look.onAccent : look.ink2, spacing: 0)),
                        ),
                      ),
                    ),
                  ),
              ]),
            ),
          ]),
        ),
      ]),
      SheetGroup(children: [
        SheetRow(
          label: 'Cost and context',
          value: _cost == null ? null : Text(_cost!, style: look.text(size: 14.5, color: look.ink2, spacing: 0).copyWith(fontFeatures: const [FontFeature.tabularFigures()])),
          onTap: () async {
            final r = await _act((r) => SessionMessage(statsRequest: StatsRequest(requestId: r)));
            final text = stats(r);
            if (text != null) widget.say(text);
          },
        ),
        SheetRow(label: 'Compact', sub: 'Summarise the conversation to free context', disabled: busy, onTap: () => _act((r) => SessionMessage(compact: Compact(requestId: r)), compacts: true)),
        SheetRow(label: 'Rename', onTap: () => setState(() => _mode = _Mode.rename)),
        SheetRow(
          label: 'Reload',
          sub: "Load pi's extensions, skills, prompts and context files again",
          disabled: busy,
          onTap: () => _act((r) => SessionMessage(reload: Reload(requestId: r)), done: 'pi is reloading; the session carries on'),
        ),
      ]),
      SheetGroup(children: [
        SheetRow(
          label: 'Clone',
          sub: "Carry on in a copy; this one stays in pi's history",
          disabled: busy,
          onTap: () => _act((r) => SessionMessage(clone_20: Clone(requestId: r)), done: "Now in a copy of the session; the original stays in pi's history"),
        ),
        if (movesInTree(s)) SheetRow(label: 'Branches', sub: 'Switch to another branch of this conversation', disabled: busy, onTap: () => setState(() => _mode = _Mode.branches)),
        SheetRow(label: 'Resume', sub: 'Go back to a session pi has saved', disabled: busy, onTap: () => setState(() => _mode = _Mode.resume)),
        SheetRow(label: 'New session', danger: true, disabled: busy, onTap: () => setState(() => _mode = _Mode.fresh)),
      ]),
      if (takes(s, 'stop') || (s.launcher != null && widget.open != null))
        SheetGroup(children: [
          if (s.launcher != null && widget.open != null)
            SheetRow(label: 'New agent', sub: 'Another pi beside this one, in ${besideWhere(s)}', onTap: () => setState(() => _mode = _Mode.launch)),
          if (takes(s, 'stop')) SheetRow(label: 'Stop pi', sub: "Quit this pi; the conversation stays in its history", danger: true, disabled: busy, onTap: () => setState(() => _mode = _Mode.stop)),
        ]),
    ]);
  }

  Widget _confirm(BuildContext context, SessionView s, String heading, List<InlineSpan> what, String label, VoidCallback go, {String? busyNote}) {
    final look = Look.of(context);
    final busy = s.working || s.compacting;
    return Sheet(title: heading, children: [
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 14, children: [
          SheetText(what),
          if (busy && busyNote != null) Text(busyNote, style: look.text(size: 14, color: look.ink2, spacing: 0)),
          Answers(cancel: () => setState(() => _mode = _Mode.menu), label: label, danger: true, disabled: busy, go: go),
        ]),
      ),
    ]);
  }

  Widget _rename(BuildContext context, SessionView s) {
    final look = Look.of(context);
    void go() {
      final name = _name.text.trim();
      if (name.isNotEmpty) _act((r) => SessionMessage(rename: Rename(requestId: r, name: name)));
    }

    return Sheet(title: 'Rename', sub: "pi's name for the session, which the list shows", children: [
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 14, children: [
          CupertinoTextField(
            controller: _name,
            autofocus: true,
            placeholder: title(s),
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => go(),
            style: look.text(size: 16, spacing: 0),
            placeholderStyle: look.text(size: 16, color: look.ink3, spacing: 0),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
            decoration: BoxDecoration(color: look.sheetCard, borderRadius: BorderRadius.circular(12), border: Border.all(color: look.rule)),
          ),
          ListenableBuilder(
            listenable: _name,
            builder: (context, _) => Answers(cancel: () => setState(() => _mode = _Mode.menu), label: 'Rename', disabled: _name.text.trim().isEmpty, go: go),
          ),
        ]),
      ),
    ]);
  }
}

String pastTitle(Json x) {
  final name = x['name'] as String? ?? '';
  final prompt = x['firstPrompt'] as String? ?? '';
  return name.isNotEmpty ? name : prompt.isNotEmpty ? prompt : 'An empty session';
}

// The sessions pi has saved, to go back to one: those of the session's
// folder, or of every folder. pi moves to the folder of the one picked.
class _Resume extends StatefulWidget {
  const _Resume({required this.model, required this.session, required this.go});
  final PircModel model;
  final SessionView session;
  final void Function(Json x) go;

  @override
  State<_Resume> createState() => _ResumeState();
}

class _ResumeState extends State<_Resume> {
  var _all = false;
  // Listed for which scope: the sessions and whether some were left out, or
  // why pi could not list them.
  ({bool all, List<Json>? sessions, bool truncated, String? error})? _listed;

  @override
  void initState() {
    super.initState();
    _list();
  }

  Future<void> _list() async {
    final all = _all;
    final r = await widget.model.act(widget.session.id, (id) => SessionMessage(listPastSessions: ListPastSessions(requestId: id, allFolders: all)));
    if (!mounted || all != _all) return;
    setState(() => _listed = r.ok && r.result?['kind'] == 'pastSessions'
        ? (all: all, sessions: (r.result!['sessions'] as List).cast<Json>(), truncated: r.result!['truncated'] as bool, error: null)
        : (all: all, sessions: null, truncated: false, error: r.ok ? 'an unexpected answer' : r.message));
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final s = widget.session;
    final busy = s.working || s.compacting;
    final shown = _listed?.all == _all ? _listed : null;
    final now = widget.model.now();
    Widget say(String text) => Padding(padding: const EdgeInsets.fromLTRB(14, 12, 14, 12), child: Text(text, style: look.text(size: 14.5, color: look.ink2, spacing: 0)));
    Widget scope(bool value, String label) => Expanded(
          child: Semantics(
            button: true,
            selected: _all == value,
            child: GestureDetector(
              onTap: () {
                if (_all == value) return;
                setState(() => _all = value);
                _list();
              },
              child: Container(
                height: 36,
                alignment: Alignment.center,
                decoration: BoxDecoration(color: _all == value ? look.accent : null, borderRadius: BorderRadius.circular(7)),
                child: Text(label, style: look.text(size: 13, weight: _all == value ? FontWeight.w600 : FontWeight.w400, color: _all == value ? look.onAccent : look.ink2, spacing: 0)),
              ),
            ),
          ),
        );
    return Sheet(title: 'Resume', sub: _all ? 'Sessions pi has saved, in every folder' : s.cwd, done: 'Done', children: [
      Container(
        margin: const EdgeInsets.fromLTRB(12, 0, 12, 12),
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(color: look.wash, borderRadius: BorderRadius.circular(10)),
        child: Row(spacing: 2, children: [scope(false, 'This folder'), scope(true, 'All folders')]),
      ),
      if (busy) say('pi is working; stop it first.'),
      if (shown == null)
        say('Loading…')
      else if (shown.error != null)
        say('pi could not list its sessions: ${shown.error}')
      else if (shown.sessions!.isEmpty)
        say(_all ? 'pi has no other saved sessions.' : 'pi has no other saved sessions in this folder.')
      else
        SheetGroup(children: [
          for (final x in shown.sessions!)
            SheetRow(
              label: pastTitle(x),
              sub: [
                ago(x['modified'] as int, now, day),
                x['messages'] == 1 ? '1 message' : '${x['messages']} messages',
                if (_all && x['cwd'] != s.cwd) x['cwd'] as String,
              ].where((t) => t.isNotEmpty).join(' · '),
              disabled: busy,
              onTap: () => widget.go(x),
            ),
        ]),
      if (shown != null && shown.truncated) say('Older sessions are left out.'),
    ]);
  }
}

String branchTitle(Json x) {
  final prompt = x['prompt'] as String? ?? '';
  return prompt.isNotEmpty ? '“$prompt”' : (x['messages'] as int? ?? 0) > 0 ? 'with no prompt' : 'before the first message';
}

// The conversation's branches, to switch to one: the current one first,
// then the others, the newest first, each by its first prompt after it
// leaves this one. Switching asks whether pi should summarise the branch
// left, as going back from a message does.
class _Branches extends StatefulWidget {
  const _Branches({required this.model, required this.session, required this.go});
  final PircModel model;
  final SessionView session;
  final void Function(Json x, bool summarize) go;

  @override
  State<_Branches> createState() => _BranchesState();
}

class _BranchesState extends State<_Branches> {
  // The branches and whether some were left out, or why pi could not list
  // them.
  ({List<Json>? branches, bool truncated, String? error})? _listed;
  Json? _picked;

  @override
  void initState() {
    super.initState();
    widget.model.act(widget.session.id, (id) => SessionMessage(listTree: ListTree(requestId: id))).then((r) {
      if (!mounted) return;
      setState(() => _listed = r.ok && r.result?['kind'] == 'tree'
          ? (branches: (r.result!['branches'] as List).cast<Json>(), truncated: r.result!['truncated'] as bool, error: null)
          : (branches: null, truncated: false, error: r.ok ? 'an unexpected answer' : r.message));
    });
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final s = widget.session;
    final busy = s.working || s.compacting;
    final now = widget.model.now();
    Widget say(String text) => Padding(padding: const EdgeInsets.fromLTRB(20, 4, 20, 12), child: Text(text, style: look.text(size: 14.5, color: look.ink2, spacing: 0)));
    String facts(Json x) => [ago(x['modified'] as int, now, day), x['messages'] == 1 ? '1 message' : '${x['messages']} messages'].join(' · ');
    final picked = _picked;
    if (picked != null) {
      final last = picked['last'] as String? ?? '';
      return Sheet(title: 'Switch to this branch?', children: [
        Quoted(branchTitle(picked), more: last.isNotEmpty && last != picked['prompt'] ? last : null),
        if (busy) say('pi is working; stop it first.'),
        SheetGroup(children: [
          SheetRow(label: 'Switch', sub: 'This branch stays, to come back to', disabled: busy, onTap: () => widget.go(picked, false)),
          SheetRow(label: 'Switch with a summary', sub: 'pi also summarises this branch, for the model', disabled: busy, onTap: () => widget.go(picked, true)),
        ]),
      ]);
    }
    final listed = _listed;
    final all = listed?.branches ?? const <Json>[];
    final current = all.where((x) => x['current'] == true).firstOrNull;
    final others = [for (final x in all) if (x['current'] != true) x];
    return Sheet(title: 'Branches', sub: 'Where the conversation went another way', done: 'Done', children: [
      if (busy) say('pi is working; stop it first.'),
      if (listed == null)
        say('Loading…')
      else if (listed.error != null)
        say('pi could not list the branches: ${listed.error}')
      else ...[
        if (current != null)
          SheetGroup(children: [
            SheetRow(label: (current['messages'] as int? ?? 0) > 0 ? branchTitle(current) : 'Before the first message', sub: 'This one · ${facts(current)}', disabled: true),
          ]),
        if (others.isEmpty)
          say('No other branches: nothing has been gone back from yet.')
        else
          SheetGroup(children: [
            for (final x in others)
              SheetRow(
                label: branchTitle(x),
                sub: [facts(x), if (x['last'] != x['prompt']) x['last'] as String? ?? ''].where((t) => t.isNotEmpty).join(' · '),
                disabled: busy,
                onTap: () => setState(() => _picked = x),
              ),
          ]),
        if (listed.truncated) say('Older branches are left out.'),
      ],
    ]);
  }
}

// What can be done from one of the user's messages: going back to before
// it, in this session, or forking a new session there. Either gives the
// message back to edit and send. Closed with the one chosen.
enum FromMessage { back, summary, fork }

class MessageSheet extends StatelessWidget {
  const MessageSheet({super.key, required this.model, required this.id, required this.text});
  final PircModel model;
  final String id;
  final String text;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: model,
        builder: (context, _) {
          final look = Look.of(context);
          final s = model.session(id);
          // The session gone: its sheet goes too.
          if (s == null) {
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (context.mounted && ModalRoute.of(context)?.isCurrent == true) Navigator.of(context).pop();
            });
            return const SizedBox.shrink();
          }
          final busy = s.working || s.compacting;
          void go(FromMessage how) => Navigator.of(context).pop(how);
          return Sheet(title: 'From this message', children: [
            Quoted(text, lines: 3),
            if (busy) Padding(padding: const EdgeInsets.fromLTRB(20, 0, 20, 12), child: Text('pi is working; stop it first.', style: look.text(size: 14, color: look.ink2, spacing: 0))),
            SheetGroup(children: [
              if (movesInTree(s)) ...[
                SheetRow(label: 'Go back to here', sub: 'Carry on from before it; what came after stays as a branch', disabled: busy, onTap: () => go(FromMessage.back)),
                SheetRow(label: 'Go back with a summary', sub: 'pi also summarises what came after, for the model', disabled: busy, onTap: () => go(FromMessage.summary)),
              ],
              SheetRow(label: 'Fork from here', sub: 'A new session${windowOf(s) == null ? '' : ' in ${windowOf(s)}'} with what came before it', disabled: busy, onTap: () => go(FromMessage.fork)),
            ]),
          ]);
        },
      );
}

// A message or a branch quoted at the top of a sheet, ruled on its left;
// with a smaller line under it.
class Quoted extends StatelessWidget {
  const Quoted(this.text, {super.key, this.lines = 2, this.more});
  final String text;
  final int lines;
  final String? more;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Container(
      margin: const EdgeInsets.fromLTRB(20, 0, 20, 12),
      padding: const EdgeInsets.only(left: 12),
      decoration: BoxDecoration(border: Border(left: BorderSide(color: look.rule, width: 2))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, spacing: 4, children: [
        Text(text, maxLines: lines, overflow: TextOverflow.ellipsis, style: look.text(size: 15.5, height: 1.375, color: look.ink2, spacing: 0)),
        if (more != null) Text(more!, maxLines: 2, overflow: TextOverflow.ellipsis, style: look.text(size: 13.5, color: look.ink2, spacing: 0)),
      ]),
    );
  }
}

// Choosing a model, from those pi offers, by searching: grouped by
// provider, pi's order within each, the session's own marked.
class ModelPicker extends StatefulWidget {
  const ModelPicker({super.key, required this.models, required this.current});
  final List<Json>? models;
  final ModelView? current;

  @override
  State<ModelPicker> createState() => _ModelPickerState();
}

class _ModelPickerState extends State<ModelPicker> {
  final _query = TextEditingController();

  static String _key(Json m) => '${m['provider']}/${m['id']}';
  static String _label(Json m) => (m['name'] as String? ?? '').isNotEmpty ? m['name'] as String : m['id'] as String;

  @override
  void initState() {
    super.initState();
    _query.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  // "200k", "1.5M".
  static String _tokens(int n) => n >= 1000000 ? '${(n / 1000000).toStringAsFixed(1).replaceFirst(RegExp(r'\.0$'), '')}M' : '${(n / 1000).round()}k';

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final ms = widget.models ?? const <Json>[];
    final first = <String, int>{};
    for (final (i, c) in ms.indexed) {
      first.putIfAbsent((c['model'] as Json)['provider'] as String, () => i);
    }
    final byProvider = [for (final (i, c) in ms.indexed) (i, c)]
      ..sort((a, b) {
        final pa = first[(a.$2['model'] as Json)['provider']]!, pb = first[(b.$2['model'] as Json)['provider']]!;
        return pa != pb ? pa - pb : a.$1 - b.$1;
      });
    final query = _query.text;
    final results = rank(query, [for (final x in byProvider) x.$2], (c) {
      final m = c['model'] as Json;
      return '${_label(m)} ${_key(m)}';
    });
    final current = widget.current == null ? null : '${widget.current!.provider}/${widget.current!.id}';
    final mono = look.mono(size: 12, color: look.ink2);
    return CupertinoPageScaffold(
      backgroundColor: look.page,
      child: SafeArea(
        bottom: false,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Container(
            height: 44,
            decoration: BoxDecoration(border: Border(bottom: BorderSide(color: look.rule))),
            child: Stack(alignment: Alignment.center, children: [
              Text('Model', style: look.text(size: 17, weight: FontWeight.w600, spacing: -0.2)),
              Positioned(
                left: 8,
                top: 0,
                bottom: 0,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => Navigator.of(context).pop(),
                  child: Padding(padding: const EdgeInsets.symmetric(horizontal: 8), child: Center(child: Text('Cancel', style: look.text(size: 17, color: look.accent, spacing: 0)))),
                ),
              ),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
            child: CupertinoSearchTextField(
              controller: _query,
              autofocus: true,
              autocorrect: false,
              placeholder: widget.models == null ? 'Loading models…' : 'Search ${ms.length} models',
              style: look.text(size: 17),
              placeholderStyle: look.text(size: 17, color: look.ink3),
              backgroundColor: look.wash,
              borderRadius: BorderRadius.circular(11),
              itemColor: look.ink3,
              prefixInsets: const EdgeInsetsDirectional.fromSTEB(10, 0, 4, 0),
              onSubmitted: (_) {
                if (results.isNotEmpty) _pick(results.first.item);
              },
            ),
          ),
          Expanded(
            child: ListView(padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom), children: [
              if (widget.models != null && results.isEmpty)
                Padding(padding: const EdgeInsets.fromLTRB(20, 24, 20, 24), child: Text('No model matches “$query”.', style: look.text(size: 16, color: look.ink2))),
              for (final (i, r) in results.indexed) ...[
                if (query.isEmpty && (r.item['model'] as Json)['provider'] != (i == 0 ? null : (results[i - 1].item['model'] as Json)['provider']))
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 18, 20, 4),
                    child: Text(((r.item['model'] as Json)['provider'] as String).toUpperCase(), style: look.text(size: 13, color: look.ink2, spacing: 0.4)),
                  ),
                _row(look, r.item, r.match.positions.toSet(), current, mono),
              ],
            ]),
          ),
        ]),
      ),
    );
  }

  void _pick(Json c) {
    final m = c['model'] as Json;
    Navigator.of(context).pop(ModelView(provider: m['provider'] as String, id: m['id'] as String, name: m['name'] as String? ?? ''));
  }

  Widget _row(Look look, Json c, Set<int> positions, String? current, TextStyle mono) {
    final m = c['model'] as Json;
    final name = _label(m);
    final key = _key(m);
    final mine = key == current;
    final window = c['contextWindow'] as int? ?? 0;
    final also = [if (c['reasoning'] == true) 'reasoning', if (c['images'] == true) 'images'];
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => _pick(c),
      child: Container(
        constraints: const BoxConstraints(minHeight: 50),
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
        decoration: BoxDecoration(border: Border(top: BorderSide(color: look.rule))),
        child: Row(crossAxisAlignment: CrossAxisAlignment.center, spacing: 10, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              marked(look, name, 0, positions, look.text(size: 16, weight: mine ? FontWeight.w600 : FontWeight.w400, color: mine ? look.accent : look.ink, spacing: 0)),
              Text.rich(
                TextSpan(children: [
                  markedSpan(look, key, name.length + 1, positions, mono),
                  if (also.isNotEmpty) TextSpan(text: ' · ${also.join(' · ')}', style: look.text(size: 12, color: look.ink3, spacing: 0)),
                ]),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ]),
          ),
          if (mine)
            Row(mainAxisSize: MainAxisSize.min, spacing: 3, children: [
              Icon(CupertinoIcons.checkmark_alt, size: 13, color: look.done),
              Text('CURRENT', style: look.text(size: 12, weight: FontWeight.w600, color: look.done, spacing: 1.2)),
            ])
          else if (window > 0)
            Text(_tokens(window), style: look.text(size: 13, color: look.ink2, spacing: 0).copyWith(fontFeatures: const [FontFeature.tabularFigures()])),
        ]),
      ),
    );
  }
}
