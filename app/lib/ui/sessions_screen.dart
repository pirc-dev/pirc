// The live sessions, by host, then by the tmux session or herdr workspace
// they run in, each closed until opened, the most recent first; or, with a
// search, every session that matches. Each shows pi's name for it, its
// window's above it, when it last had a message, and whether it has news:
// finished since it was last opened. A group's +, or a host's when its
// sessions are all in one, opens a new agent there (launch.dart). As the
// web page's Native look (web/page/src/Sessions.tsx), on the phone.
import 'dart:math' as math;

import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart' show ValueListenable;

import '../app/model.dart';
import '../core/fuzzy.dart';
import '../core/names.dart';
import '../core/view.dart';
import 'hosts.dart';
import 'launch.dart';
import 'look.dart';
import 'sheet.dart';

// The date past a day, in the phone's language: a weekday, else day and
// month. Kept short and plain until the app has its translations.
const _weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

String day(int at, bool weekday) {
  final d = DateTime.fromMillisecondsSinceEpoch(at);
  return weekday ? _weekdays[d.weekday - 1] : '${_months[d.month - 1]} ${d.day}';
}

String _hostOf(SessionView s) => s.hostLabel.isNotEmpty ? s.hostLabel : s.hostname;

// The group every one of the sessions is in, if they are all in one.
String? _oneGroup(List<SessionView> list) {
  final names = {for (final s in list) s.place?.group};
  return names.length == 1 && (names.first ?? '').isNotEmpty ? names.first : null;
}

// What a search reads, as the web page's: the title, the first message,
// where it runs, its folder and model, and the latest message; and where in
// it "where" starts, to mark what matched there.
String _searched(SessionView s) => '${title(s)} ${s.first ?? ''} ${where(s)} ${details(s)} ${s.last?.text ?? ''}';
int _whereAt(SessionView s) => title(s).length + 1 + (s.first ?? '').length + 1;

class _Group {
  _Group(this.name, this.number);
  final String name;
  final int number;
  final sessions = <SessionView>[];
}

// A host's sessions by the tmux session or herdr workspace they run in;
// those in none after, ungrouped. All in one says nothing, so they are
// listed as if ungrouped.
({List<_Group> groups, List<SessionView> loose}) _groups(List<SessionView> list) {
  final by = <String, _Group>{};
  final loose = <SessionView>[];
  for (final s in list) {
    final g = s.place?.group;
    if (g == null || g.isEmpty) {
      loose.add(s);
      continue;
    }
    by.putIfAbsent(g, () => _Group(g, s.place?.groupNumber ?? 1 << 30)).sessions.add(s);
  }
  if (by.length == 1 && loose.isEmpty) return (groups: [], loose: list);
  final groups = by.values.toList()..sort((a, b) => a.number != b.number ? a.number - b.number : a.name.compareTo(b.name));
  return (groups: groups, loose: loose);
}

// The name a host's or group's page goes by on a navigator, so that the
// app can tell its pages from what else is open.
const scopeRoute = 'pirc.scope';

class SessionsScreen extends StatefulWidget {
  const SessionsScreen({super.key, required this.model, required this.open, this.unfolded = const {}, this.onFold, this.settings, this.host, this.group, this.openHere, this.selected});

  final PircModel model;
  final void Function(String id) open;
  // What the list shows, as the web page's scopes: every session, one
  // host's, or one group's of a host, each a page of its own over the one
  // it was opened from.
  final String? host;
  final String? group;
  // Opens a session's chat over this page, so that going back returns
  // here; open, which goes back to the whole list, when none.
  final void Function(String id)? openHere;
  // The session whose chat is beside the list, on a wide screen: its row
  // marked, on every page of the list.
  final ValueListenable<String?>? selected;
  // The hosts ("h:<host>") and groups ("g:<host>/<group>") open, and where
  // to keep them when one opens or closes.
  final Set<String> unfolded;
  final void Function(Set<String>)? onFold;
  // Opens Settings, from the button beside the title.
  final VoidCallback? settings;

