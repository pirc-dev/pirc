// A session's chat, as the web page's Native look (web/page/src/Chat.tsx,
// Tool.tsx, Composer.tsx, Ask.tsx): a header with its status, title and
// where it runs; its items as runs (core/chat.dart), replies in Markdown,
// tool calls as lines that open to their arguments and output, messages
// sent and not yet shown; and the composer, with pi's question above it,
// and while pi works how long, Queue or Steer, and Stop. One of the user's
// messages, once pi has saved it, offers going back or a fork from there.
import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/cupertino.dart';
import 'package:flutter/rendering.dart' show RenderAbstractViewport;

import '../app/drafts.dart';
import '../app/model.dart';
import '../core/chat.dart';
import '../core/images.dart';
import '../core/names.dart';
import '../core/pending.dart';
import '../core/protocol.dart';
import '../core/results.dart';
import '../core/view.dart';
import 'actions.dart';
import 'look.dart';
import 'images.dart';
import 'markdown.dart';
import 'selectable.dart';
import 'sheet.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, required this.model, required this.id, this.drafts, this.open, this.wide = false});

  final PircModel model;
  final String id;
  // Where what is being written is kept, as the web page keeps it.
  final Drafts? drafts;
  // Opens a session's chat: a new agent's, from the session's actions.
  final void Function(String id)? open;
  // Beside the list (a wide screen): no way back, the list being there.
  final bool wide;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  // The composer's text, here so that Edit on an unsent message can put it
  // back.
  final _text = TextEditingController();
  // Images to send with it; not kept with the draft, as the web's are not.
  final _images = ValueNotifier<List<StoredImage>>(const []);
  // The chat keeps a reader's place as the web page's does: two lists about
  // a centre, the rows before [_split] running up from it and the rest
  // down. While the reader is at the end, the centre is kept above the last
  // run (the reply being written and what follows it), and where it sits on
  // the screen ([_anchor]) is set so that the end is at the bottom: a short
  // chat does not scroll, and the end stays there as the reply grows. Away
  // from the end, neither changes, so what grows grows downward, under
  // what is being read; they change on coming back. Until first laid out,
  // every row is above the centre at the bottom: the end, unmeasured.
  final _scroll = ScrollController();
  final _rowKeys = <String, GlobalKey>{};
  var _ids = const <String>[];
  var _lastRun = 0;
  int? _split;
  var _anchor = 1.0;
  var _atEnd = true;
  // Scrolled up, away from the end, a button goes back, and says when more
  // has come there since: another item, more of a reply, a tool's result
  // (Chat.tsx).
  var _more = false;
  var _lastSeen = '';
  var _sent = 0;
  // What an action answered, or why it failed, under the header.
  ({String text, bool bad})? _notice;
  // The header's cost and context, asked of pi when the chat opens, after
  // each reply, and when the model changes (Chat.tsx's useSpend).
  String? _spend;
  String? _spendFor;

  // What is written is kept a moment after it changes, and on leaving.
  Timer? _keepDraft;
  // Loaded: until then, nothing written is kept over the draft.
  var _drafted = false;

  @override
  void initState() {
    super.initState();
    widget.model.opened(widget.id);
    _scroll.addListener(_scrolled);
    _loadDraft();
  }

  Future<void> _loadDraft() async {
    final draft = await widget.drafts?.load(widget.id) ?? '';
    if (!mounted) return;
    // Something written meanwhile wins.
    if (draft.isNotEmpty && _text.text.isEmpty) _text.text = draft;
    _drafted = true;
    _text.addListener(_written);
    if (_text.text != draft) _written();
  }

  void _written() {
    _keepDraft?.cancel();
    _keepDraft = Timer(const Duration(milliseconds: 400), _saveDraft);
  }

  void _saveDraft() {
    _keepDraft?.cancel();
    if (_drafted) widget.drafts?.save(widget.id, _text.text);
  }

  @override
  void dispose() {
    if (_keepDraft?.isActive ?? false) _saveDraft();
    _text.dispose();
    _images.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _scrolled() {
    final p = _scroll.position;
    final atEnd = p.maxScrollExtent - p.pixels < 80;
    if (atEnd == _atEnd && (!atEnd || !_more)) return;
    setState(() {
      _atEnd = atEnd;
      if (atEnd) {
        _more = false;
        _lastSeen = signature(widget.model.chat(widget.id)?.items.lastOrNull);
      }
    });
    if (atEnd) _later();
  }

  void _toEnd() {
    if (!_scroll.hasClients) return;
    _atEnd = true;
    _scroll.jumpTo(_scroll.position.maxScrollExtent);
    _scrolled();
    _later();
  }

  // One of the session's actions, its failure said under the header.
  Future<Outcome> _run(SessionMessage Function(String requestId) request, {bool compacts = false}) async {
    final r = await widget.model.act(widget.id, request, compacts: compacts);
    if (!r.ok && mounted) setState(() => _notice = (text: '${r.code}: ${r.message}', bad: true));
    return r;
  }

  void _say(String text) {
    if (mounted) setState(() => _notice = (text: text, bad: false));
  }

  void _actions() => showSheet<void>(context, (_) => SessionActions(model: widget.model, id: widget.id, run: _run, say: _say, open: widget.open));

  static const _done = {
    FromMessage.back: 'Went back to before the message; it is back in the box below',
    FromMessage.summary: 'Went back to before the message, with a summary of what came after; the message is back in the box below',
    FromMessage.fork: 'Forked into a new session; the message is back in the box below',
  };

  // Going back or forking from one of the user's messages, which pi has
  // saved (its entry): as pi's /tree and /fork, the message comes back, to
  // edit and send.
  Future<void> _from(UserItem it) async {
    final entry = it.entryId;
    if (entry == null) return;
    final how = await showSheet<FromMessage>(context, (_) => MessageSheet(model: widget.model, id: widget.id, text: it.text));
    if (how == null || !mounted) return;
    final r = how == FromMessage.fork
        ? await _run((r) => SessionMessage(fork: Fork(requestId: r, entryId: entry)))
        // Summarising the branch left is compacting, to pi.
        : await _run((r) => SessionMessage(navigateTree: NavigateTree(requestId: r, entryId: entry, summarize: how == FromMessage.summary)), compacts: true);
    if (!r.ok || !mounted) return;
    _text.text = _text.text.trim().isEmpty ? it.text : '${it.text}\n\n${_text.text}';
    _say(_done[how]!);
  }

  // Quietly: the header works without it.
  void _askSpend(SessionView? s, List<ChatItem> items) {
    if (s == null) return;
    final m = s.model;
    final now = '${s.id} ${m?.provider}/${m?.id} ${s.working || s.compacting} ${items.whereType<AssistantItem>().length}';
    if (now == _spendFor) return;
    _spendFor = now;
    widget.model.act(widget.id, (r) => SessionMessage(statsRequest: StatsRequest(requestId: r))).then((r) {
      final text = spend(r);
      if (mounted && _spendFor == now && text != null) setState(() => _spend = text);
    });
  }

  void _later() => WidgetsBinding.instance.addPostFrameCallback((_) => _recentre());

  // At the end, and still: the centre above the last run, placed so that
  // the end is at the bottom, from the newest rows' heights as laid out.
  // The end itself is held by [_PinnedEnd] meanwhile, in the same frame.
  void _recentre() {
    if (!mounted || !_atEnd || !_scroll.hasClients || _scroll.position.isScrollingNotifier.value) return;
    final split = _lastRun;
    var newest = 0.0;
    for (final id in _ids.skip(split)) {
      final box = _rowKeys[id]?.currentContext?.findRenderObject();
      if (box is! RenderBox || !box.hasSize) return;
      newest += box.size.height;
    }
    final screen = _scroll.position.viewportDimension;
    final anchor = screen <= 0 ? 1.0 : (1 - newest / screen).clamp(0.0, 1.0);
    if (split == _split && (anchor - _anchor).abs() * screen < 0.5) return;
    setState(() {
      _split = split;
      _anchor = anchor;
    });
  }

  // Away from the end, a chat with nothing to scroll is at its end, as the
  // web page has it (Chat.tsx): a short one, or one made short by going
  // back in pi's tree or by a new session. Measured by its rows, since a
  // centre left where a longer chat had it leaves room to scroll. Not while
  // the reader scrolls, which a jump would cut short; once a frame.
  var _fitting = false;
  void _fitted() {
    if (_fitting) return;
    _fitting = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _fitting = false;
      if (!mounted || _atEnd || !_scroll.hasClients || _scroll.position.isScrollingNotifier.value) return;
      var height = 0.0;
      for (final id in _ids) {
        final box = _rowKeys[id]?.currentContext?.findRenderObject();
        // A row not laid out: more than a screen's worth.
        if (box is! RenderBox || !box.hasSize) return;
        height += box.size.height;
      }
      // Within 80 of the screen, as the web page's and as _scrolled's end.
      if (height - _scroll.position.viewportDimension < 80) _toEnd();
    });
  }

  // A fold about to open or close in a row above the centre, away from the
  // end: that row moved to just below the centre first, where it is on the
  // screen, so that it grows or shrinks downward and nothing on the screen
  // above it moves. Above the centre it would push what is above it up.
  void _unfolding(String id) {
    final i = _ids.indexOf(id);
    final box = _rowKeys[id]?.currentContext?.findRenderObject();
    if (_atEnd || i < 0 || i >= (_split ?? _ids.length) || !_scroll.hasClients || box is! RenderBox || !box.attached) return;
    final top = box.localToGlobal(Offset.zero, ancestor: RenderAbstractViewport.of(box)).dy;
    final p = _scroll.position;
    // The centre is at anchor × the screen's height less the offset.
    p.correctPixels(_anchor * p.viewportDimension - top);
    setState(() => _split = i);
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final model = widget.model;
    return ListenableBuilder(
      listenable: model,
      builder: (context, _) {
        final s = model.session(widget.id);
        final chat = model.chat(widget.id);
        final items = chat?.items ?? const <ChatItem>[];
        final working = s != null && (s.working || s.compacting);
        _askSpend(s, items);
        final last = signature(items.lastOrNull);
        if (_atEnd) {
          _lastSeen = last;
        } else if (last != _lastSeen) {
          _more = true;
        }
        // A message sent goes to the end, to show it.
        final sent = model.pending(widget.id).length;
        if (sent > _sent && !_atEnd) WidgetsBinding.instance.addPostFrameCallback((_) => _toEnd());
        _sent = sent;
        final chatRuns = runs(items);
        final rows = <(String, Widget)>[
          if (chat?.truncated ?? false) ('note', const _Note('Earlier messages are not shown')),
          if (chat == null || (chat.loading && items.isEmpty)) ('loading', const _Loading()),
          for (final run in chatRuns)
            if (run.length > 1 || run.first is ToolsPart || (run.first as ItemPart).item is ToolItem)
              (run.first.key, Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 6, children: [for (final p in run) _part(p)]))
            else
              (run.first.key, _part(run.first)),
          if (working && quiet(items)) ('dots', _Dots(s.compacting ? 'Compacting' : null)),
          for (final p in model.pending(widget.id))
            ('unsent ${p.key}', _Unsent(p, asking: (s?.questions ?? const []).isNotEmpty, compacting: s?.compacting ?? false, model: model, id: widget.id, edit: () {
              model.dismiss(widget.id, p);
              if (p.images != null) _images.value = [...p.images!, ..._images.value].take(imagesMax).toList();
              _text.text = _text.text.trim().isEmpty ? p.text : '${p.text}\n\n${_text.text}';
            })),
        ];
        _ids = [for (final r in rows) r.$1];
        // Each row's key and its index, kept for the rows still here: once
        // a build, as a chat may hold thousands.
        final keys = {for (final id in _ids) id: _rowKeys[id] ?? GlobalKey()};
        _rowKeys
          ..clear()
          ..addAll(keys);
        final index = {for (final (i, id) in _ids.indexed) keys[id]!: i};
        _lastRun = chatRuns.isEmpty ? rows.length : index[keys[chatRuns.last.first.key]]!;
        final split = (_split ?? rows.length).clamp(0, rows.length);
        // A row, 16 below the one before it, and the last 16 above the end;
        // beside the list, in a column of 640 at most, as the web page's.
        var side = 14.0;
        Widget row(int i) => Padding(
              key: keys[rows[i].$1],
              padding: EdgeInsets.fromLTRB(side, 16, side, i == rows.length - 1 ? 16 : 0),
              child: NotificationListener<_Unfolding>(
                onNotification: (_) {
                  _unfolding(rows[i].$1);
                  return true;
                },
                child: rows[i].$2,
              ),
            );
        int? at(Key key, int from, int to) => switch (index[key]) { final i? when i >= from && i < to => i, _ => null };
        _later();
        return CupertinoPageScaffold(
          backgroundColor: look.card,
          child: Column(
            children: [
              _Header(session: s, news: model.news, spend: _spend, actions: s == null ? null : _actions, back: !widget.wide),
              if (_notice != null) _Notice(_notice!, dismiss: () => setState(() => _notice = null)),
              Expanded(
                child: Stack(children: [
                  LayoutBuilder(builder: (context, c) {
                    // Read by row as the lists lay their rows out, after this.
                    side = widget.wide ? math.max(14, (c.maxWidth - 640) / 2) : 14;
                    return NotificationListener<ScrollNotification>(
                      // The screen's height changed (the keyboard, turning
                      // the phone), or a scroll ended: placed again.
                      onNotification: (n) {
                        if (n is ScrollEndNotification) {
                          _later();
                          _fitted();
                        }
                        return false;
                      },
                      child: NotificationListener<ScrollMetricsNotification>(
                        onNotification: (_) {
                          _later();
                          _fitted();
                          return false;
                        },
                        child: CustomScrollView(
                          controller: _scroll,
                          physics: _PinnedEnd(() => _atEnd),
                          // Each split laid out anew: a row that changes list
                          // would keep where it was in the other.
                          center: ValueKey('newer $split'),
                          anchor: _anchor,
                          slivers: [
                            SliverList(
                              key: ValueKey('older $split'),
                              delegate: SliverChildBuilderDelegate(
                                (_, i) => row(split - 1 - i),
                                childCount: split,
                                findChildIndexCallback: (k) => switch (at(k, 0, split)) { final i? => split - 1 - i, null => null },
                              ),
                            ),
                            SliverList(
                              key: ValueKey('newer $split'),
                              delegate: SliverChildBuilderDelegate(
                                (_, i) => row(split + i),
                                childCount: rows.length - split,
                                findChildIndexCallback: (k) => switch (at(k, split, rows.length)) { final i? => i - split, null => null },
                              ),
                            ),
                          ],
                        ),
                      ),
                    );
                  }),
                  if (!_atEnd) Positioned(right: 16, bottom: 12, child: _ToEnd(more: _more, onTap: _toEnd)),
                ]),
              ),
              if (s != null) _Composer(model: model, session: s, text: _text, images: _images, wide: widget.wide),
            ],
          ),
        );
      },
    );
  }

  Widget _part(Part p) => switch (p) {
        ToolsPart(:final tools) => _Folded(tools, now: widget.model.now),
        ItemPart(item: UserItem item) => _Bubble(
            text: item.text,
            images: [for (final i in item.images) i.key == null ? null : widget.model.client.image(i.key!)?.data],
            // Not where pi cannot: a message it has not saved, a session ended.
            offer: item.entryId == null || widget.model.session(widget.id) == null ? null : () => _from(item),
          ),
        ItemPart(item: AssistantItem item) => _Reply(item),
        ItemPart(item: ToolItem item) => _Tool(item, now: widget.model.now),
        ItemPart(item: CompactionItem item) => _Summary('Context compacted', item.summary),
        ItemPart(item: BranchSummaryItem item) => _Summary('Went back · what came after, summarised', item.summary),
      };
}

// Sent by a fold as it is tapped, before it opens or closes.
class _Unfolding extends Notification {
  const _Unfolding();
}

// At the end, and not being scrolled, the chat stays at its end as it grows
// or as the screen changes height, in the same frame.
class _PinnedEnd extends ScrollPhysics {
  const _PinnedEnd(this.pinned, {super.parent});
  final bool Function() pinned;

  @override
  _PinnedEnd applyTo(ScrollPhysics? ancestor) => _PinnedEnd(pinned, parent: buildParent(ancestor));

  @override
  double adjustPositionForNewDimensions({required ScrollMetrics oldPosition, required ScrollMetrics newPosition, required bool isScrolling, required double velocity}) =>
      pinned() && !isScrolling
          ? newPosition.maxScrollExtent
          : super.adjustPositionForNewDimensions(oldPosition: oldPosition, newPosition: newPosition, isScrolling: isScrolling, velocity: velocity);
}

// Back to the end, on a dark pill; "New messages" when more has come.
class _ToEnd extends StatelessWidget {
  const _ToEnd({required this.more, required this.onTap});
  final bool more;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Semantics(
      button: true,
      label: more ? 'New messages: go to the end' : 'Go to the end',
      excludeSemantics: true,
      onTap: onTap,
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          height: 36,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          decoration: BoxDecoration(
            color: look.ink,
            borderRadius: BorderRadius.circular(18),
            boxShadow: const [BoxShadow(color: Color(0x2E000000), offset: Offset(0, 6), blurRadius: 20)],
          ),
          child: Row(mainAxisSize: MainAxisSize.min, mainAxisAlignment: MainAxisAlignment.center, spacing: 6, children: [
            Icon(CupertinoIcons.arrow_down, size: 16, color: look.page),
            if (more) Text('New messages', style: look.text(size: 13.5, weight: FontWeight.w600, color: look.page, spacing: 0)),
          ]),
        ),
      ),
    );
  }
}