  @override
  State<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends State<SessionsScreen> {
  late Set<String> _open = {...widget.unfolded};
  final _query = TextEditingController();

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  void _toggle(String key) {
    setState(() => _open = {..._open}..toggle(key));
    widget.onFold?.call(_open);
  }

  // A host's or group's page, over this one; what is open on it kept for
  // all.
  void _go(String host, [String? group]) => Navigator.of(context).push(CupertinoPageRoute<void>(
        settings: const RouteSettings(name: scopeRoute),
        builder: (_) => SessionsScreen(
          model: widget.model,
          open: widget.open,
          openHere: widget.openHere,
          selected: widget.selected,
          unfolded: _open,
          onFold: (keys) {
            _open = keys;
            widget.onFold?.call(keys);
          },
          host: host,
          group: group,
        ),
      ));

  void Function(String id) get _openChat => widget.openHere ?? widget.open;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final model = widget.model;
    return ListenableBuilder(
      listenable: Listenable.merge([model, _query, ?widget.selected]),
      builder: (context, _) {
        final host = widget.host, group = widget.group;
        final sessions = [for (final s in model.sessions) if ((host == null || _hostOf(s) == host) && (group == null || s.place?.group == group)) s];
        final news = model.news;
        final hosts = <String, List<SessionView>>{};
        for (final s in sessions) {
          hosts.putIfAbsent(_hostOf(s), () => []).add(s);
        }
        final query = _query.text.trim();
        final found = query.isEmpty ? const <({SessionView item, FuzzyMatch match})>[] : rank(query, sessions, _searched);
        final working = sessions.where((s) => s.working || s.compacting).length;
        final asking = sessions.where((s) => (s.questions ?? const []).isNotEmpty).length;
        final fresh = sessions.where((s) => news.contains(s.id)).length;
        Widget row(SessionView s, {bool window = true, Set<int>? matched}) =>
            _Row(s, news: news.contains(s.id), now: model.now(), window: window, matched: matched, open: _openChat, selected: widget.selected?.value == s.id);
        return CupertinoPageScaffold(
          backgroundColor: look.page,
          child: CustomScrollView(
            slivers: [
              // The title under the phone's status bar, as the web page's
              // header: no bar of its own above it. The status bar's strip
              // stays, so that the search held under it is not behind it.
              PinnedHeaderSliver(child: Container(height: MediaQuery.paddingOf(context).top, color: look.page)),
              if (host != null)
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(12, 4, 20, 0),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: CupertinoButton(
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        minimumSize: const Size(44, 44),
                        onPressed: () => Navigator.of(context).maybePop(),
                        child: Row(mainAxisSize: MainAxisSize.min, children: [
                          Icon(CupertinoIcons.chevron_back, size: 22, color: look.accent),
                          Text(group != null ? host : 'Sessions', style: look.text(color: look.accent)),
                        ]),
                      ),
                    ),
                  ),
                ),
              SliverToBoxAdapter(
                child: Padding(
                  padding: EdgeInsets.fromLTRB(20, host == null ? 12 : 0, 10, 6),
                  child: Row(children: [
                    Expanded(
                      child: Semantics(
                        header: true,
                        child: Text(group ?? host ?? 'Sessions',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: look.text(size: group != null ? 28 : 34, weight: FontWeight.w700, spacing: group != null ? 0 : 0.34, height: 1.25)),
                      ),
                    ),
                    if (widget.settings != null && host == null)
                      Semantics(
                        button: true,
                        label: 'Settings',
                        excludeSemantics: true,
                        onTap: widget.settings,
                        child: GestureDetector(
                          behavior: HitTestBehavior.opaque,
                          onTap: widget.settings,
                          child: SizedBox(width: 44, height: 44, child: Center(child: CustomPaint(size: const Size.square(22), painter: _SettingsIcon(look.accent)))),
                        ),
                      ),
                  ]),
                ),
              ),
              if (model.relay.state != 'ready') SliverToBoxAdapter(child: _Connection(model.relay)),
              if (sessions.isNotEmpty)
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
                    child: Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
                      if (asking > 0) Pill(count: asking, word: 'asking', color: look.block, wash: look.blockWash, big: true),
                      if (fresh > 0) Pill(count: fresh, word: 'done', color: look.done, wash: look.doneWash, big: true),
                      if (working > 0) Pill(count: working, word: 'working', color: look.work, wash: look.workWash, big: true),
                      Pill(count: sessions.length, word: 'in all', color: look.ink2, wash: look.wash, big: true),
                      if (host != null && (group ?? _oneGroup(sessions)) != null && launchable(sessions) != null)
                        _NewAgentPill(onTap: () => showSheet<void>(context, (_) => LaunchSheet(model: widget.model, beside: launchable(sessions)!, open: widget.open))),
                    ]),
                  ),
                ),
              SliverToBoxAdapter(child: JoinRequests(model: model, day: day)),
              if (sessions.isNotEmpty)
                PinnedHeaderSliver(child: _SearchBar(look, _query, sessions.length, where: group != null ? ' in $group' : host != null ? ' on $host' : '')),
              if (sessions.isEmpty && model.relay.state == 'ready')
                SliverFillRemaining(
                  hasScrollBody: false,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(32, 80, 32, 32),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(host == null ? 'No pi sessions are running.' : 'No pi sessions ${group != null ? 'in $group' : 'on $host'} now.', style: look.text(size: 24)),
                      if (host == null) ...[
                        const SizedBox(height: 10),
                        Text('Start pi with the PiRC extension on any of your machines and it appears here.', style: look.text(size: 17, color: look.ink2, height: 1.5)),
                      ],
                    ]),
                  ),
                ),
              if (query.isNotEmpty) ...[
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(20, 14, 20, 4),
                    child: Text(
                      (found.isEmpty ? 'No session matches “$query”' : '${found.length} ${found.length == 1 ? 'match' : 'matches'}, best first').toUpperCase(),
                      style: look.text(size: 11.5, weight: FontWeight.w600, color: look.ink2, spacing: 1.6),
                    ),
                  ),
                ),
                if (found.isNotEmpty)
                  SliverToBoxAdapter(child: _Card([for (final f in found) row(f.item, window: false, matched: {...f.match.positions})])),
              ] else if (group != null) ...[
                if (sessions.isNotEmpty) SliverToBoxAdapter(child: Padding(padding: const EdgeInsets.only(top: 6), child: _Card([for (final s in sessions) row(s)]))),
              ] else if (host != null) ...[
                if (sessions.isNotEmpty) SliverToBoxAdapter(child: Padding(padding: const EdgeInsets.only(top: 4), child: _body(look, host, sessions, news, row))),
              ] else
                for (final MapEntry(key: host, value: list) in (hosts.entries.toList()..sort((a, b) => a.key.compareTo(b.key))))
                  SliverToBoxAdapter(child: _host(look, host, list, news, row)),
              const SliverToBoxAdapter(child: SizedBox(height: 32)),
            ],
          ),
        );
      },
    );
  }

  // A + for a new agent beside the newest of these that can open one.
  _NewAgent? _newAgent(List<SessionView> sessions, String where) {
    final s = launchable(sessions);
    if (s == null) return null;
    return (label: 'New agent in $where', onTap: () => showSheet<void>(context, (_) => LaunchSheet(model: widget.model, beside: s, open: widget.open)));
  }

  // A host: its name, its counts, and when open its groups, each folding,
  // and the sessions in none.
  Widget _host(Look look, String host, List<SessionView> list, Set<String> news, Widget Function(SessionView) row) {
    final key = 'h:$host';
    final open = _open.contains(key);
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _Header(
          open: open,
          toggle: () => _toggle(key),
          label: '${open ? 'Fold' : 'Unfold'} $host',
          go: () => _go(host),
          goLabel: 'Open $host',
          padding: const EdgeInsets.fromLTRB(32, 18, 20, 4),
          name: Text(host.toUpperCase(), style: look.text(size: 13, color: look.ink2, spacing: 0.4), maxLines: 1, overflow: TextOverflow.ellipsis),
          counts: _Counts(list, news),
          add: _oneGroup(list) == null ? null : _newAgent(list, _oneGroup(list)!),
        ),
        if (open) _body(look, host, list, news, row),
      ]),
    );
  }

  // A host's groups, each folding, and the sessions in none: under its
  // line in the whole list, and on its own page.
  Widget _body(Look look, String host, List<SessionView> list, Set<String> news, Widget Function(SessionView) row) {
    final (:groups, :loose) = _groups(list);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      for (final g in groups) ...[
        _Header(
          open: _open.contains('g:$host/${g.name}'),
          toggle: () => _toggle('g:$host/${g.name}'),
          label: '${_open.contains('g:$host/${g.name}') ? 'Fold' : 'Unfold'} ${g.name}',
          go: () => _go(host, g.name),
          goLabel: 'Open ${g.name}',
          padding: const EdgeInsets.fromLTRB(32, 0, 20, 0),
          minHeight: 44,
          rule: true,
          name: Text(g.name, style: look.text(size: 15, weight: FontWeight.w600), maxLines: 1, overflow: TextOverflow.ellipsis),
          counts: _Counts(g.sessions, news),
          add: _newAgent(g.sessions, g.name),
        ),
        if (_open.contains('g:$host/${g.name}')) _Card([for (final s in g.sessions) row(s)]),
      ],
      if (loose.isNotEmpty) Padding(padding: EdgeInsets.only(top: groups.isEmpty ? 6 : 8), child: _Card([for (final s in loose) row(s)])),
    ]);
  }
}