// Back, the status, the title, and where it runs with the model.
class _Header extends StatelessWidget {
  const _Header({required this.session, required this.news, this.spend, this.actions, this.back = true});
  final SessionView? session;
  final Set<String> news;
  // How full the context is and the cost so far, when known.
  final String? spend;
  // Opens the session's actions; none once it has ended.
  final VoidCallback? actions;

  // The way back to the list, when it is not beside the chat.
  final bool back;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final s = session;
    final model = s?.model == null ? null : (s!.model!.name.isNotEmpty ? s.model!.name : s.model!.id);
    final meta = look.text(size: 12, color: look.ink2, spacing: 0);
    final more = actions == null
        ? null
        : Semantics(
            button: true,
            label: 'Session actions',
            excludeSemantics: true,
            onTap: actions,
            child: CupertinoButton(
              padding: EdgeInsets.zero,
              minimumSize: const Size(44, 44),
              onPressed: actions,
              child: Icon(CupertinoIcons.ellipsis, size: 22, color: look.ink),
            ),
          );
    return Container(
      decoration: BoxDecoration(color: look.card, border: Border(bottom: BorderSide(color: look.rule, width: 0.5))),
      padding: EdgeInsets.only(top: MediaQuery.paddingOf(context).top + (back ? 0 : 8), bottom: 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        // Over the list, a line for the way back and the actions; beside
        // it, the actions at the end of the title's line, as the web page's.
        if (back)
          SizedBox(
            height: 44,
            child: Row(children: [const SizedBox(width: 4), _Back(), const Spacer(), ?more, const SizedBox(width: 8)]),
          ),
        Padding(
          padding: EdgeInsets.only(left: 16, right: back ? 16 : 8),
          child: Row(children: [
            if (s != null) ...[StatusBadge(statusOf(s, news), compacting: s.compacting), const SizedBox(width: 8)],
            Expanded(child: Text(s == null ? 'Session ended' : title(s), style: look.text(size: 18, weight: FontWeight.w600, spacing: -0.2), maxLines: 1, overflow: TextOverflow.ellipsis)),
            if (s != null && spend != null) ...[
              const SizedBox(width: 8),
              Semantics(
                label: 'Context used · cost so far: $spend',
                excludeSemantics: true,
                child: Text(spend!, style: look.text(size: 13, color: look.ink3, spacing: 0).copyWith(fontFeatures: const [FontFeature.tabularFigures()])),
              ),
            ],
            if (!back && more != null) ...[const SizedBox(width: 4), more],
          ]),
        ),
        if (s != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(56, 2, 16, 0),
            child: Text.rich(
              TextSpan(style: meta, children: [
                TextSpan(text: [where(s), s.cwd].where((x) => x.isNotEmpty).join(' · ')),
                if (model != null) ...[const TextSpan(text: ' · '), TextSpan(text: model, style: meta.copyWith(color: look.ink, fontWeight: FontWeight.w600))],
                if (s.thinking != null) TextSpan(text: ' · ${s.thinking}'),
              ]),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
      ]),
    );
  }
}

// A line under the header: what an action answered, or why it failed, in
// Markdown; dismissed by its ×.
class _Notice extends StatelessWidget {
  const _Notice(this.notice, {required this.dismiss});
  final ({String text, bool bad}) notice;
  final VoidCallback dismiss;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final ink = notice.bad ? look.block : look.ink2;
    return Semantics(
      liveRegion: true,
      child: Container(
        decoration: BoxDecoration(color: notice.bad ? look.blockWash : look.wash, border: Border(bottom: BorderSide(color: look.rule, width: 0.5))),
        padding: const EdgeInsets.fromLTRB(20, 6, 8, 6),
        child: Row(children: [
          Expanded(child: NoticeText(notice.text, color: ink)),
          Semantics(
            container: true,
            button: true,
            label: 'Dismiss',
            excludeSemantics: true,
            onTap: dismiss,
            child: CupertinoButton(padding: EdgeInsets.zero, minimumSize: const Size(44, 44), onPressed: dismiss, child: Icon(CupertinoIcons.xmark, size: 16, color: ink)),
          ),
        ]),
      ),
    );
  }
}

// Back to the list, "‹ Sessions"; the edge swipe works too, but is not
// enough alone.
class _Back extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return CupertinoButton(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      minimumSize: const Size(44, 44),
      onPressed: () => Navigator.of(context).maybePop(),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(CupertinoIcons.chevron_back, size: 22, color: look.accent),
        Text('Sessions', style: look.text(color: look.accent)),
      ]),
    );
  }
}

// A line between messages.
class _Note extends StatelessWidget {
  const _Note(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Text(text, textAlign: TextAlign.center, style: look.text(size: 13, color: look.ink2, spacing: 0));
  }
}

// Grey lines where the conversation will be, while its history loads.
class _Loading extends StatelessWidget {
  const _Loading();

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    Widget line(double w) => FractionallySizedBox(
          alignment: Alignment.centerLeft,
          widthFactor: w,
          child: Container(height: 12, decoration: BoxDecoration(color: look.wash, borderRadius: BorderRadius.circular(3))),
        );
    return Semantics(
      label: 'Loading the conversation',
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 12, children: [
        Align(alignment: Alignment.centerRight, child: FractionallySizedBox(widthFactor: 0.55, child: Container(height: 36, decoration: BoxDecoration(color: look.wash, borderRadius: BorderRadius.circular(18))))),
        for (final w in [0.92, 0.97, 0.88, 0.6]) line(w),
        Container(height: 80, decoration: BoxDecoration(color: look.wash, borderRadius: BorderRadius.circular(12))),
        for (final w in [0.94, 0.7]) line(w),
        const _Note('Loading the conversation'),
      ]),
    );
  }
}

// The user's message, on the right, in the accent: faded while unsent,
// ringed in red when it was not. Tapped, it offers going back or a fork.
class _Bubble extends StatelessWidget {
  const _Bubble({required this.text, this.images = const [], this.faded = false, this.refused = false, this.offer});
  final String text;
  // Each image's data; null for one that came without it.
  final List<Uint8List?> images;
  final bool faded;
  final bool refused;
  final VoidCallback? offer;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final bubble = ConstrainedBox(
      constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.82),
      child: Opacity(
        opacity: faded ? 0.5 : 1,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
          decoration: BoxDecoration(
            color: refused ? look.blockWash : look.accent,
            border: refused ? Border.all(color: look.block) : null,
            borderRadius: const BorderRadius.only(topLeft: Radius.circular(20), topRight: Radius.circular(20), bottomLeft: Radius.circular(20), bottomRight: Radius.circular(6)),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            if (images.isNotEmpty) Padding(padding: EdgeInsets.only(bottom: text.isEmpty ? 0 : 6), child: Thumbs(images: images)),
            if (text.isNotEmpty)
              // Selected, lighter on the accent: the system's own tint is
              // the accent's.
              DefaultSelectionStyle(
                selectionColor: refused ? null : look.onAccent.withValues(alpha: 0.4),
                child: Text(text, style: look.text(size: 16, height: 1.375, color: refused ? look.ink : look.onAccent, spacing: 0)),
              ),
          ]),
        ),
      ),
    );
    return Align(
      alignment: Alignment.centerRight,
      child: offer == null
          ? Selectable(child: bubble)
          : Semantics(button: true, hint: 'Go back or fork from here', child: Selectable(onTap: offer, child: bubble)),
    );
  }
}

// pi is working, and nothing in the chat shows it.
class _Dots extends StatelessWidget {
  const _Dots(this.label);
  final String? label;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Semantics(
      label: label ?? 'Working',
      child: Row(children: [
        for (var i = 0; i < 3; i++) Container(margin: const EdgeInsets.only(right: 6), width: 6, height: 6, decoration: BoxDecoration(color: look.ink2, shape: BoxShape.circle)),
        if (label != null) Text(label!, style: look.text(size: 14, color: look.ink2)),
      ]),
    );
  }
}