extension on Set<String> {
  void toggle(String key) {
    if (!remove(key)) add(key);
  }
}

// A host's or group's line: its name, what it holds, and a chevron that
// turns when it is open. The name opens its page, as the web page's does;
// the rest of the line folds or unfolds it.
class _Header extends StatelessWidget {
  const _Header({required this.open, required this.toggle, required this.label, required this.go, required this.goLabel, required this.padding, required this.name, required this.counts, this.minHeight = 0, this.rule = false, this.add});
  final bool open;
  final VoidCallback toggle;
  final String label;
  final VoidCallback go;
  final String goLabel;
  final EdgeInsets padding;
  final Widget name;
  final Widget counts;
  final double minHeight;
  // A group's: a hairline between its counts and its chevron.
  final bool rule;
  // A + after the name, for a new agent there; without one, no room is
  // left for it.
  final _NewAgent? add;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final add = this.add;
    Widget tap(String label, VoidCallback onTap, Widget child, {bool? expanded}) => Semantics(
          button: true,
          expanded: expanded,
          label: label,
          excludeSemantics: true,
          onTap: onTap,
          child: GestureDetector(behavior: HitTestBehavior.opaque, onTap: onTap, child: child),
        );
    // Each part of the line takes its share of the padding, so that all are
    // as tall as the line and every part of it answers a tap; centred in
    // the same padding, what each holds is level with the rest. With a +,
    // at least as tall as its target.
    Widget box(EdgeInsets p, Widget child) => ConstrainedBox(
          constraints: BoxConstraints(minHeight: add == null ? minHeight : math.max(minHeight, 44)),
          child: Padding(padding: p, child: Align(alignment: Alignment.centerLeft, widthFactor: 1, heightFactor: 1, child: child)),
        );
    return LayoutBuilder(
      builder: (context, c) => Row(children: [
        // The name at most 60% of the line, as the web page's, so that a
        // long one leaves the + in view. A group's counts follow, its rule
        // taking the rest; a host's go to the right. The chevron is always
        // at the end.
        tap(goLabel, go, box(padding.copyWith(right: 0), ConstrainedBox(constraints: BoxConstraints(maxWidth: (c.maxWidth - padding.horizontal - (add == null ? 0 : 44)) * 0.6), child: name))),
        if (add != null) tap(add.label, add.onTap, box(EdgeInsets.only(top: padding.top, bottom: padding.bottom), SizedBox(width: 44, child: Icon(CupertinoIcons.plus, size: 18, color: look.accent)))),
        Expanded(
          child: tap(
            label,
            toggle,
            expanded: open,
            box(
              padding.copyWith(left: 0),
              Row(children: [
                SizedBox(width: add == null ? 10 : 0),
                if (rule) ...[counts, const SizedBox(width: 10), Expanded(child: Container(height: 1, color: look.rule))] else ...[const Spacer(), counts],
                const SizedBox(width: 10),
                AnimatedRotation(turns: open ? 0.25 : 0, duration: const Duration(milliseconds: 150), child: Icon(CupertinoIcons.chevron_forward, size: 14, color: look.ink3)),
              ]),
            ),
          ),
        ),
      ]),
    );
  }
}