// A message sent from here that pi's chat does not show yet; one sent while
// pi asks a question waits for the answer.
class _Unsent extends StatelessWidget {
  const _Unsent(this.p, {required this.asking, required this.compacting, required this.model, required this.id, required this.edit});
  final Pending<StoredImage> p;
  final bool asking;
  final bool compacting;
  final PircModel model;
  final String id;
  final VoidCallback edit;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final trouble = p.state == 'failed' || p.state == 'lost';
    final (state, why) = switch (p.state) {
      'sending' => asking ? ('Waiting', 'pi asks something first') : ('Sending', ''),
      'sent' => ('Sent', ''),
      'queued' => compacting
          ? ('Queued', 'sends when pi finishes compacting')
          : p.delivery == 'steer'
              ? ('Steering', 'pi sends it after the current step')
              : ('Queued', 'sends when this turn ends'),
      'failed' => ('', 'Not sent: ${p.error ?? 'no answer'}'),
      _ => ('', 'Not sent: pi stopped first, and put it back in its own input box'),
    };
    Widget link(String label, VoidCallback f, {bool quiet = false}) => CupertinoButton(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          minimumSize: const Size(0, 36),
          onPressed: f,
          child: Text(label, style: look.text(size: 14, weight: quiet ? FontWeight.w400 : FontWeight.w600, color: quiet ? look.ink2 : look.ink).copyWith(decoration: TextDecoration.underline, decorationColor: look.ink3)),
        );
    return Column(crossAxisAlignment: CrossAxisAlignment.end, spacing: 6, children: [
      _Bubble(text: p.text, images: [for (final i in p.images ?? const <StoredImage>[]) i.data], faded: !trouble, refused: trouble),
      if (trouble) ...[
        Text(why, textAlign: TextAlign.right, style: look.text(size: 13.5, color: look.block, spacing: 0)),
        Row(mainAxisSize: MainAxisSize.min, children: [
          link('Retry', () => model.retry(id, p)),
          link('Edit', edit),
          link('Dismiss', () => model.dismiss(id, p), quiet: true),
        ]),
      ] else
        Row(mainAxisSize: MainAxisSize.min, children: [
          if (p.state == 'sending') ...[const CupertinoActivityIndicator(radius: 5), const SizedBox(width: 6)],
          Text.rich(TextSpan(children: [
            TextSpan(text: state, style: look.text(size: 12.5, weight: FontWeight.w500, color: look.ink3, spacing: 0)),
            if (why.isNotEmpty) TextSpan(text: ' · $why', style: look.text(size: 12.5, color: look.ink3, spacing: 0)),
          ])),
        ]),
    ]);
  }
}

// A reply: its thoughts folded under "Thinking", its text in Markdown, a
// cursor while it streams (after its last word, or under its thoughts),
// and Copy once it ends its turn.
class _Reply extends StatelessWidget {
  const _Reply(this.item);
  final AssistantItem item;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final text = item.blocks.where((b) => b.kind == 'text' && b.text.isNotEmpty).map((b) => b.text).join('\n\n');
    final done = !item.streaming && (item.stop == 'stop' || item.stop == 'length') && text.trim().isNotEmpty;
    final last = item.blocks.lastOrNull;
    final writing = item.streaming && last != null && last.kind == 'text' && last.text.trim().isNotEmpty;
    final parts = <Widget>[
      for (final b in item.blocks)
        if (b.text.trim().isNotEmpty) b.kind == 'thinking' ? _Thinking(b.text.trim()) : Markdown(b.text, writing: writing && identical(b, last)),
      if (item.streaming && !writing) const Cursor(),
      if (item.stop == 'error') Text('⚠ The model failed: ${item.error ?? 'no reason given'}', style: look.text(size: 14, color: look.block)),
      if (item.stop == 'aborted') const _Note('Stopped'),
    ];
    if (parts.isEmpty) return const SizedBox.shrink();
    return Selectable(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, spacing: 12, children: [
        ...parts,
        if (done) Transform.translate(offset: const Offset(-6, -8), child: CopyButton(text: text, label: 'Copy reply')),
      ]),
    );
  }
}

// pi's thoughts, on a grey pill that opens to them.
class _Thinking extends StatefulWidget {
  const _Thinking(this.text);
  final String text;

  @override
  State<_Thinking> createState() => _ThinkingState();
}

class _ThinkingState extends State<_Thinking> {
  var _open = false;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      GestureDetector(
        onTap: () {
          const _Unfolding().dispatch(context);
          setState(() => _open = !_open);
        },
        // The pill is a control, not text: the reply around it selects.
        child: SelectionContainer.disabled(
          child: Container(
            height: 30,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            decoration: BoxDecoration(color: look.wash, borderRadius: BorderRadius.circular(15)),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Text('Thinking', style: look.text(size: 14, weight: FontWeight.w500, color: look.ink3, spacing: 0)),
              const SizedBox(width: 6),
              AnimatedRotation(turns: _open ? 0.25 : 0, duration: const Duration(milliseconds: 150), child: Icon(CupertinoIcons.chevron_forward, size: 12, color: look.ink3)),
            ]),
          ),
        ),
      ),
      if (_open)
        Container(
          margin: const EdgeInsets.only(top: 10),
          padding: const EdgeInsets.only(left: 12),
          decoration: BoxDecoration(border: Border(left: BorderSide(color: look.wash2, width: 2))),
          child: Text(widget.text, style: look.text(size: 14, height: 1.6, color: look.ink2, style: FontStyle.italic, spacing: 0)),
        ),
    ]);
  }
}

// A summary pi wrote, folded under a line.
class _Summary extends StatefulWidget {
  const _Summary(this.label, this.text);
  final String label;
  final String text;

  @override
  State<_Summary> createState() => _SummaryState();
}

class _SummaryState extends State<_Summary> {
  var _open = false;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return GestureDetector(
      onTap: () {
        const _Unfolding().dispatch(context);
        setState(() => _open = !_open);
      },
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _Note(widget.label),
        if (_open)
          Container(
            margin: const EdgeInsets.only(top: 8),
            padding: const EdgeInsets.only(left: 14),
            decoration: BoxDecoration(border: Border(left: BorderSide(color: look.rule))),
            child: Selectable(
              onTap: () {
                const _Unfolding().dispatch(context);
                setState(() => _open = false);
              },
              child: Text(widget.text, style: look.text(size: 15, height: 1.6, color: look.ink2, style: FontStyle.italic, spacing: 0)),
            ),
          ),
      ]),
    );
  }
}

// What a tool call shows on its line: the command, the path, the pattern.
String toolSummary(ToolItem t) {
  try {
    final args = jsonDecode(t.args);
    if (args is Map) {
      for (final k in const ['command', 'path', 'file_path', 'pattern', 'url']) {
        final v = args[k];
        if (v is String) return v;
      }
      return args.values.whereType<String>().firstOrNull ?? '';
    }
  } on FormatException {
    return t.args;
  }
  return '';
}

// A tool call's arguments as lines of name and value, the names lined up;
// anything nested, as indented JSON.
String argLines(ToolItem t) {
  try {
    final a = jsonDecode(t.args);
    if (a is! Map || a.values.any((v) => v is Map || v is List)) return const JsonEncoder.withIndent('  ').convert(a);
    final width = a.keys.fold(0, (n, k) => '$k'.length > n ? '$k'.length : n);
    return [for (final MapEntry(:key, :value) in a.entries) '${'$key'.padRight(width)}  $value'].join('\n');
  } on FormatException {
    return t.args;
  }
}

// A tool's time shows once it is a second or more.
const _shownMs = 1000;