// A host's or group's +: what it says, and the sheet it opens.
typedef _NewAgent = ({String label, VoidCallback onTap});

// What a host or group holds, so that a closed one still says it: how many
// ask a question, how many finished since last opened, how many work, how
// many in all.
class _Counts extends StatelessWidget {
  const _Counts(this.sessions, this.news);
  final List<SessionView> sessions;
  final Set<String> news;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final asking = sessions.where((s) => (s.questions ?? const []).isNotEmpty).length;
    final fresh = sessions.where((s) => news.contains(s.id)).length;
    final working = sessions.where((s) => s.working || s.compacting).length;
    return Row(mainAxisSize: MainAxisSize.min, spacing: 6, children: [
      if (asking > 0) Pill(count: asking, word: 'asking', color: look.block, wash: look.blockWash),
      if (fresh > 0) Pill(count: fresh, word: 'new', color: look.done, wash: look.doneWash),
      if (working > 0) Pill(count: working, word: 'working', color: look.work, wash: look.workWash),
      Text('${sessions.length}', style: look.text(size: 12.5, color: look.ink2, spacing: 0)),
    ]);
  }
}

// Rows on a card, with hairlines between them.
class _Card extends StatelessWidget {
  const _Card(this.rows);
  final List<Widget> rows;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(color: look.card, borderRadius: BorderRadius.circular(14)),
      child: Column(children: [
        for (final (i, r) in rows.indexed) ...[if (i > 0) Container(height: 0.5, color: look.rule), r],
      ]),
    );
  }
}

// A session: its status, its window's name above pi's name for it, and when
// it last had a message. One that finished since it was last opened is set
// heavier, its time in teal. A search result says where it runs instead,
// and marks what matched.
class _Row extends StatefulWidget {
  const _Row(this.s, {required this.news, required this.now, required this.open, this.window = true, this.matched, this.selected = false});
  final SessionView s;
  // Its chat beside the list: on the accent's wash, with its line at the
  // start, as the web page's.
  final bool selected;
  final bool news;
  final int now;
  final void Function(String id) open;
  final bool window;
  final Set<int>? matched;

  @override
  State<_Row> createState() => _RowState();
}

class _RowState extends State<_Row> {
  var _down = false;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final s = widget.s;
    final status = statusOf(s, widget.news ? {s.id} : const {});
    final at = s.last?.at;
    final above = widget.matched != null ? null : (widget.window ? windowOf(s) : null);
    final name = marked(look, title(s), 0, widget.matched, look.text(size: 16, weight: widget.news ? FontWeight.w700 : FontWeight.w400, height: 1.35));
    final time = Text(at == null ? '' : ago(at, widget.now, day),
        style: look.text(size: 13, color: widget.news ? look.done : look.ink2, weight: widget.news ? FontWeight.w700 : FontWeight.w400, spacing: 0));
    return Semantics(
      button: true,
      selected: widget.selected,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: (_) => setState(() => _down = true),
        onTapCancel: () => setState(() => _down = false),
        onTapUp: (_) => setState(() => _down = false),
        onTap: () => widget.open(s.id),
        child: Container(
          color: _down ? look.wash : widget.selected ? look.accentSoft : null,
          foregroundDecoration: widget.selected ? BoxDecoration(border: Border(left: BorderSide(color: look.accent, width: 3))) : null,
          constraints: const BoxConstraints(minHeight: 56),
          padding: const EdgeInsets.fromLTRB(14, 9, 16, 9),
          child: Row(children: [
            StatusBadge(status, compacting: s.compacting),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                if (above != null) Text(above, style: look.text(size: 13, color: look.ink2, height: 1.4), maxLines: 1, overflow: TextOverflow.ellipsis),
                Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
                  Expanded(child: name),
                  const SizedBox(width: 12),
                  time,
                ]),
                if (widget.matched != null)
                  marked(look, where(s), _whereAt(s), widget.matched, look.text(size: 12.5, color: look.ink3)),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

// The search, held under the bar as the list scrolls.
class _SearchBar extends StatelessWidget {
  const _SearchBar(this.look, this.query, this.count, {this.where = ''});
  final Look look;
  final TextEditingController query;
  final int count;
  // " in <group>", " on <host>", or nothing for every session.
  final String where;

  @override
  Widget build(BuildContext context) => Container(
        color: look.page,
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 6),
        child: CupertinoSearchTextField(
          controller: query,
          placeholder: 'Search $count session${count == 1 ? '' : 's'}$where',
          style: look.text(size: 17),
          placeholderStyle: look.text(size: 17, color: look.ink3),
          backgroundColor: look.wash,
          borderRadius: BorderRadius.circular(11),
          itemColor: look.ink3,
          prefixInsets: const EdgeInsetsDirectional.fromSTEB(10, 0, 4, 0),
          autocorrect: false,
        ),
      );
}

// Why the list may be stale: not connected to the relay.
class _Connection extends StatelessWidget {
  const _Connection(this.relay);
  final RelayView relay;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final text = switch (relay.state) {
      'connecting' => 'Connecting to the relay…',
      'refused' => 'The relay refused this phone${relay.reason == null ? '' : ': ${relay.reason}'}',
      _ => 'Not connected to the relay${relay.reason == null ? '' : ': ${relay.reason}'}',
    };
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 4),
      child: Row(
        children: [
          if (relay.state == 'connecting') ...[const CupertinoActivityIndicator(radius: 7), const SizedBox(width: 8)],
          Expanded(child: Text(text, style: look.text(size: 13, color: look.secondary))),
        ],
      ),
    );
  }
}