// ✕ failed, ● running, ✓ finished: drawn, as the status badges are.
class _Mark extends StatelessWidget {
  const _Mark(this.kind);
  final String kind;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final color = switch (kind) { 'failed' => look.block, 'running' => look.work, _ => look.done };
    return SizedBox(width: 14, height: 14, child: CustomPaint(painter: _MarkPainter(kind, color)));
  }
}

class _MarkPainter extends CustomPainter {
  _MarkPainter(this.kind, this.color);
  final String kind;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final r = size.shortestSide * 0.32;
    final line = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.6
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    switch (kind) {
      case 'failed':
        canvas.drawLine(c + Offset(-r, -r), c + Offset(r, r), line);
        canvas.drawLine(c + Offset(r, -r), c + Offset(-r, r), line);
      case 'running':
        canvas.drawCircle(c, r * 0.9, Paint()..color = color);
      default:
        canvas.drawPath(Path()..moveTo(c.dx - r, c.dy)..lineTo(c.dx - r * 0.3, c.dy + r * 0.7)..lineTo(c.dx + r, c.dy - r * 0.75), line);
    }
  }

  @override
  bool shouldRepaint(_MarkPainter old) => old.kind != kind || old.color != color;
}

// A tool call on the grouped grey: its line opens to its arguments and
// output, and is open while it runs and shows output. An edit shows its
// changes.
class _Tool extends StatefulWidget {
  const _Tool(this.t, {required this.now});
  final ToolItem t;
  // The host's clock, for how long a running tool has run.
  final int Function() now;

  @override
  State<_Tool> createState() => _ToolState();
}

class _ToolState extends State<_Tool> {
  bool? _open;
  Timer? _tick;

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final t = widget.t;
    final r = t.result;
    final running = r == null;
    if (running && _tick == null) {
      _tick = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
    } else if (!running) {
      _tick?.cancel();
      _tick = null;
    }
    final open = _open ?? (running && (t.progress ?? '').isNotEmpty);
    final out = r?.text ?? t.progress ?? '';
    final diff = r?.diff != null && !r!.isError ? r.diff : null;
    final ms = running ? widget.now() - t.at : r.durationMs;
    final label = look.text(size: 10.5, weight: FontWeight.w600, color: look.ink3, spacing: 1.5);
    // A heading over what is copied, not part of it.
    Widget heading(String text) => SelectionContainer.disabled(child: Text(text, style: label));
    final pre = look.mono(size: 12.5, color: look.ink2).copyWith(height: 1.55);
    Widget block(Widget child) => ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 384),
          child: SingleChildScrollView(child: SingleChildScrollView(scrollDirection: Axis.horizontal, child: Lines(child: child))),
        );
    return Container(
      decoration: BoxDecoration(color: look.page, borderRadius: BorderRadius.circular(12), border: r?.isError == true ? Border.all(color: look.block) : null),
      clipBehavior: Clip.antiAlias,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () {
            const _Unfolding().dispatch(context);
            setState(() => _open = !open);
          },
          child: Container(
            constraints: const BoxConstraints(minHeight: 40),
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Row(children: [
              _Mark(r?.isError == true ? 'failed' : running ? 'running' : 'done'),
              const SizedBox(width: 8),
              Text(t.name.isEmpty ? 'tool' : t.name, style: look.text(size: 14, weight: FontWeight.w600, spacing: 0)),
              const SizedBox(width: 8),
              Expanded(child: Text(toolSummary(t).split('\n').first, style: look.mono(size: 12.5, color: look.ink2), maxLines: 1, overflow: TextOverflow.ellipsis)),
              if (r?.exitCode != null && r!.exitCode != 0) ...[const SizedBox(width: 8), Text('exit ${r.exitCode}', style: look.mono(size: 12.5, color: look.block, weight: FontWeight.w600))],
              if (ms != null && ms >= _shownMs) ...[const SizedBox(width: 8), Text(took(ms), style: look.mono(size: 12.5, color: look.ink3))],
            ]),
          ),
        ),
        if (open)
          Selectable(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, spacing: 6, children: [
                if (diff != null) ...[
                  heading('CHANGES'),
                  block(Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    for (final l in diffLines(diff))
                      Container(
                        color: switch (l.kind) { 'add' => look.doneWash, 'del' => look.blockWash, _ => null },
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        child: Text(l.text.isEmpty ? ' ' : l.text,
                            style: pre.copyWith(color: switch (l.kind) { 'add' => look.done, 'del' => look.block, 'hunk' => look.ink3, _ => look.ink2 }), softWrap: false),
                      ),
                  ])),
                ] else ...[
                  heading('ARGUMENTS'),
                  block(Text(argLines(t), style: pre, softWrap: false)),
                  if (out.isNotEmpty) ...[
                    heading(running ? 'OUTPUT SO FAR' : 'OUTPUT'),
                    block(Text(out.length > 20000 ? '${out.substring(0, 20000)}\n…' : out, style: r?.isError == true ? pre.copyWith(color: look.block) : pre, softWrap: false)),
                  ],
                ],
              ]),
            ),
          ),
      ]),
    );
  }
}

// Tool calls one after another, all finished well: one line, "✓ 3 tools
// grep, read, edit", that opens to them.
class _Folded extends StatefulWidget {
  const _Folded(this.tools, {required this.now});
  final List<ToolItem> tools;
  final int Function() now;

  @override
  State<_Folded> createState() => _FoldedState();
}

class _FoldedState extends State<_Folded> {
  var _open = false;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final style = look.text(size: 13, color: look.ink3, spacing: 0);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 6, children: [
      GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () {
          const _Unfolding().dispatch(context);
          setState(() => _open = !_open);
        },
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 30),
          child: Row(children: [
            const _Mark('done'),
            const SizedBox(width: 6),
            Flexible(child: Text('${widget.tools.length} tools ${widget.tools.map((t) => t.name.isEmpty ? 'tool' : t.name).join(', ')}', style: style, maxLines: 1, overflow: TextOverflow.ellipsis)),
            const SizedBox(width: 6),
            AnimatedRotation(turns: _open ? 0.25 : 0, duration: const Duration(milliseconds: 150), child: Icon(CupertinoIcons.chevron_forward, size: 12, color: look.ink3)),
          ]),
        ),
      ),
      if (_open) for (final t in widget.tools) _Tool(t, now: widget.now),
    ]);
  }
}

// One of pi's dialogs, above the composer: a select's options, a confirm's
// yes and no, an input's box, each with Dismiss; an editor or a custom
// dialog only said to be waiting in pi's terminal.
class _Ask extends StatefulWidget {
  const _Ask(this.q, {super.key, required this.more, required this.model, required this.id});
  final QuestionView q;
  final int more;
  final PircModel model;
  final String id;

  @override
  State<_Ask> createState() => _AskState();
}

class _AskState extends State<_Ask> {
  final _text = TextEditingController();
  var _sending = false;
  String? _error;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _answer({int? option, bool? confirmed, String? text, bool dismissed = false}) async {
    setState(() => _sending = true);
    final o = await widget.model.answer(widget.id, widget.q.id, option: option, confirmed: confirmed, text: text, dismissed: dismissed);
    if (mounted) {
      setState(() {
        _sending = false;
        _error = o.ok ? null : o.message;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final q = widget.q;
    final lines = q.title.split('\n');
    final rest = [...lines.skip(1), ...?q.message?.split('\n')];
    Widget choice(String label, VoidCallback f, {bool primary = false, bool left = false}) => CupertinoButton(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          minimumSize: const Size(0, 44),
          color: primary ? look.accent : look.card,
          borderRadius: BorderRadius.circular(12),
          onPressed: _sending ? null : f,
          child: Align(
            alignment: left ? Alignment.centerLeft : Alignment.center,
            widthFactor: left ? null : 1,
            child: Text(label, style: look.text(size: 15, weight: left ? FontWeight.w500 : FontWeight.w600, color: primary ? look.onAccent : look.ink, spacing: 0)),
          ),
        );
    return Semantics(
      label: 'pi asks',
      container: true,
      child: Container(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
        decoration: BoxDecoration(color: look.blockWash, borderRadius: BorderRadius.circular(16)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, spacing: 10, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Padding(padding: const EdgeInsets.only(top: 3), child: const _Mark('failed')),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                // The question; the app's own words under it are not.
                Selectable(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(lines.first.isNotEmpty ? lines.first : (q.answerable ? 'pi asks' : "A dialog in pi's terminal"), style: look.text(size: 15, weight: FontWeight.w600, spacing: 0)),
                    for (final l in rest) Text(l, style: look.text(size: 14.5, color: look.ink2, spacing: 0)),
                  ]),
                ),
                if (!q.answerable) Text("Waiting in pi's terminal; it can be answered only there.", style: look.text(size: 13.5, color: look.ink3, spacing: 0)),
                if (widget.more > 0) Text('${widget.more} more after this one', style: look.text(size: 13.5, color: look.ink3, spacing: 0)),
              ]),
            ),
          ]),
          if (q.answerable && q.kind == 'select')
            Column(crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 8, children: [
              for (final (i, o) in (q.options ?? const <String>[]).indexed) choice(o, () => _answer(option: i), left: true),
            ]),
          if (q.answerable && q.kind == 'confirm')
            Row(spacing: 8, children: [choice('Yes', () => _answer(confirmed: true), primary: true), choice('No', () => _answer(confirmed: false))]),
          if (q.answerable && q.kind == 'input')
            Row(spacing: 8, children: [
              Expanded(
                child: CupertinoTextField(
                  controller: _text,
                  placeholder: q.placeholder,
                  style: look.text(size: 15),
                  placeholderStyle: look.text(size: 15, color: look.ink3),
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
                  decoration: BoxDecoration(color: look.card, borderRadius: BorderRadius.circular(12), border: Border.all(color: look.rule)),
                  onSubmitted: (v) => _answer(text: v),
                ),
              ),
              choice('Send', () => _answer(text: _text.text), primary: true),
            ]),
          if (q.answerable)
            CupertinoButton(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              minimumSize: const Size(0, 32),
              onPressed: _sending ? null : () => _answer(dismissed: true),
              child: Text('Dismiss', style: look.text(size: 14, color: look.ink2, spacing: 0)),
            ),
          if (_error != null) Text(_error!, style: look.text(size: 13.5, color: look.block, spacing: 0)),
        ]),
      ),
    );
  }
}

// How long the turn has run, by the host's clock: "Working · 2m 05s", the
// time alone on a phone's width. Ticks each second.
class _TurnTime extends StatefulWidget {
  const _TurnTime({required this.model, required this.id, required this.compacting});
  final PircModel model;
  final String id;
  final bool compacting;

  @override
  State<_TurnTime> createState() => _TurnTimeState();
}

class _TurnTimeState extends State<_TurnTime> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final start = widget.model.turnStart(widget.id);
    final s = start == null ? -1 : (widget.model.now() - start) ~/ 1000;
    final elapsed = s < 0 || s > 24 * 3600 ? null : s >= 60 ? '${s ~/ 60}m ${'${s % 60}'.padLeft(2, '0')}s' : '${s}s';
    final narrow = MediaQuery.sizeOf(context).width < 384;
    final word = widget.compacting ? 'Compacting' : 'Working';
    return Text(
      elapsed == null ? word : narrow && !widget.compacting ? elapsed : '$word · $elapsed',
      style: look.text(size: 13.5, color: look.ink2, spacing: 0).copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
    );
  }
}

// The composer. Idle, the message and a round send. While pi works, on its
// own line: how long, the switch choosing whether the message waits for the
// turn to end (Queue, the default) or interrupts it (Steer), and Stop; the
// send button says which.
class _Composer extends StatefulWidget {
  const _Composer({required this.model, required this.session, required this.text, required this.images, this.wide = false});
  // Beside the list: in the conversation's column.
  final bool wide;
  final PircModel model;
  final SessionView session;
  final TextEditingController text;
  final ValueNotifier<List<StoredImage>> images;

  @override
  State<_Composer> createState() => _ComposerState();
}

class _ComposerState extends State<_Composer> {
  // Each turn starts on Queue.
  var _steer = false;
  var _wasWorking = false;
  // Why an image could not be added.
  String? _problem;
  // Whether the session's model is known not to take images, asked of pi
  // once images are attached, and again when the model changes.
  bool _blind = false;
  String? _askedFor;

  @override
  void initState() {
    super.initState();
    widget.text.addListener(_changed);
    widget.images.addListener(_changed);
  }

  @override
  void dispose() {
    widget.text.removeListener(_changed);
    widget.images.removeListener(_changed);
    super.dispose();
  }

  void _changed() => setState(() {});

  // Where the image comes from, as the web's file input asks on a phone.
  Future<void> _add() async {
    final room = imagesMax - widget.images.value.length;
    if (room <= 0) return;
    final camera = await showSheet<bool>(
      context,
      (context) => Sheet(title: 'Add an image', done: 'Cancel', children: [
        SheetGroup(children: [
          SheetRow(label: 'Take a photo', onTap: () => Navigator.of(context).pop(true)),
          SheetRow(label: 'Choose from your photos', onTap: () => Navigator.of(context).pop(false)),
        ]),
      ]),
    );
    if (camera == null || !mounted) return;
    setState(() => _problem = null);
    try {
      final r = camera ? await takePhoto() : await pickImages(room);
      if (!mounted) return;
      widget.images.value = [...widget.images.value, ...r.images].take(imagesMax).toList();
      if (r.problem != null) setState(() => _problem = r.problem);
    } on Object catch (e) {
      if (mounted) setState(() => _problem = '${camera ? 'The camera' : 'The photos'} could not be opened: $e');
    }
  }