// New agent, among a host's or group's counts on its own page: their size,
// in a wider target that moves nothing beside it, the row centring them.
class _NewAgentPill extends StatelessWidget {
  const _NewAgentPill({required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Semantics(
      button: true,
      label: 'New agent',
      excludeSemantics: true,
      onTap: onTap,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 7),
          child: Container(
            height: 26,
            padding: const EdgeInsets.symmetric(horizontal: 10),
            decoration: BoxDecoration(color: look.wash, borderRadius: BorderRadius.circular(13)),
            child: Row(mainAxisSize: MainAxisSize.min, spacing: 3, children: [
              Icon(CupertinoIcons.plus, size: 13, color: look.accent),
              Text('New agent', style: look.text(size: 13, color: look.accent, spacing: 0)),
            ]),
          ),
        ),
      ),
    );
  }
}


// The web page's settings icon (icons.tsx): two sliders, drawn on its 24
// grid with its 1.6 stroke.
class _SettingsIcon extends CustomPainter {
  _SettingsIcon(this.color);
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.scale(size.width / 24);
    final line = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.6
      ..strokeCap = StrokeCap.round;
    for (final (a, b) in [(const Offset(4, 7), const Offset(13, 7)), (const Offset(17, 7), const Offset(20, 7)), (const Offset(4, 17), const Offset(7, 17)), (const Offset(11, 17), const Offset(20, 17))]) {
      canvas.drawLine(a, b, line);
    }
    canvas.drawCircle(const Offset(15, 7), 2, line);
    canvas.drawCircle(const Offset(9, 17), 2, line);
  }

  @override
  bool shouldRepaint(_SettingsIcon old) => old.color != color;
}