  void _askBlind(SessionView s) {
    final m = s.model;
    final model = m == null ? null : '${m.provider}/${m.id}';
    if (widget.images.value.isEmpty || model == null || model == _askedFor) return;
    _askedFor = model;
    // Quietly: unknown is not blind.
    widget.model.act(s.id, (r) => SessionMessage(listModels: ListModels(requestId: r))).then((o) {
      if (!mounted || _askedFor != model || !o.ok || o.result?['kind'] != 'models') return;
      final mine = (o.result!['models'] as List).cast<Json>().where((c) => '${(c['model'] as Json)['provider']}/${(c['model'] as Json)['id']}' == model).firstOrNull;
      setState(() => _blind = mine != null && mine['images'] == false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final s = widget.session;
    final busy = s.working || s.compacting;
    if (busy != _wasWorking) {
      _wasWorking = busy;
      _steer = false;
    }
    final images = widget.images.value;
    final empty = widget.text.text.trim().isEmpty && images.isEmpty;
    _askBlind(s);
    void send() {
      if (empty) return;
      final text = widget.text.text;
      widget.text.clear();
      widget.images.value = const [];
      setState(() => _problem = null);
      widget.model.prompt(s.id, text, images: images, delivery: busy ? (_steer ? 'steer' : 'followUp') : null);
    }

    final questions = s.questions ?? const <QuestionView>[];
    return LayoutBuilder(
      builder: (context, c) => Container(
        decoration: BoxDecoration(color: look.page, border: Border(top: BorderSide(color: look.rule, width: 0.5))),
        padding: EdgeInsets.fromLTRB(widget.wide ? math.max(12, (c.maxWidth - 640) / 2) : 12, 10, widget.wide ? math.max(12, (c.maxWidth - 640) / 2) : 12, 10 + MediaQuery.paddingOf(context).bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, spacing: 10, children: [
          if (questions.isNotEmpty) _Ask(questions.first, key: ValueKey(questions.first.id), more: questions.length - 1, model: widget.model, id: s.id),
          if (busy)
            Row(children: [
              StatusGlyph(Status.working, size: 9),
              const SizedBox(width: 10),
              _TurnTime(model: widget.model, id: s.id, compacting: s.compacting),
              const Spacer(),
              _Switch(steer: _steer, set: (v) => setState(() => _steer = v)),
              const SizedBox(width: 6),
              CupertinoButton(
                padding: const EdgeInsets.symmetric(horizontal: 14),
                minimumSize: const Size(0, 36),
                color: look.blockWash,
                borderRadius: BorderRadius.circular(12),
                onPressed: () => widget.model.stop(s.id),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Container(width: 9, height: 9, decoration: BoxDecoration(color: look.block, borderRadius: BorderRadius.circular(1.5))),
                  const SizedBox(width: 8),
                  Text('Stop', style: look.text(size: 14, weight: FontWeight.w600, color: look.block, spacing: 0)),
                ]),
              ),
            ]),
          if (images.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8, right: 8),
              child: Align(alignment: Alignment.centerLeft, child: Thumbs(images: [for (final i in images) i.data], onRemove: (i) => widget.images.value = [...images]..removeAt(i))),
            ),
          if (_problem != null || (images.isNotEmpty && _blind))
            Semantics(
              liveRegion: true,
              child: Text(_problem ?? 'The current model does not take images; pi will leave them out or the model will refuse them.', style: look.text(size: 13.5, color: look.block, spacing: 0)),
            ),
          Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Semantics(
              button: true,
              label: 'Add an image',
              excludeSemantics: true,
              enabled: images.length < imagesMax,
              onTap: images.length >= imagesMax ? null : _add,
              child: CupertinoButton(
                padding: EdgeInsets.zero,
                minimumSize: const Size(38, 38),
                onPressed: images.length >= imagesMax ? null : _add,
                child: Icon(CupertinoIcons.photo, size: 24, color: images.length >= imagesMax ? look.ink3 : look.ink2),
              ),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: CupertinoTextField(
                controller: widget.text,
                placeholder: busy ? 'Steer, or queue a follow-up' : 'Message',
                placeholderStyle: look.text(size: 16, color: look.ink3, spacing: 0),
                style: look.text(size: 16, height: 1.35, spacing: 0),
                minLines: 1,
                maxLines: 6,
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                decoration: BoxDecoration(color: look.card, borderRadius: BorderRadius.circular(19), border: Border.all(color: look.rule)),
              ),
            ),
            const SizedBox(width: 10),
            Semantics(
              key: const ValueKey('send'),
              button: true,
              label: busy ? (_steer ? 'Steer' : 'Queue') : 'Send',
              enabled: !empty,
              child: GestureDetector(
                onTap: empty ? null : send,
                child: Container(
                  height: 38,
                  width: busy ? null : 38,
                  padding: busy ? const EdgeInsets.symmetric(horizontal: 18) : null,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(color: empty ? look.wash2 : look.accent, borderRadius: BorderRadius.circular(busy ? 12 : 19)),
                  child: busy
                      ? Text(_steer ? 'Steer' : 'Queue', style: look.text(size: 15, weight: FontWeight.w600, color: empty ? look.ink3 : look.onAccent, spacing: 0))
                      : Icon(CupertinoIcons.arrow_up, size: 20, color: empty ? look.ink3 : look.onAccent),
                ),
              ),
            ),
          ]),
        ]),
      ),
    );
  }
}

// Queue or Steer: a small switch that sends nothing.
class _Switch extends StatelessWidget {
  const _Switch({required this.steer, required this.set});
  final bool steer;
  final void Function(bool) set;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    Widget side(String label, bool value) => Semantics(
          button: true,
          selected: steer == value,
          label: label,
          excludeSemantics: true,
          onTap: () => set(value),
          child: GestureDetector(
            onTap: () => set(value),
            child: Container(
              height: 28,
              padding: const EdgeInsets.symmetric(horizontal: 10),
              alignment: Alignment.center,
              decoration: steer == value ? BoxDecoration(color: look.sheetCard, borderRadius: BorderRadius.circular(7), boxShadow: const [BoxShadow(color: Color(0x14000000), blurRadius: 2, offset: Offset(0, 1))]) : null,
              child: Text(label, style: look.text(size: 12.5, weight: steer == value ? FontWeight.w600 : FontWeight.w400, color: steer == value ? look.ink : look.ink2, spacing: 0)),
            ),
          ),
        );
    return Container(
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(color: look.wash, borderRadius: BorderRadius.circular(9)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [side('Queue', false), side('Steer', true)]),
    );
  }
}
