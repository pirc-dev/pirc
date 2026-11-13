// The screens, drawn from a model fed real relay frames, in light and dark,
// compared with saved images (test/goldens). The images are drawn on macOS
// with the Roboto Flutter ships; elsewhere text draws differently, so they
// are skipped there, and in CI, saying so. flutter test --update-goldens
// draws them again.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:fixnum/fixnum.dart';
import 'package:flutter/cupertino.dart' hide Image;
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart' show DefaultMaterialLocalizations, LicensePage;
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker_platform_interface/image_picker_platform_interface.dart';

import 'package:pirc/app/app.dart';
import 'package:pirc/app/drafts.dart';
import 'package:pirc/app/files.dart';
import 'package:pirc/app/model.dart';
import 'package:pirc/app/outside.dart';
import 'package:pirc/app/settings.dart';
import 'package:pirc/app/store.dart';
import 'package:pirc/core/protocol.dart';
import 'package:pirc/core/view.dart';
import 'package:pirc/join.dart';
import 'package:pirc/keys/key_holder.dart';
import 'package:pirc/app/links.dart';
import 'package:pirc/keys/key_store.dart';
import 'package:pirc/push/push.dart';
import 'package:pirc/ui/chat_screen.dart';
import 'package:pirc/ui/join_screen.dart';
import 'package:pirc/ui/lock_screen.dart';
import 'package:pirc/ui/scan_screen.dart';
import 'package:pirc/ui/selectable.dart';
import 'package:pirc/ui/devices.dart';
import 'package:pirc/ui/hosts.dart';
import 'package:pirc/ui/images.dart';
import 'package:pirc/ui/invite.dart';
import 'package:pirc/ui/launch.dart';
import 'package:pirc/ui/look.dart';
import 'package:pirc/ui/markdown.dart';
import 'package:pirc/ui/paywall_screen.dart';
import 'package:pirc/ui/sessions_screen.dart';
import 'package:pirc/ui/settings_screen.dart';
import 'package:pirc/ui/sheet.dart';

const font = 'Roboto';
// Code and tool output: SF Mono, the web page's ui-monospace on Apple's,
// from macOS, where the goldens are drawn.
const mono = 'Mono';
// Not in CI either: GitHub's Macs draw them differently (2026-11-11, macOS
// 15 runners: about 3% of each image's pixels).
const goldensSkip = 'skipped: golden images are drawn on macOS, outside CI';
final drawsGoldens = Platform.isMacOS && Platform.environment['CI'] != 'true';

// Roboto from Flutter's own cache, and the fonts the app bundles
// (CupertinoIcons), so that text and icons draw as they will.
Future<void> loadFonts() async {
  final cache = File(Platform.resolvedExecutable).parent.parent.parent.parent.path; // .../bin/cache
  final roboto = FontLoader(font);
  for (final w in ['Regular', 'Medium', 'Bold', 'Italic']) {
    final f = File('$cache/artifacts/material_fonts/Roboto-$w.ttf');
    if (f.existsSync()) roboto.addFont(Future.value(ByteData.sublistView(f.readAsBytesSync())));
  }
  await roboto.load();
  final sfMono = File('/System/Library/Fonts/SFNSMono.ttf');
  if (sfMono.existsSync()) await (FontLoader(mono)..addFont(Future.value(ByteData.sublistView(sfMono.readAsBytesSync())))).load();
  final icons = FontLoader('packages/cupertino_icons/CupertinoIcons');
  icons.addFont(rootBundle.load('packages/cupertino_icons/assets/CupertinoIcons.ttf'));
  await icons.load();
}

const now = 1793700000000;
final hostKey = List<int>.filled(32, 1);
Timestamp ts(int ms) => Timestamp(seconds: Int64(ms ~/ 1000), nanos: (ms % 1000) * 1000000);

SessionEntry entry(String instance, String host, SessionAnnouncement a) => SessionEntry(
      session: SessionRef(hostKey: host == 'server' ? List.filled(32, 2) : hostKey, sessionId: 's-$instance', instanceId: instance),
      hostLabel: host,
      payload: a.writeToBuffer(),
    );

ConversationItem user(String text, int at, {String entry = ''}) =>
    ConversationItem(entryId: entry, turnId: 't', at: ts(at), userMessage: UserMessage(text: text));
ConversationItem reply(String id, List<ContentBlock> blocks, int at) =>
    ConversationItem(turnId: 't', at: ts(at), assistantMessage: AssistantMessage(messageId: id, content: blocks, stopReason: StopReason.STOP_REASON_STOP));
ConversationItem call(String id, String name, String args, int at) =>
    ConversationItem(turnId: 't', at: ts(at), toolCall: ToolCall(toolCallId: id, toolName: name, argumentsJson: args));
ConversationItem result(String id, int at, {bool error = false, String text = ''}) =>
    ConversationItem(turnId: 't', at: ts(at), toolResult: ToolResult(toolCallId: id, isError: error, text: text, durationMs: 1200));

// A reply with most of what Markdown has, as pi's replies use it.
const markdownReply = '''## Done: the docs say 0.2

The **install page** and the *changelog* now name `0.2`; see [the release](https://example.com).

1. bumped the version in `package.json`;
2. regenerated the API pages.

```ts src/version.ts
// the one place it is written
export const version = "0.2.0";
export const major = () => Number(version.split(".")[0]);
```

| Page | Before | After |
|---|---|---|
| install | 0.1.4 | 0.2.0 |
| changelog | — | 0.2 entry |

> The README still says 0.1 in one example.''';

// A model with four sessions on two hosts, the first with a chat.
// The frames the model sent, from the last fixture.
var sent = <Frame>[];

Future<PircModel> fixture(WidgetTester tester) async {
  sent = [];
  var n = 0;
  late final PircModel model;
  model = PircModel(
    send: (f) {
      // pi's figures, as the gallery's, answered at once and not kept.
      final req = f.hasRouted() ? SessionMessage.fromBuffer(f.routed.payload) : null;
      if (req != null && req.hasStatsRequest()) {
        final answer = SessionMessage(stats: Stats(
          requestId: req.statsRequest.requestId,
          total: Usage(cost: 1.84, inputTokens: Int64(48210), outputTokens: Int64(9302), cacheReadTokens: Int64(310455)),
          contextTokens: Int64(122000),
          contextWindow: Int64(200000),
        ));
        scheduleMicrotask(() => model.client.onFrame(Frame(routed: Routed(session: f.routed.session, payload: answer.writeToBuffer()))));
        return true;
      }
      if (req != null && req.hasListModels()) {
        ModelInfo info(String provider, String id, String name, int window, {bool reasoning = true, bool images = false}) =>
            ModelInfo(model: Model(provider: provider, id: id, name: name), reasoning: reasoning, contextWindow: Int64(window), images: images);
        final answer = SessionMessage(models: Models(requestId: req.listModels.requestId, models: [
          info('anthropic', 'claude-sonnet-5-5', 'Sonnet 5.5', 1000000, images: true),
          info('anthropic', 'claude-opus-5-5', 'Opus 5.5', 1000000, images: true),
          info('openai', 'gpt-6', 'GPT-6', 400000),
          info('anthropic', 'claude-haiku-5-5', 'Haiku 5.5', 200000, reasoning: false),
        ]));
        scheduleMicrotask(() => model.client.onFrame(Frame(routed: Routed(session: f.routed.session, payload: answer.writeToBuffer()))));
        return true;
      }
      sent.add(f);
      return true;
    },
    newId: () => 'id-${++n}',
    now: () => now,
  );
  final c = model.client;
  c.onState(const RelayView(state: 'ready'));
  final m = 60 * 1000;
  c.onFrame(Frame(sessionList: SessionList(sessions: [
    entry('i1', 'laptop', SessionAnnouncement(name: 'release', cwd: '/home/me/src/pirc', hostname: 'laptop.local', working: true, launcher: 'tmux',
        place: Place(kind: 'tmux', group: 'work', window: 'pirc'), cost: 1.84, contextTokens: Int64(122000), contextWindow: Int64(200000))),
    entry('i2', 'laptop', SessionAnnouncement(cwd: '/home/me/src/api', firstPrompt: 'fix the flaky tests', hostname: 'laptop.local', questions: [
      Question(id: 'q1', kind: QuestionKind.QUESTION_KIND_CONFIRM, title: 'Overwrite tests/fixtures.json?', message: 'It has changes not yet committed.', answerable: true, askedAt: ts(now - 2 * m)),
    ], cost: 0.004, contextTokens: Int64(150000), contextWindow: Int64(200000))),
    entry('i3', 'laptop', SessionAnnouncement(name: 'docs', cwd: '/home/me/src/site', hostname: 'laptop.local', working: true)),
    entry('i4', 'server', SessionAnnouncement(cwd: '/srv/relay', hostname: 'server', startedAt: ts(now - 3 * 24 * 60 * m))),
  ])));
  // Each session asked for its history: answer them.
  final histories = <String, List<ConversationItem>>{
    'i1': [
      user('Release 0.2: bump the version, run the checks, tag it.', now - 9 * m, entry: 'e1'),
      reply('a1', [ContentBlock(thinking: 'The version lives in package.json and the Go module.'), ContentBlock(text: "I'll bump the version first, then run the checks.")], now - 9 * m),
      call('c1', 'read', '{"path":"package.json"}', now - 8 * m),
      result('c1', now - 8 * m),
      call('c2', 'edit', '{"path":"package.json"}', now - 8 * m),
      result('c2', now - 8 * m),
      call('c3', 'bash', '{"command":"sh/check.sh"}', now - 7 * m),
    ],
    'i2': [user('fix the flaky tests', now - 30 * m, entry: 'e2'), reply('a2', [ContentBlock(text: 'The fixture is rewritten by each run. I can regenerate it.')], now - 3 * m)],
    'i3': [user('update the docs for 0.2', now - 60 * m, entry: 'e3'), reply('a3', [ContentBlock(text: markdownReply)], now - 40 * m)],
    'i4': [],
  };
  for (final f in sent.where((f) => f.hasRouted())) {
    final req = SessionMessage.fromBuffer(f.routed.payload);
    if (!req.hasHistoryRequest()) continue;
    final items = histories[f.routed.session.instanceId]!;
    final h = SessionMessage(history: History(requestId: req.historyRequest.requestId, items: items, seq: Int64(1)));
    c.onFrame(Frame(routed: Routed(session: f.routed.session, payload: h.writeToBuffer())));
  }
  // docs finishes: news.
  c.onFrame(Frame(sessionUpdated: SessionUpdated(entry: entry('i3', 'laptop', SessionAnnouncement(name: 'docs', cwd: '/home/me/src/site', hostname: 'laptop.local', cost: 12.5, contextTokens: Int64(190000), contextWindow: Int64(200000))))));
  // The running check's output so far.
  c.onFrame(Frame(routed: Routed(
    session: SessionRef(hostKey: hostKey, sessionId: 's-i1', instanceId: 'i1'),
    payload: SessionMessage(event: SessionEvent(seq: Int64(2), at: ts(now), toolProgress: ToolProgress(toolCallId: 'c3', text: 'go vet, test\nok  pirc.dev/relay  2.1s\nunit tests'))).writeToBuffer(),
  )));
  await tester.pump();
  return model;
}

// [keyboard]: the height of one open over the screen.
Widget frame(Widget child, {Brightness brightness = Brightness.light, double keyboard = 0}) {
  final look = (brightness == Brightness.dark ? Look.dark : Look.light).withFont(font, mono: mono);
  return MediaQuery(
    data: MediaQueryData(
        size: const Size(390, 844), platformBrightness: brightness, padding: const EdgeInsets.only(top: 47, bottom: 34), viewInsets: EdgeInsets.only(bottom: keyboard)),
    child: LookScope(
      look: look,
      child: CupertinoApp(
        debugShowCheckedModeBanner: false,
        theme: CupertinoThemeData(brightness: brightness, primaryColor: look.accent, textTheme: CupertinoTextThemeData(textStyle: look.text())),
        localizationsDelegates: const [DefaultMaterialLocalizations.delegate, DefaultCupertinoLocalizations.delegate, DefaultWidgetsLocalizations.delegate],
        builder: (context, child) => LookScope(look: look, child: child!),
        home: child,
      ),
    ),
  );
}

Future<void> phone(WidgetTester tester) async {
  tester.view.physicalSize = const Size(390 * 3, 844 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

void main() {
  setUpAll(loadFonts);

  for (final b in Brightness.values) {
    testWidgets('the session list, ${b.name}', (tester) async {
      await phone(tester);
      final model = await fixture(tester);
      await tester.pumpWidget(frame(SessionsScreen(model: model, open: (_) {}, unfolded: const {'h:laptop', 'h:server', 'g:laptop/work'}, settings: () {}), brightness: b));
      await tester.pump();
      expect(find.text('release'), findsOneWidget);
      expect(find.text('pirc'), findsOneWidget, reason: 'its window, above its name');
      expect(find.text('fix the flaky tests'), findsOneWidget, reason: 'no name: its first message');
      expect(find.text('LAPTOP'), findsOneWidget);
      expect(find.text('SERVER'), findsOneWidget);
      expect(find.text('work'), findsOneWidget, reason: 'the tmux session, as a group above the sessions in none');
      await expectLater(find.byType(SessionsScreen), matchesGoldenFile('goldens/sessions_${b.name}.png'));
    }, skip: !drawsGoldens);

    testWidgets('a session list row says its cost and context use, ${b.name}', (tester) async {
      await phone(tester);
      final model = await fixture(tester);
      await tester.pumpWidget(frame(SessionsScreen(model: model, open: (_) {}, unfolded: const {'h:laptop', 'h:server', 'g:laptop/work'}, settings: () {}), brightness: b));
      await tester.pump();
      expect(find.text('\$1.84'), findsOneWidget);
      expect(find.text('<\$0.01'), findsOneWidget, reason: 'above zero and under half a cent');
      expect(find.text('\$12.50'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp(r'Context 61% used · \$1\.84 so far')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp(r'Context 95% used · \$12\.50 so far')), findsOneWidget);
      // An older extension's session has neither.
      expect(find.bySemanticsLabel(RegExp('so far')), findsNWidgets(3));
      model.client.onFrame(Frame(sessionUpdated: SessionUpdated(entry: entry('i4', 'server', SessionAnnouncement(cwd: '/srv/relay', hostname: 'server', cost: 0.2, contextWindow: Int64(200000))))));
      await tester.pump();
      expect(find.bySemanticsLabel(RegExp(r'Context unknown until the next reply · \$0\.20 so far')), findsOneWidget);
      model.client.onFrame(Frame(sessionUpdated: SessionUpdated(entry: entry('i4', 'server', SessionAnnouncement(cwd: '/srv/relay', hostname: 'server', cost: 0)))));
      await tester.pump();
      expect(find.bySemanticsLabel(RegExp(r'(^|\n)Context unknown · \$0\.00 so far')), findsOneWidget, reason: 'no model, so no window');
    });

    testWidgets('a chat while pi works, ${b.name}', (tester) async {
      await phone(tester);
      final model = await fixture(tester);
      await tester.pumpWidget(frame(ChatScreen(model: model, id: '0101010101010101-i1'), brightness: b));
      await tester.pump();
      expect(find.text('2 tools read, edit'), findsOneWidget, reason: 'two that finished well fold');
      expect(find.text('Stop'), findsOneWidget);
      expect(find.text('Steer'), findsNWidgets(2), reason: 'the switch, and the send button saying it: Steer, the default');
      await expectLater(find.byType(ChatScreen), matchesGoldenFile('goldens/chat_${b.name}.png'));
    }, skip: !drawsGoldens);
  }

  for (final b in Brightness.values) {
    testWidgets("a host's page and a group's, ${b.name}", (tester) async {
      await phone(tester);
      final model = await fixture(tester);
      final here = <String>[], top = <String>[];
      await tester.pumpWidget(frame(SessionsScreen(model: model, open: top.add, openHere: here.add, unfolded: const {'h:laptop', 'g:laptop/work'}, settings: () {}), brightness: b));
      await tester.pump();
      await tester.tap(find.bySemanticsLabel('Open laptop'));
      await tester.pumpAndSettle();
      expect(find.text('laptop'), findsOneWidget, reason: 'its title');
      expect(find.text('LAPTOP'), findsNothing, reason: 'no line of its own on its page');
      expect(find.bySemanticsLabel('Settings'), findsNothing, reason: 'only on the whole list');
      expect(find.text('Search 3 sessions on laptop'), findsOneWidget);
      expect(find.text('SERVER'), findsNothing);
      await expectLater(find.byType(CupertinoApp), matchesGoldenFile('goldens/host_${b.name}.png'));
      await tester.tap(find.bySemanticsLabel('Open work'));
      await tester.pumpAndSettle();
      expect(find.text('Search 1 session in work'), findsOneWidget);
      expect(find.bySemanticsLabel('New agent'), findsOneWidget, reason: 'its pi has a launcher');
      expect(find.text('fix the flaky tests'), findsNothing, reason: 'in no group');
      await expectLater(find.byType(CupertinoApp), matchesGoldenFile('goldens/group_${b.name}.png'));
      await tester.tap(find.text('release'));
      expect(here, ['0101010101010101-i1'], reason: 'over this page');
      expect(top, isEmpty);
      await tester.tap(find.text('laptop'));
      await tester.pumpAndSettle();
      expect(find.text('Search 3 sessions on laptop'), findsOneWidget, reason: 'back to the host');
      await tester.tap(find.text('Sessions'));
      await tester.pumpAndSettle();
      expect(find.text('SERVER'), findsOneWidget, reason: 'back to every session');
    }, skip: !drawsGoldens);
  }

  testWidgets("a group's page: a new agent from its pill, and its last session gone", (tester) async {
    await phone(tester);
    final model = await fixture(tester);
    await tester.pumpWidget(frame(SessionsScreen(model: model, open: (_) {}, unfolded: const {'h:laptop'})));
    await tester.pump();
    await tester.tap(find.bySemanticsLabel('Open work'));
    await tester.pumpAndSettle();
    await tester.tap(find.bySemanticsLabel('New agent'));
    await tester.pumpAndSettle();
    expect(find.byType(LaunchSheet), findsOneWidget);
    expect(find.text('Beside this one, in work on laptop'), findsOneWidget);
    Navigator.of(tester.element(find.byType(LaunchSheet))).pop();
    await tester.pumpAndSettle();
    model.client.onFrame(Frame(sessionEnded: SessionEnded(session: SessionRef(hostKey: hostKey, sessionId: 's-i1', instanceId: 'i1'))));
    // Gone once the client has waited for it to come back.
    await tester.pump(const Duration(seconds: 10));
    await tester.pumpAndSettle();
    expect(find.text('No pi sessions in work now.'), findsOneWidget);
    expect(find.textContaining('Start pi with the PiRC extension'), findsNothing);
  });

  // An iPad's screen, 13-inch, in landscape or portrait.
  Future<void> tablet(WidgetTester tester, {bool landscape = true}) async {
    tester.view.physicalSize = landscape ? const Size(1366 * 2, 1024 * 2) : const Size(1024 * 2, 1366 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
  }

  for (final b in Brightness.values) {
    testWidgets('a wide screen: the list beside the chat, its row marked, ${b.name}', (tester) async {
      await tablet(tester);
      final model = await fixture(tester);
      final selected = ValueNotifier<String?>('0101010101010101-i1');
      final look = b == Brightness.dark ? Look.dark : Look.light;
      await tester.pumpWidget(frame(
        Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          SizedBox(width: 380, child: SessionsScreen(model: model, open: (_) {}, unfolded: const {'h:laptop', 'h:server', 'g:laptop/work'}, settings: () {}, selected: selected)),
          Container(width: 0.5, color: look.rule),
          Expanded(child: ChatScreen(model: model, id: '0101010101010101-i1', wide: true)),
        ]),
        brightness: b,
      ));
      await tester.pump();
      expect(find.text('Sessions'), findsOneWidget, reason: "the list's title, and no way back in the chat");
      final marked = <String>[];
      void visit(SemanticsNode n) {
        final d = n.getSemanticsData();
        if (d.flagsCollection.isButton && d.flagsCollection.isSelected == ui.Tristate.isTrue) marked.add(d.label);
        n.visitChildren((c) {
          visit(c);
          return true;
        });
      }

      final handle = tester.ensureSemantics();
      await tester.pump();
      visit(tester.binding.renderViews.first.owner!.semanticsOwner!.rootSemanticsNode!);
      handle.dispose();
      expect(marked.where((l) => l.contains('release')), hasLength(1), reason: "the chat's row, marked as selected");
      await expectLater(find.byType(CupertinoApp), matchesGoldenFile('goldens/wide_${b.name}.png'));
    }, skip: !drawsGoldens);
  }

  testWidgets('a wide screen in the app: Settings beside the list, and over it when the screen narrows', (tester) async {
    await tablet(tester);
    const relay = 'ws://127.0.0.1:9';
    final store = MemoryKeyStore();
    await tester.runAsync(() => KeyHolder.create(store, relay, protect: false));
    await tester.pumpWidget(PircApp(store: store, prefs: MemoryPrefs(relay), fontFamily: font, protect: false));
    for (var i = 0; i < 5 && find.byType(SessionsScreen).evaluate().isEmpty; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
    }
    expect(find.text('Choose a session to see its chat.'), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('Settings'));
    await tester.pumpAndSettle();
    expect(find.byType(SettingsScreen), findsOneWidget);
    expect(find.byType(SessionsScreen), findsOneWidget, reason: 'beside it');
    expect(find.descendant(of: find.byType(SettingsScreen), matching: find.text('Sessions')), findsNothing, reason: 'no way back beside the list');
    // Narrowed (Split View, a window): Settings over the list, with a way back.
    tester.view.physicalSize = const Size(678 * 2, 1024 * 2);
    await tester.pumpAndSettle();
    expect(find.descendant(of: find.byType(SettingsScreen), matching: find.text('Sessions')), findsOneWidget);
    // Wide again: beside it once more.
    tester.view.physicalSize = const Size(1366 * 2, 1024 * 2);
    await tester.pumpAndSettle();
    expect(find.byType(SettingsScreen), findsOneWidget);
    expect(find.descendant(of: find.byType(SettingsScreen), matching: find.text('Sessions')), findsNothing);
    expect(find.text('Choose a session to see its chat.'), findsNothing);
    // Closed on the narrow screen, nothing is open when it widens.
    tester.view.physicalSize = const Size(678 * 2, 1024 * 2);
    await tester.pumpAndSettle();
    await tester.tap(find.descendant(of: find.byType(SettingsScreen), matching: find.text('Sessions')));
    await tester.pumpAndSettle();
    tester.view.physicalSize = const Size(1366 * 2, 1024 * 2);
    await tester.pumpAndSettle();
    expect(find.text('Choose a session to see its chat.'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 31));
  });

  // The app joined, with no sessions listed, on a screen size given.
  Future<void> joinedApp(WidgetTester tester) async {
    const relay = 'ws://127.0.0.1:9';
    final store = MemoryKeyStore();
    await tester.runAsync(() => KeyHolder.create(store, relay, protect: false));
    await tester.pumpWidget(PircApp(store: store, prefs: MemoryPrefs(relay), fontFamily: font, protect: false));
    for (var i = 0; i < 5 && find.byType(SessionsScreen).evaluate().isEmpty; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
    }
  }

  void width(WidgetTester tester, double w) => tester.view.physicalSize = Size(w * 2, 1024 * 2);

  testWidgets('crossing the width: a chat opened twice stays open; a sheet over the list stays; back in the column', (tester) async {
    tester.view.devicePixelRatio = 2;
    width(tester, 744);
    addTearDown(tester.view.reset);
    await joinedApp(tester);
    final list = tester.widget<SessionsScreen>(find.byType(SessionsScreen));
    // Opened, and opened again (its notification tapped): still open.
    list.open('0101010101010101-i1');
    await tester.pumpAndSettle();
    list.open('0101010101010101-i1');
    await tester.pumpAndSettle();
    expect(find.byType(ChatScreen), findsOneWidget);
    width(tester, 1133);
    await tester.pumpAndSettle();
    expect(find.byType(ChatScreen), findsOneWidget, reason: 'beside the list now');
    expect(find.text('Choose a session to see its chat.'), findsNothing);
    // Narrow again with a sheet open over it: the sheet stays, and the
    // chat comes over the list once it has gone.
    showSheet<void>(tester.element(find.byType(SessionsScreen)), (_) => const Sheet(title: 'A sheet', children: []));
    await tester.pumpAndSettle();
    width(tester, 744);
    await tester.pumpAndSettle();
    expect(find.text('A sheet'), findsOneWidget, reason: 'not buried, not closed');
    Navigator.of(tester.element(find.text('A sheet'))).pop();
    await tester.pumpAndSettle();
    expect(find.byType(ChatScreen), findsOneWidget, reason: 'over the list once the sheet went');
    // Widened with the chat's sheet open: the sheet goes with the chat,
    // which is beside the list now.
    showSheet<void>(tester.element(find.byType(ChatScreen)), (_) => const Sheet(title: "The chat's", children: []));
    await tester.pumpAndSettle();
    width(tester, 1133);
    await tester.pumpAndSettle();
    expect(find.text("The chat's"), findsNothing);
    expect(find.byType(ChatScreen), findsOneWidget);
    // Narrow with nothing open, then widened with the list's sheet open: it
    // stays.
    width(tester, 744);
    await tester.pumpAndSettle();
    Navigator.of(tester.element(find.byType(ChatScreen))).pop();
    await tester.pumpAndSettle();
    showSheet<void>(tester.element(find.byType(SessionsScreen)), (_) => const Sheet(title: "The list's", children: []));
    await tester.pumpAndSettle();
    width(tester, 1133);
    await tester.pumpAndSettle();
    expect(find.text("The list's"), findsOneWidget);
    expect(find.text('Choose a session to see its chat.'), findsOneWidget, reason: 'closed while narrow: nothing open');
    Navigator.of(tester.element(find.text("The list's"))).pop();
    await tester.pumpAndSettle();
    // Android's back on a page in the list's column closes that page.
    final column = Navigator.of(tester.element(find.byType(SessionsScreen)));
    column.push(CupertinoPageRoute<void>(builder: (_) => const CupertinoPageScaffold(child: Text('a host'))));
    await tester.pumpAndSettle();
    expect(find.text('a host'), findsOneWidget);
    expect(await tester.binding.handlePopRoute(), isTrue);
    await tester.pumpAndSettle();
    expect(find.text('a host'), findsNothing);
    expect(find.byType(SessionsScreen), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 31));
  });

  testWidgets('the session list searched, its matches marked', (tester) async {
    await phone(tester);
    final model = await fixture(tester);
    await tester.pumpWidget(frame(SessionsScreen(model: model, open: (_) {}, unfolded: const {})));
    await tester.pump();
    await tester.enterText(find.byType(CupertinoSearchTextField), 'rel');
    await tester.pump();
    expect(find.textContaining('release'), findsWidgets);
    await expectLater(find.byType(SessionsScreen), matchesGoldenFile('goldens/sessions_search_light.png'));
  }, skip: !drawsGoldens);

  testWidgets("a host's and a group's + after its name, level with its chevron, which is always at the end", (tester) async {
    await phone(tester);
    final model = await fixture(tester);
    // A host whose sessions are all in one group: its + on its own line,
    // whose padding above is more than below.
    model.client.onFrame(Frame(sessionUpdated: SessionUpdated(entry: entry('i5', 'box', SessionAnnouncement(name: 'deploy', cwd: '/srv', hostname: 'box', launcher: 'tmux', place: Place(kind: 'tmux', group: 'ops', window: 'deploy'))))));
    await tester.pumpWidget(frame(SessionsScreen(model: model, open: (_) {}, unfolded: const {'h:laptop', 'h:box', 'h:server', 'g:laptop/work', 'g:box/ops'})));
    await tester.pump();
    final chevrons = [for (final e in find.byIcon(CupertinoIcons.chevron_forward).evaluate()) tester.getCenter(find.byWidget(e.widget))];
    expect(chevrons.length, greaterThanOrEqualTo(4), reason: 'the hosts and groups in view');
    expect({for (final c in chevrons) c.dx.round()}, hasLength(1), reason: 'with a + or not');
    for (final (where, name) in [('ops', 'BOX'), ('work', 'work')]) {
      final add = find.bySemanticsLabel('New agent in $where');
      expect(add, findsOneWidget);
      final plus = tester.getCenter(find.descendant(of: add, matching: find.byIcon(CupertinoIcons.plus)));
      expect(chevrons.where((c) => (c.dy - plus.dy).abs() < 0.5), hasLength(1), reason: '$where: level with its chevron');
      final label = tester.getRect(find.text(name));
      expect(plus.dx - label.right, inInclusiveRange(10, 30), reason: '$where: just after its name');
      expect(tester.getSize(add).height, greaterThanOrEqualTo(44));
    }
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 31));
  });

  testWidgets("a new agent from a group's +, in a folder chosen, its chat opened once the new pi connects", (tester) async {
    await phone(tester);
    final model = await fixture(tester);
    final opened = <String>[];
    await tester.pumpWidget(frame(SessionsScreen(model: model, open: opened.add, unfolded: const {'h:laptop', 'h:server', 'g:laptop/work'})));
    await tester.pump();
    expect(find.bySemanticsLabel('New agent in work'), findsOneWidget, reason: 'release can open one');
    sent.clear();
    await tester.tap(find.bySemanticsLabel('New agent in work'));
    await tester.pumpAndSettle();
    expect(find.text('Beside this one, in work on laptop'), findsOneWidget);
    // The folders of the host's saved sessions, after its live ones'.
    final past = SessionMessage.fromBuffer(sent.lastWhere((f) => f.hasRouted()).routed.payload).listPastSessions;
    expect(past.allFolders, isTrue);
    final f = sent.lastWhere((f) => f.hasRouted());
    model.client.onFrame(Frame(routed: Routed(session: f.routed.session, payload: SessionMessage(pastSessions: PastSessions(requestId: past.requestId, sessions: [
      PastSession(path: '/p/1.jsonl', cwd: '/home/me/src/site'),
      PastSession(path: '/p/2.jsonl', cwd: '/home/me/src/blog'),
    ])).writeToBuffer())));
    await tester.pumpAndSettle();
    expect(find.text("This agent's folder"), findsOneWidget);
    expect(find.text('/home/me/src/blog'), findsOneWidget);
    expect(find.text('/home/me/src/site'), findsOneWidget, reason: 'once, though live and saved');
    await expectLater(find.byType(CupertinoApp), matchesGoldenFile('goldens/launch_light.png'));
    sent.clear();
    await tester.tap(find.text('/home/me/src/blog'));
    await tester.pump();
    final launch = SessionMessage.fromBuffer(sent.lastWhere((f) => f.hasRouted()).routed.payload).launch;
    expect(launch.cwd, '/home/me/src/blog');
    expect(launch.name, 'blog', reason: "the folder's");
    expect(find.text('Opening pi in /home/me/src/blog…'), findsOneWidget);
    model.client.onFrame(Frame(routed: Routed(session: f.routed.session, payload: SessionMessage(accepted: Accepted(requestId: launch.requestId)).writeToBuffer())));
    await tester.pump();
    expect(opened, isEmpty, reason: 'not until the new pi connects');
    model.client.onFrame(Frame(sessionUpdated: SessionUpdated(entry: entry('i5', 'laptop', SessionAnnouncement(cwd: '/home/me/src/blog', hostname: 'laptop.local', launchId: launch.requestId)))));
    await tester.pumpAndSettle();
    expect(find.text('New agent'), findsNothing, reason: 'the sheet closed');
    expect(opened, ['0101010101010101-i5']);
    // Its history, which the client asks for as it connects.
    final h = sent.lastWhere((f) => f.hasRouted() && f.routed.session.instanceId == 'i5');
    final asked = SessionMessage.fromBuffer(h.routed.payload).historyRequest;
    model.client.onFrame(Frame(routed: Routed(session: h.routed.session, payload: SessionMessage(history: History(requestId: asked.requestId, seq: Int64(1))).writeToBuffer())));
    await tester.pump();
  }, skip: !drawsGoldens);

  testWidgets("a new agent from the chat's actions, connecting before the launch is answered, its chat opened", (tester) async {
    await phone(tester);
    final model = await fixture(tester);
    final opened = <String>[];
    await tester.pumpWidget(frame(ChatScreen(model: model, id: '0101010101010101-i1', open: opened.add)));
    await tester.pump();
    await tester.tap(find.bySemanticsLabel('Session actions'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('New agent'));
    await tester.pumpAndSettle();
    expect(find.text('Another pi beside this one, in work on laptop'), findsOneWidget);
    await tester.tap(find.text('New agent'));
    await tester.pumpAndSettle();
    sent.clear();
    await tester.tap(find.text("This agent's folder"));
    await tester.pump();
    final f = sent.lastWhere((f) => f.hasRouted() && SessionMessage.fromBuffer(f.routed.payload).hasLaunch());
    final launch = SessionMessage.fromBuffer(f.routed.payload).launch;
    expect(launch.cwd, '/home/me/src/pirc');
    model.client.onFrame(Frame(sessionUpdated: SessionUpdated(entry: entry('i5', 'laptop', SessionAnnouncement(cwd: '/home/me/src/pirc', hostname: 'laptop.local', launchId: launch.requestId)))));
    await tester.pumpAndSettle();
    expect(opened, ['0101010101010101-i5'], reason: 'before the answer');
    model.client.onFrame(Frame(routed: Routed(session: f.routed.session, payload: SessionMessage(accepted: Accepted(requestId: launch.requestId)).writeToBuffer())));
    final h = sent.lastWhere((f) => f.hasRouted() && f.routed.session.instanceId == 'i5');
    model.client.onFrame(Frame(routed: Routed(session: h.routed.session, payload: SessionMessage(history: History(requestId: SessionMessage.fromBuffer(h.routed.payload).historyRequest.requestId, seq: Int64(1))).writeToBuffer())));
    await tester.pumpAndSettle();
    expect(opened, ['0101010101010101-i5'], reason: 'once');
    await tester.pump(const Duration(milliseconds: connectMs));
  }, skip: !drawsGoldens);

  testWidgets('a new agent refused, said why, and one typed in that never connects', (tester) async {
    await phone(tester);
    final model = await fixture(tester);
    await tester.pumpWidget(frame(SessionsScreen(model: model, open: (_) {}, unfolded: const {'h:laptop', 'g:laptop/work'})));
    await tester.pump();
    await tester.tap(find.bySemanticsLabel('New agent in work'));
    await tester.pumpAndSettle();
    final fields = find.descendant(of: find.byType(LaunchSheet), matching: find.byType(CupertinoTextField));
    await tester.enterText(fields.first, 'notes');
    await tester.enterText(fields.last, '~/nowhere');
    await tester.pump();
    sent.clear();
    await tester.tap(find.text('Open'));
    await tester.pump();
    final launch = SessionMessage.fromBuffer(sent.lastWhere((f) => f.hasRouted()).routed.payload).launch;
    expect(launch.cwd, '~/nowhere');
    expect(launch.name, 'notes', reason: 'the name typed');
    final f = sent.lastWhere((f) => f.hasRouted());
    model.client.onFrame(Frame(routed: Routed(session: f.routed.session, payload: SessionMessage(error: Error(requestId: launch.requestId, code: ErrorCode.ERROR_CODE_INVALID, message: 'no folder ~/nowhere on this host')).writeToBuffer())));
    await tester.pump();
    expect(find.text('no folder ~/nowhere on this host'), findsOneWidget);
    // Accepted, and nothing connects.
    sent.clear();
    await tester.tap(find.text('/home/me/src/pirc'));
    await tester.pump();
    final again = SessionMessage.fromBuffer(sent.lastWhere((f) => f.hasRouted()).routed.payload).launch;
    model.client.onFrame(Frame(routed: Routed(session: f.routed.session, payload: SessionMessage(accepted: Accepted(requestId: again.requestId)).writeToBuffer())));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: connectMs));
    expect(find.textContaining('has not connected yet'), findsOneWidget);
  }, skip: !drawsGoldens);

  testWidgets('a reply in Markdown', (tester) async {
    await phone(tester);
    final model = await fixture(tester);
    await tester.pumpWidget(frame(ChatScreen(model: model, id: '0101010101010101-i3')));
    await tester.pump();
    expect(find.text('ts'), findsOneWidget, reason: "the code block's language");
    expect(find.text('src/version.ts'), findsOneWidget, reason: 'and its file');
    expect(find.textContaining('export const version'), findsOneWidget);
    expect(find.text('Page'), findsOneWidget, reason: "the table's head");
    expect(find.text('Copy'), findsNWidgets(2), reason: 'the code and the reply');
    await expectLater(find.byType(ChatScreen), matchesGoldenFile('goldens/markdown_light.png'));
  }, skip: !drawsGoldens);

  // pi writing in release (i1), a piece of block 0 at a time.
  var seq = 2;
  Future<void> event(WidgetTester tester, PircModel model, SessionEvent e) async {
    model.client.onFrame(Frame(routed: Routed(
      session: SessionRef(hostKey: hostKey, sessionId: 's-i1', instanceId: 'i1'),
      payload: SessionMessage(event: e..seq = Int64(++seq)..at = ts(now)).writeToBuffer(),
    )));
    // The frame, and the one the chat asks for after it, placing its centre.
    await tester.pump();
    await tester.pump();
  }

  Future<void> delta(WidgetTester tester, PircModel model, String text, {String id = 'a9', String turn = 't'}) =>
      event(tester, model, SessionEvent(assistantDelta: AssistantDelta(messageId: id, turnId: turn, text: text)));

  testWidgets('a reply as it streams: a cursor after its last word, or under its code', (tester) async {
    await phone(tester);
    final model = await fixture(tester);
    await tester.pumpWidget(frame(ChatScreen(model: model, id: '0101010101010101-i1')));
    seq = 2;
    await delta(tester, model, 'The checks pass. Tagging **0.2**');
    expect(find.byType(Cursor), findsOneWidget);
    expect(find.descendant(of: find.byType(RichText), matching: find.byType(Cursor)), findsOneWidget, reason: 'in the last line');
    await expectLater(find.byType(ChatScreen), matchesGoldenFile('goldens/streaming_text_light.png'));
    await delta(tester, model, ' with:\n\n```sh\ngit tag v0.2.0\n```');
    expect(find.descendant(of: find.byType(RichText), matching: find.byType(Cursor)), findsNothing, reason: 'under the code block');
    expect(find.byType(Cursor), findsOneWidget);
    await expectLater(find.byType(ChatScreen), matchesGoldenFile('goldens/streaming_light.png'));
    // It blinks as the web's does: full, half, none, half.
    final bar = find.descendant(of: find.byType(Cursor), matching: find.byType(Opacity));
    final seen = <double>[];
    for (var i = 0; i < 5; i++) {
      seen.add(tester.widget<Opacity>(bar).opacity);
      await tester.pump(const Duration(milliseconds: 250));
    }
    expect(seen, [1, 0.5, 0, 0.5, 1]);
  }, skip: !drawsGoldens);

  testWidgets('scrolled up, a button goes back to the end, and says when more has come', (tester) async {
    await phone(tester);
    final model = await fixture(tester);
    await tester.pumpWidget(frame(ChatScreen(model: model, id: '0101010101010101-i1')));
    seq = 2;
    await delta(tester, model, [for (var i = 1; i <= 12; i++) 'Step $i of the release checks, which takes a line or two to describe.'].join('\n\n'));
    expect(find.bySemanticsLabel('Go to the end'), findsNothing, reason: 'at the end');
    await tester.drag(find.byType(CustomScrollView), const Offset(0, 400));
    await tester.pump();
    expect(find.bySemanticsLabel('Go to the end'), findsOneWidget);
    await delta(tester, model, '\n\nDone.');
    expect(find.bySemanticsLabel('New messages: go to the end'), findsOneWidget);
    await expectLater(find.byType(ChatScreen), matchesGoldenFile('goldens/away_light.png'));
    await tester.tap(find.text('New messages'));
    await tester.pump();
    expect(find.bySemanticsLabel(RegExp('go to the end', caseSensitive: false)), findsNothing);
    expect(find.textContaining('Done.'), findsOneWidget);
  }, skip: !drawsGoldens);

  // The chat's scroll position, and how far the end of its last row is from
  // the bottom of the chat (16, its padding, when at the end).
  ScrollPosition chatScroll(WidgetTester tester) => tester.state<ScrollableState>(find.descendant(of: find.byType(CustomScrollView), matching: find.byType(Scrollable)).first).position;
  double fromEnd(WidgetTester tester, Finder last) => tester.getRect(find.byType(CustomScrollView)).bottom - tester.getRect(last).bottom;
  final steps = [for (var i = 1; i <= 12; i++) 'Step $i of the release checks, which takes a line or two to describe.'].join('\n\n');

  testWidgets('scrolled up, the chat gone back to a point where it fits the screen is at its end, its button gone', (tester) async {
    await phone(tester);
    final model = await fixture(tester);
    await tester.pumpWidget(frame(ChatScreen(model: model, id: '0101010101010101-i1')));
    seq = 2;
    await delta(tester, model, [for (var i = 1; i <= 12; i++) 'Step $i of the release checks, which takes a line or two to describe.'].join('\n\n'));
    await tester.drag(find.byType(CustomScrollView), const Offset(0, 400));
    await tester.pump();
    expect(find.bySemanticsLabel('Go to the end'), findsOneWidget);
    // Gone back in pi's tree: the history asked for again, and short.
    sent.clear();
    await event(tester, model, SessionEvent(branchChanged: BranchChanged(leafId: 'e0')));
    final f = sent.lastWhere((f) => f.hasRouted() && SessionMessage.fromBuffer(f.routed.payload).hasHistoryRequest());
    final h = SessionMessage(history: History(
      requestId: SessionMessage.fromBuffer(f.routed.payload).historyRequest.requestId,
      items: [user('Release 0.2: bump the version, run the checks, tag it.', now, entry: 'e1')],
      seq: Int64(seq),
    ));
    model.client.onFrame(Frame(routed: Routed(session: f.routed.session, payload: h.writeToBuffer())));
    await tester.pump();
    await tester.pump();
    await tester.pump();
    await tester.pumpAndSettle();
    expect(find.textContaining('Step 12'), findsNothing);
    expect(find.bySemanticsLabel(RegExp('go to the end', caseSensitive: false)), findsNothing);
    final p = chatScroll(tester);
    expect(p.pixels, moreOrLessEquals(p.maxScrollExtent), reason: 'at the end');
    expect(p.maxScrollExtent - p.minScrollExtent, lessThan(1), reason: 'nothing to scroll');
  }, skip: !drawsGoldens);

  testWidgets('a short chat does not scroll, and its end stays at the bottom as the keyboard opens and closes', (tester) async {
    await phone(tester);
    final model = await fixture(tester);
    for (final keyboard in [0.0, 300.0, 0.0]) {
      await tester.pumpWidget(frame(ChatScreen(model: model, id: '0101010101010101-i3'), keyboard: keyboard));
      await tester.pump();
      await tester.pump();
      // With the keyboard open, it is taller than what is left, and scrolls.
      final p = chatScroll(tester);
      if (keyboard == 0) expect(p.maxScrollExtent - p.minScrollExtent, lessThan(1), reason: 'keyboard $keyboard');
      // Its end, Copy under the reply, at the bottom: the 16 under it, 8
      // under Copy's word, and 8 that Copy is drawn up by.
      expect(fromEnd(tester, find.text('Copy').last), moreOrLessEquals(32, epsilon: 1), reason: 'its end at the bottom, keyboard $keyboard');
      if (keyboard > 0) continue;
      await tester.drag(find.byType(CustomScrollView), const Offset(0, 200));
      await tester.pumpAndSettle();
      expect(fromEnd(tester, find.text('Copy').last), moreOrLessEquals(32, epsilon: 1), reason: 'dragged, it comes back');
    }
  }, skip: !drawsGoldens);

  testWidgets('a reply taller than the screen stays at the end as it grows, and the keyboard opens', (tester) async {
    await phone(tester);
    final model = await fixture(tester);
    await tester.pumpWidget(frame(ChatScreen(model: model, id: '0101010101010101-i1')));
    seq = 2;
    await delta(tester, model, steps);
    for (var i = 1; i <= 5; i++) {
      await delta(tester, model, '\n\nMore $i.');
      expect(fromEnd(tester, find.textContaining('More $i.')), moreOrLessEquals(16, epsilon: 1), reason: 'piece $i');
    }
    await tester.pumpWidget(frame(ChatScreen(model: model, id: '0101010101010101-i1'), keyboard: 300));
    await tester.pump();
    expect(fromEnd(tester, find.textContaining('More 5.')), moreOrLessEquals(16, epsilon: 1), reason: 'the keyboard open');
    await delta(tester, model, '\n\nMore 6.');
    expect(fromEnd(tester, find.textContaining('More 6.')), moreOrLessEquals(16, epsilon: 1), reason: 'and growing');
  }, skip: !drawsGoldens);

  testWidgets('scrolled up into a reply as it grows, what is read stays where it is', (tester) async {
    await phone(tester);
    final model = await fixture(tester);
    await tester.pumpWidget(frame(ChatScreen(model: model, id: '0101010101010101-i1')));
    seq = 2;
    await delta(tester, model, steps);
    await tester.drag(find.byType(CustomScrollView), const Offset(0, 300));
    await tester.pumpAndSettle();
    final read = find.textContaining('Step 6 of');
    final y = tester.getRect(read).top;
    for (var i = 1; i <= 5; i++) {
      await delta(tester, model, '\n\nMore $i, and a line long enough to wrap onto a second one.');
      expect(tester.getRect(read).top, y, reason: 'piece $i');
    }
    // The reply ends and a new turn starts: still where it was.
    await event(tester, model, SessionEvent(item: reply('a9', [ContentBlock(text: '$steps\n\nDone.')], now)));
    await event(tester, model, SessionEvent(item: user('and tag it', now, entry: 'e9')..turnId = 't2'));
    await delta(tester, model, 'Tagging it now.', id: 'a10', turn: 't2');
    expect(tester.getRect(read).top, y, reason: 'a new turn');
    // Back at the end, it follows the new reply.
    await tester.tap(find.bySemanticsLabel(RegExp('go to the end', caseSensitive: false)));
    await tester.pump();
    await tester.pump();
    for (var i = 1; i <= 3; i++) {
      await delta(tester, model, ' More $i.', id: 'a10', turn: 't2');
      expect(fromEnd(tester, find.textContaining('Tagging it now.')), moreOrLessEquals(16, epsilon: 1), reason: 'piece $i');
    }
  }, skip: !drawsGoldens);

  testWidgets('scrolled up, a fold above the centre opens and closes downward, nothing above it moving', (tester) async {
    await phone(tester);
    final model = await fixture(tester);
    await tester.pumpWidget(frame(ChatScreen(model: model, id: '0101010101010101-i1')));
    seq = 2;
    // A new turn at the end, so that the first is above the centre.
    await event(tester, model, SessionEvent(item: user('and tag it', now, entry: 'e9')..turnId = 't2'));
    await delta(tester, model, steps, id: 'a10', turn: 't2');
    await tester.drag(find.byType(CustomScrollView), const Offset(0, 300));
    await tester.pumpAndSettle();
    await tester.dragUntilVisible(find.text('Thinking'), find.byType(CustomScrollView), const Offset(0, 100));
    await tester.drag(find.byType(CustomScrollView), const Offset(0, 100));
    await tester.pumpAndSettle();
    final above = find.textContaining('Release 0.2');
    final thought = find.text('The version lives in package.json and the Go module.');
    final at = (tester.getRect(above).top, tester.getRect(find.text('Thinking')).top);
    final below = tester.getRect(find.textContaining("I'll bump the version")).top;
    for (final open in [true, false]) {
      await tester.tap(find.text('Thinking'));
      await tester.pump();
      await tester.pump();
      expect(thought, open ? findsOneWidget : findsNothing);
      expect((tester.getRect(above).top, tester.getRect(find.text('Thinking')).top), at, reason: open ? 'opened' : 'closed');
      final now = tester.getRect(find.textContaining("I'll bump the version")).top;
      expect(open ? now > below : now == below, isTrue, reason: 'what is under it moved, open $open');
    }
  }, skip: !drawsGoldens);

  // docs (i3), idle, with its model and thinking level.
  Future<PircModel> docs(WidgetTester tester) async {
    await phone(tester);
    final model = await fixture(tester);
    model.client.onFrame(Frame(sessionUpdated: SessionUpdated(entry: entry('i3', 'laptop', SessionAnnouncement(
      name: 'docs', cwd: '/home/me/src/site', hostname: 'laptop.local',
      model: Model(provider: 'anthropic', id: 'claude-sonnet-5-5', name: 'Sonnet 5.5'), thinkingLevel: ThinkingLevel.THINKING_LEVEL_MEDIUM,
    )))));
    await tester.pumpWidget(frame(ChatScreen(model: model, id: '0101010101010101-i3')));
    await tester.pump();
    await tester.pump();
    return model;
  }

  // The request the chat sent last, and its answer from pi.
  SessionMessage asked() => SessionMessage.fromBuffer(sent.lastWhere((f) => f.hasRouted()).routed.payload);
  Future<void> answer(WidgetTester tester, PircModel model, SessionMessage reply) async {
    final f = sent.lastWhere((f) => f.hasRouted());
    model.client.onFrame(Frame(routed: Routed(session: f.routed.session, payload: reply.writeToBuffer())));
    await tester.pumpAndSettle();
  }

  Future<void> openActions(WidgetTester tester) async {
    await tester.tap(find.bySemanticsLabel('Session actions'));
    await tester.pumpAndSettle();
  }

  testWidgets("the session's actions, and its thinking level changed from them", (tester) async {
    final model = await docs(tester);
    expect(find.text('61% · \$1.84'), findsOneWidget, reason: "the header's figures");
    await openActions(tester);
    expect(find.text('Sonnet 5.5'), findsOneWidget);
    expect(find.text('\$1.84 · 61%'), findsOneWidget);
    expect(find.text('Stop pi'), findsOneWidget);
    await expectLater(find.byType(CupertinoApp), matchesGoldenFile('goldens/actions_light.png'));
    sent.clear();
    await tester.tap(find.text('high'));
    await tester.pumpAndSettle();
    expect(asked().setThinkingLevel.level, ThinkingLevel.THINKING_LEVEL_HIGH);
    expect(find.text('Thinking level'), findsNothing, reason: 'the sheet closed');
    await answer(tester, model, SessionMessage(accepted: Accepted(requestId: asked().setThinkingLevel.requestId)));
  }, skip: !drawsGoldens);

  testWidgets('a model chosen by searching', (tester) async {
    final model = await docs(tester);
    await openActions(tester);
    await tester.tap(find.text('Model'));
    await tester.pumpAndSettle();
    expect(find.text('CURRENT'), findsOneWidget);
    await expectLater(find.byType(CupertinoApp), matchesGoldenFile('goldens/models_light.png'));
    await tester.enterText(find.byType(CupertinoSearchTextField), 'opus');
    await tester.pump();
    expect(find.text('GPT-6'), findsNothing);
    await expectLater(find.byType(CupertinoApp), matchesGoldenFile('goldens/models_search_light.png'));
    sent.clear();
    await tester.tap(find.textContaining('Opus'));
    await tester.pumpAndSettle();
    expect(asked().setModel.model.id, 'claude-opus-5-5');
    await answer(tester, model, SessionMessage(accepted: Accepted(requestId: asked().setModel.requestId)));
  }, skip: !drawsGoldens);

  testWidgets('renamed, a new session asked for and refused, and the cost said under the header', (tester) async {
    final model = await docs(tester);
    await openActions(tester);
    await tester.tap(find.text('Rename'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(CupertinoTextField).last, 'docs for 0.2');
    await tester.pump();
    sent.clear();
    await tester.tap(find.text('Rename').last);
    await tester.pumpAndSettle();
    expect(asked().rename.name, 'docs for 0.2');
    await answer(tester, model, SessionMessage(accepted: Accepted(requestId: asked().rename.requestId)));
    // A new session, asked first, and refused: why, under the header.
    await openActions(tester);
    await tester.tap(find.text('New session'));
    await tester.pumpAndSettle();
    expect(find.textContaining('pi starts an empty conversation'), findsOneWidget);
    await expectLater(find.byType(CupertinoApp), matchesGoldenFile('goldens/new_session_light.png'));
    sent.clear();
    await tester.tap(find.text('New session').last);
    await tester.pumpAndSettle();
    expect(asked().hasNewSession(), isTrue);
    await answer(tester, model, SessionMessage(error: Error(requestId: asked().newSession.requestId, code: ErrorCode.ERROR_CODE_PI_FAILED, message: 'another extension cancelled it')));
    expect(find.textContaining('PI_FAILED: another extension cancelled it'), findsOneWidget);
    // The figures, in full.
    await openActions(tester);
    await tester.tap(find.text('Cost and context'));
    await tester.pumpAndSettle();
    expect(find.textContaining('so far · 48,210 in, 9,302 out, 310,455 cached'), findsOneWidget);
    await expectLater(find.byType(ChatScreen), matchesGoldenFile('goldens/notice_light.png'));
    await tester.tap(find.bySemanticsLabel('Dismiss'));
    await tester.pump();
    expect(find.textContaining('so far'), findsNothing);
  }, skip: !drawsGoldens);

  testWidgets('from one of your messages, gone back with a summary and forked, the message back in the box each time', (tester) async {
    final model = await docs(tester);
    String box() => tester.widget<CupertinoTextField>(find.byType(CupertinoTextField).last).controller!.text;
    await tester.tap(find.text('update the docs for 0.2'));
    await tester.pumpAndSettle();
    expect(find.text('From this message'), findsOneWidget);
    expect(find.text('Go back to here'), findsOneWidget);
    expect(find.text('Fork from here'), findsOneWidget);
    await expectLater(find.byType(CupertinoApp), matchesGoldenFile('goldens/from_message_light.png'));
    // Gone back, refused: the box as it was.
    sent.clear();
    await tester.tap(find.text('Go back to here'));
    await tester.pumpAndSettle();
    expect(asked().navigateTree.summarize, isFalse);
    await answer(tester, model, SessionMessage(error: Error(requestId: asked().navigateTree.requestId, code: ErrorCode.ERROR_CODE_BUSY, message: 'pi is working')));
    expect(box(), '');
    await tester.tap(find.text('update the docs for 0.2'));
    await tester.pumpAndSettle();
    sent.clear();
    await tester.tap(find.text('Go back with a summary'));
    await tester.pumpAndSettle();
    expect(find.text('From this message'), findsNothing, reason: 'the sheet closed');
    expect(asked().navigateTree.entryId, 'e3');
    expect(asked().navigateTree.summarize, isTrue);
    await answer(tester, model, SessionMessage(accepted: Accepted(requestId: asked().navigateTree.requestId)));
    expect(find.textContaining('with a summary of what came after'), findsOneWidget);
    expect(box(), 'update the docs for 0.2');
    // Forked, refused: the box as it was.
    await tester.tap(find.text('update the docs for 0.2').first);
    await tester.pumpAndSettle();
    sent.clear();
    await tester.tap(find.text('Fork from here'));
    await tester.pumpAndSettle();
    expect(asked().fork.entryId, 'e3');
    await answer(tester, model, SessionMessage(error: Error(requestId: asked().fork.requestId, code: ErrorCode.ERROR_CODE_BUSY, message: 'pi is working')));
    expect(find.textContaining('BUSY: pi is working'), findsOneWidget);
    expect(box(), 'update the docs for 0.2');
    // Forked: the message before what was being written.
    await tester.tap(find.text('update the docs for 0.2').first);
    await tester.pumpAndSettle();
    sent.clear();
    await tester.tap(find.text('Fork from here'));
    await tester.pumpAndSettle();
    await answer(tester, model, SessionMessage(accepted: Accepted(requestId: asked().fork.requestId)));
    expect(find.textContaining('Forked into a new session'), findsOneWidget);
    expect(box(), 'update the docs for 0.2\n\nupdate the docs for 0.2');
  }, skip: !drawsGoldens);

  // A few frames, which a phone draws anyway: by then what was laid out
  // late (a table, a tool's output) is known to its selection.
  Future<void> known(WidgetTester tester) async {
    for (var i = 0; i < 5; i++) {
      tester.binding.scheduleFrame();
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  // What was put on the clipboard last.
  Future<String?> Function() clipboard(WidgetTester tester) {
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String?;
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    return () async => copied;
  }

  testWidgets('a reply selected with a long press, all of it copied, its controls left out; Copy reply its Markdown', (tester) async {
    await docs(tester);
    final copied = clipboard(tester);
    await tester.longPressAt(tester.getTopLeft(find.textContaining('now name')) + const Offset(16, 12));
    await tester.pumpAndSettle();
    await tester.pumpAndSettle();
    expect(find.text('Select all'), findsOneWidget, reason: "the system's menu");
    expect(find.text('Share'), findsOneWidget);
    await tester.tap(find.text('Select all'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Copy').last);
    await tester.pumpAndSettle();
    final all = (await copied())!;
    for (final part in ['Done: the docs say 0.2\nThe install page', '\n1. bumped the version', '\n// the one place it is written\nexport const version = "0.2.0";', '\nPage\tBefore\tAfter\ninstall\t0.1.4\t0.2.0\n', '\nThe README still says 0.1']) {
      expect(all, contains(part), reason: 'a line each, beside each other a space');
    }
    expect(all, isNot(contains('update the docs')), reason: 'within the one message');
    expect(all, isNot(contains('Copy')), reason: 'the buttons are not text');
    expect(all, isNot(contains('Full screen')));
    await tester.tap(find.bySemanticsLabel(RegExp('^Copy reply')));
    await tester.pump();
    expect(await copied(), markdownReply);
    await tester.pump(const Duration(seconds: 2));
  }, skip: !drawsGoldens);

  testWidgets('a selection ended by a tap beside the message, not by a scroll', (tester) async {
    await docs(tester);
    final copied = clipboard(tester);
    final words = find.textContaining('now name');
    await tester.longPressAt(tester.getTopLeft(words) + const Offset(16, 12));
    await tester.pumpAndSettle();
    await tester.drag(find.byType(CustomScrollView), const Offset(0, 40));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Copy').last);
    await tester.pumpAndSettle();
    expect(await copied(), 'The', reason: 'still selected after the scroll');
    await tester.longPressAt(tester.getTopLeft(words) + const Offset(16, 12));
    await tester.pumpAndSettle();
    expect(find.text('Select all'), findsOneWidget);
    await tester.tapAt(Offset(30, tester.getCenter(find.text('update the docs for 0.2')).dy));
    await tester.pumpAndSettle();
    expect(find.text('Select all'), findsNothing, reason: 'ended');
    expect(find.text('From this message'), findsNothing);
  }, skip: !drawsGoldens);

  testWidgets("a selection in a reply ended by a tap on your message, which only ends it; the next offers going back", (tester) async {
    await docs(tester);
    final words = find.textContaining('now name');
    await tester.longPressAt(tester.getTopLeft(words) + const Offset(16, 12));
    await tester.pumpAndSettle();
    expect(find.text('Select all'), findsOneWidget);
    await tester.tap(find.text('update the docs for 0.2'));
    await tester.pumpAndSettle();
    expect(find.text('Select all'), findsNothing, reason: 'ended');
    expect(find.text('From this message'), findsNothing, reason: 'the tap only ended it');
    await tester.tap(find.text('update the docs for 0.2'));
    await tester.pumpAndSettle();
    expect(find.text('From this message'), findsOneWidget);
  }, skip: !drawsGoldens);

  testWidgets("a table's empty cells copied as cells, its columns in place", (tester) async {
    await phone(tester);
    final copied = clipboard(tester);
    await tester.pumpWidget(frame(const CupertinoPageScaffold(child: SafeArea(child: Selectable(child: Markdown('| a | b | c |\n|---|---|---|\n| 1 |  | 3 |\n| 4 | 5 |'))))));
    await known(tester);
    await tester.longPressAt(tester.getTopLeft(find.text('3')) + const Offset(3, 8));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Select all'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Copy').last);
    await tester.pumpAndSettle();
    expect(await copied(), 'a\tb\tc\n1\t \t3\n4\t5\t ');
  }, skip: !drawsGoldens);

  testWidgets('a code block selected with a long press; its Copy copies the code', (tester) async {
    await docs(tester);
    final copied = clipboard(tester);
    await tester.longPressAt(tester.getTopLeft(find.textContaining('the one place')) + const Offset(30, 10));
    await tester.pumpAndSettle();
    expect(find.text('Select all'), findsOneWidget);
    await tester.tapAt(const Offset(5, 300));
    await tester.pumpAndSettle();
    await tester.tap(find.bySemanticsLabel(RegExp('^Copy code')));
    await tester.pump();
    expect(await copied(), startsWith('// the one place it is written\nexport const version'));
    await tester.pump(const Duration(seconds: 2));
  }, skip: !drawsGoldens);

  testWidgets('your message selected with a long press: no sheet; the tap that ends it only ends it, the next offers going back', (tester) async {
    await docs(tester);
    final copied = clipboard(tester);
    await tester.longPressAt(tester.getTopLeft(find.text('update the docs for 0.2')) + const Offset(20, 10));
    await tester.pumpAndSettle();
    expect(find.text('From this message'), findsNothing);
    await tester.tap(find.text('Copy').first);
    await tester.pumpAndSettle();
    expect(await copied(), isNotEmpty);
    await tester.longPressAt(tester.getTopLeft(find.text('update the docs for 0.2')) + const Offset(20, 10));
    await tester.pumpAndSettle();
    await tester.tap(find.text('update the docs for 0.2'));
    await tester.pumpAndSettle();
    expect(find.text('From this message'), findsNothing, reason: 'the selection ended');
    expect(find.text('Select all'), findsNothing);
    await tester.tap(find.text('update the docs for 0.2'));
    await tester.pumpAndSettle();
    expect(find.text('From this message'), findsOneWidget);
  }, skip: !drawsGoldens);

  testWidgets("a tool's output, opened, selected with a long press", (tester) async {
    await phone(tester);
    final model = await fixture(tester);
    await tester.pumpWidget(frame(ChatScreen(model: model, id: '0101010101010101-i1')));
    await known(tester);
    final copied = clipboard(tester);
    await tester.longPressAt(tester.getTopLeft(find.textContaining('go vet')) + const Offset(10, 8));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Select all'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Copy').last);
    await tester.pumpAndSettle();
    expect(await copied(), allOf(contains('ok  pirc.dev/relay'), contains('command  sh/check.sh'), isNot(contains('bash'))));
  }, skip: !drawsGoldens);

  testWidgets("the conversation's branches, and one switched to", (tester) async {
    final model = await docs(tester);
    await openActions(tester);
    sent.clear();
    await tester.tap(find.text('Branches'));
    await tester.pumpAndSettle();
    expect(find.text('Loading…'), findsOneWidget);
    const m = 60 * 1000;
    await answer(tester, model, SessionMessage(tree: Tree(requestId: asked().listTree.requestId, branches: [
      Branch(leafId: 'l1', current: true, prompt: 'update the docs for 0.2', last: 'Updated the README and the changelog.', modifiedAt: ts(now - 40 * m), messageCount: 2),
      Branch(leafId: 'l2', prompt: 'write the docs as a tutorial', last: 'A first draft of the tutorial.', modifiedAt: ts(now - 2 * 60 * m), messageCount: 3),
    ])));
    expect(find.text('This one · 40m · 2 messages'), findsOneWidget);
    expect(find.text('“write the docs as a tutorial”'), findsOneWidget);
    await expectLater(find.byType(CupertinoApp), matchesGoldenFile('goldens/branches_light.png'));
    await tester.tap(find.text('“write the docs as a tutorial”'));
    await tester.pumpAndSettle();
    expect(find.text('Switch to this branch?'), findsOneWidget);
    expect(find.text('A first draft of the tutorial.'), findsOneWidget);
    sent.clear();
    await tester.tap(find.text('Switch'));
    await tester.pumpAndSettle();
    expect(asked().navigateTree.entryId, 'l2');
    expect(asked().navigateTree.summarize, isFalse);
    await answer(tester, model, SessionMessage(accepted: Accepted(requestId: asked().navigateTree.requestId)));
    expect(find.textContaining('Switched to the branch “write the docs as a tutorial”'), findsOneWidget);
  }, skip: !drawsGoldens);

  testWidgets("what is being written is kept as the chat's draft, and cleared once sent", (tester) async {
    await phone(tester);
    final model = await fixture(tester);
    final drafts = MemoryDrafts(now: () => now);
    await drafts.save('0101010101010101-i3', 'and the README');
    await tester.pumpWidget(frame(ChatScreen(model: model, id: '0101010101010101-i3', drafts: drafts)));
    await tester.pump();
    expect(find.text('and the README'), findsOneWidget, reason: 'the draft, back in the box');
    await tester.enterText(find.byType(CupertinoTextField), 'and the README too');
    await tester.pump(const Duration(milliseconds: 500));
    expect(await drafts.load('0101010101010101-i3'), 'and the README too');
    // Left before it was kept: kept on leaving.
    await tester.enterText(find.byType(CupertinoTextField), 'and the README, both');
    await tester.pumpWidget(const SizedBox());
    expect(await drafts.load('0101010101010101-i3'), 'and the README, both');
    // Back, and sent: cleared.
    await tester.pumpWidget(frame(ChatScreen(model: model, id: '0101010101010101-i3', drafts: drafts)));
    await tester.pump();
    expect(find.text('and the README, both'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('send')));
    await tester.pump(const Duration(milliseconds: 500));
    expect(await drafts.load('0101010101010101-i3'), '');
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 1));
  }, skip: !drawsGoldens);

  // The picture the tests send and show: a PNG, 240 by 160.
  final picture = File('test/support/picture.png').readAsBytesSync();

  testWidgets("a message's images, as thumbnails that open full screen", (tester) async {
    final model = await docs(tester);
    model.client.onFrame(Frame(routed: Routed(
      session: SessionRef(hostKey: hostKey, sessionId: 's-i3', instanceId: 'i3'),
      payload: SessionMessage(event: SessionEvent(seq: Int64(2), at: ts(now), item: ConversationItem(
        entryId: 'e9', turnId: 't9', at: ts(now),
        userMessage: UserMessage(text: 'and this one, from the phone', images: [Image(mimeType: 'image/png', data: picture), Image(mimeType: 'image/png')]),
      ))).writeToBuffer(),
    )));
    await tester.pump();
    await tester.pump();
    expect(find.text('and this one, from the phone'), findsOneWidget);
    expect(find.bySemanticsLabel('Open image'), findsOneWidget);
    expect(find.text('Image'), findsOneWidget, reason: 'one left out of the frame: a placeholder');
    await tester.runAsync(() => precacheImage(MemoryImage(picture), tester.element(find.byType(ChatScreen))));
    await tester.pump();
    await expectLater(find.byType(ChatScreen), matchesGoldenFile('goldens/images_light.png'));
    await tester.tap(find.bySemanticsLabel('Open image'));
    await tester.pumpAndSettle();
    expect(find.byType(Viewer), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('Close'));
    await tester.pumpAndSettle();
    expect(find.byType(Viewer), findsNothing);
  }, skip: !drawsGoldens);

  testWidgets('pictures from the phone added to a message, one removed, and sent with it', (tester) async {
    final was = ImagePickerPlatform.instance;
    final picker = _Picker([picture, picture, Uint8List.fromList(utf8.encode('not a picture'))]);
    ImagePickerPlatform.instance = picker;
    addTearDown(() => ImagePickerPlatform.instance = was);
    final model = await docs(tester);
    await tester.tap(find.bySemanticsLabel('Add an image'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Choose from your photos'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
    await tester.pumpAndSettle();
    expect(picker.asked?.imageOptions.maxWidth, 2000, reason: "made to fit pi's side as picked");
    expect(find.bySemanticsLabel('Remove image'), findsNWidgets(2));
    expect(find.textContaining('a kind pi does not take'), findsOneWidget, reason: 'the third, said why');
    await tester.runAsync(() => precacheImage(MemoryImage(picture), tester.element(find.byType(ChatScreen))));
    await tester.pump();
    await expectLater(find.byType(ChatScreen), matchesGoldenFile('goldens/attached_light.png'));
    await tester.tap(find.bySemanticsLabel('Remove image').first);
    await tester.pump();
    expect(find.bySemanticsLabel('Remove image'), findsOneWidget);
    sent.clear();
    await tester.tap(find.byKey(const ValueKey('send')));
    await tester.pump();
    final prompt = asked().prompt;
    expect((prompt.text, prompt.images.length, prompt.images.single.mimeType), ('', 1, 'image/png'), reason: 'an image alone is a message');
    expect(find.bySemanticsLabel('Remove image'), findsNothing, reason: 'sent, gone from the box');
    await answer(tester, model, SessionMessage(accepted: Accepted(requestId: prompt.requestId)));
  }, skip: !drawsGoldens);

  testWidgets('a photo taken with the camera, made to fit and sent; one refused, said why', (tester) async {
    final was = ImagePickerPlatform.instance;
    final picker = _Picker([picture]);
    ImagePickerPlatform.instance = picker;
    addTearDown(() => ImagePickerPlatform.instance = was);
    final model = await docs(tester);
    Future<void> take() async {
      await tester.tap(find.bySemanticsLabel('Add an image'));
      await tester.pumpAndSettle();
      expect(find.text('Take a photo'), findsOneWidget);
      if (picker.took == null) await expectLater(find.byType(CupertinoApp), matchesGoldenFile('goldens/add_image_light.png'));
      await tester.tap(find.text('Take a photo'));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
      await tester.pumpAndSettle();
    }

    await take();
    expect(picker.took?.source, ImageSource.camera);
    expect((picker.took?.options.maxWidth, picker.took?.options.maxHeight, picker.took?.options.imageQuality), (2000, 2000, 85), reason: "made to fit pi's side as taken");
    expect(find.bySemanticsLabel('Remove image'), findsOneWidget);
    // Refused the camera: why, and the photos instead.
    picker.refuse = true;
    await take();
    expect(find.textContaining('PiRC may not use the camera'), findsOneWidget);
    expect(find.bySemanticsLabel('Remove image'), findsOneWidget, reason: 'the photo taken stays');
    sent.clear();
    await tester.tap(find.byKey(const ValueKey('send')));
    await tester.pump();
    final prompt = asked().prompt;
    expect((prompt.images.length, prompt.images.single.mimeType), (1, 'image/png'));
    await answer(tester, model, SessionMessage(accepted: Accepted(requestId: prompt.requestId)));
  }, skip: !drawsGoldens);

  testWidgets('a question pi asks, answered from the chat', (tester) async {
    await phone(tester);
    final model = await fixture(tester);
    await tester.pumpWidget(frame(ChatScreen(model: model, id: '0101010101010101-i2')));
    await tester.pump();
    expect(find.text('Overwrite tests/fixtures.json?'), findsOneWidget);
    await expectLater(find.byType(ChatScreen), matchesGoldenFile('goldens/question_light.png'));
    // Yes sends the answer to the session.
    sent.clear();
    await tester.tap(find.text('Yes'));
    await tester.pump();
    final answer = SessionMessage.fromBuffer(sent.single.routed.payload).answer;
    expect((answer.questionId, answer.confirmed), ('q1', true));
    // Unanswered here: its deadline passes.
    await tester.pump(const Duration(seconds: 46));
  }, skip: !drawsGoldens);

  testWidgets('a message sent while pi works steers, unless Queue is chosen', (tester) async {
    await phone(tester);
    final model = await fixture(tester);
    await tester.pumpWidget(frame(ChatScreen(model: model, id: '0101010101010101-i1')));
    await tester.pump();
    await tester.enterText(find.byType(CupertinoTextField), 'and the docs too');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('send')));
    await tester.pump();
    expect(model.pending('0101010101010101-i1').single.delivery, 'steer');
    await tester.pump(const Duration(seconds: 46));
  });

  testWidgets('a message sent while pi works is queued, and shows until pi has it', (tester) async {
    await phone(tester);
    final model = await fixture(tester);
    await tester.pumpWidget(frame(ChatScreen(model: model, id: '0101010101010101-i1')));
    await tester.pump();
    await tester.tap(find.text('Queue'));
    await tester.enterText(find.byType(CupertinoTextField), 'and update the changelog');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('send')));
    await tester.pump();
    expect(model.pending('0101010101010101-i1').single.delivery, 'followUp');
    expect(find.text('Sending'), findsOneWidget);
    await expectLater(find.byType(ChatScreen), matchesGoldenFile('goldens/chat_sending_light.png'));
    // Unanswered, it fails at its deadline, to be retried.
    await tester.pump(const Duration(seconds: 46));
    expect(find.text('Retry'), findsOneWidget);
  }, skip: !drawsGoldens);

  testWidgets('joining and the lock', (tester) async {
    await phone(tester);
    await tester.pumpWidget(frame(JoinScreen(join: (_) async {}, scan: () async => null)));
    await tester.enterText(find.byType(CupertinoTextField), 'https://not-a-link');
    await tester.tap(find.text('Join with the link'));
    await tester.pump();
    expect(find.textContaining('not a PiRC join link'), findsOneWidget);
    await expectLater(find.byType(JoinScreen), matchesGoldenFile('goldens/join_light.png'));
    await tester.pumpWidget(frame(LockScreen(unlock: () {})));
    await expectLater(find.byType(LockScreen), matchesGoldenFile('goldens/lock_light.png'));
  }, skip: !drawsGoldens);

  testWidgets('what the camera is for, before the phone asks for it', (tester) async {
    await phone(tester);
    await tester.pumpWidget(frame(ScanScreen(explained: false, onExplained: () {})));
    expect(find.text('Scan the join code'), findsOneWidget);
    expect(find.textContaining('keeps no picture'), findsOneWidget);
    await expectLater(find.byType(ScanScreen), matchesGoldenFile('goldens/scan_light.png'));
  }, skip: !drawsGoldens);

  testWidgets('the app opens on joining when it has no relay', (tester) async {
    await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: MemoryPrefs(), fontFamily: font));
    await tester.pump();
    expect(find.text('Add this phone'), findsOneWidget);
  });

  testWidgets('a build from source opens without the paywall', (tester) async {
    await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: MemoryPrefs(), subscription: subscriptionFor(TargetPlatform.android), fontFamily: font));
    await tester.pump();
    expect(find.text('Add this phone'), findsOneWidget);
    expect(find.text('Subscribe to PiRC'), findsNothing);
  });

  testWidgets("the iOS notification extension is told when the build has no store, and a store build's clears it", (tester) async {
    final prefs = MemoryPrefs()..set('store.none', 'yes');
    await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: prefs, subscription: FakeStore(const StoreStatus(Access.never)), fontFamily: font));
    await tester.pump();
    expect(await prefs.get('store.none'), isNull);
    await tester.pumpWidget(PircApp(key: const ValueKey('source'), store: MemoryKeyStore(), prefs: prefs, subscription: subscriptionFor(TargetPlatform.iOS), fontFamily: font));
    await tester.pump();
    expect(await prefs.get('store.none'), 'yes');
  });

  group('a join link opened from outside the app', () {
    const channel = MethodChannel('dev.pirc.app/links');
    const first = 'pirc://join?relay=ws%3A%2F%2F127.0.0.1%3A9&token=t1';
    const second = 'pirc://join?relay=ws%3A%2F%2F127.0.0.1%3A9&token=t2';
    Future<void> open(WidgetTester tester, String link) =>
        tester.binding.defaultBinaryMessenger.handlePlatformMessage(channel.name, channel.codec.encodeMethodCall(MethodCall('opened', link)), (_) {});

    testWidgets('fills the join screen, at start and while it runs, and joins only on a tap', (tester) async {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async => call.method == 'launchedWith' ? first : null);
      addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));
      final store = MemoryKeyStore();
      await tester.pumpWidget(PircApp(store: store, prefs: MemoryPrefs(), links: LinkPlatform(), fontFamily: font));
      await tester.pump();
      await tester.pump();
      String field() => tester.widget<CupertinoTextField>(find.byType(CupertinoTextField)).controller!.text;
      expect(field(), first);
      await open(tester, second);
      await tester.pump();
      expect(field(), second);
      expect(find.byType(CupertinoActivityIndicator), findsNothing);
      expect(await store.load('ws://127.0.0.1:9', KeyKind.main), isNull);
    });

    testWidgets('on a phone that has joined, says so and leaves it as it is', (tester) async {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async => null);
      addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));
      const relay = 'ws://127.0.0.1:9';
      final store = MemoryKeyStore();
      await tester.runAsync(() => KeyHolder.create(store, relay, protect: false));
      await tester.pumpWidget(PircApp(store: store, prefs: MemoryPrefs(relay), links: LinkPlatform(), fontFamily: font, protect: false));
      for (var i = 0; i < 5 && find.byType(SessionsScreen).evaluate().isEmpty; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
        await tester.pump();
      }
      await open(tester, first);
      await tester.pumpAndSettle();
      expect(find.text('This phone is already added'), findsOneWidget);
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
      expect(find.byType(SessionsScreen), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(minutes: 31));
    });
  });

  testWidgets('the app opens a chat from its session list', (tester) async {
    const relay = 'ws://127.0.0.1:9';
    final store = MemoryKeyStore();
    await tester.runAsync(() => KeyHolder.create(store, relay, protect: false));
    await tester.pumpWidget(PircApp(store: store, prefs: MemoryPrefs(relay), fontFamily: font));
    for (var i = 0; i < 5 && find.byType(SessionsScreen).evaluate().isEmpty; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
    }
    tester.widget<SessionsScreen>(find.byType(SessionsScreen)).open('0101010101010101-i1');
    await tester.pumpAndSettle();
    expect(find.byType(ChatScreen), findsOneWidget);
    // Closing the app stops its connection; the unlocked key is forgotten
    // after its 30 minutes.
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 31));
  });

  testWidgets('with no private folder to be had, the app starts all the same, keeping no chats', (tester) async {
    const channel = MethodChannel('dev.pirc.app/files');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async => throw PlatformException(code: 'files', message: 'locked'));
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));
    final cache = await keptChats(PrivateFiles());
    expect(cache, isNull);
    const relay = 'ws://127.0.0.1:9';
    final store = MemoryKeyStore();
    await tester.runAsync(() => KeyHolder.create(store, relay, protect: false));
    await tester.pumpWidget(PircApp(store: store, prefs: MemoryPrefs(relay), cache: cache, fontFamily: font));
    for (var i = 0; i < 5 && find.byType(SessionsScreen).evaluate().isEmpty; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
    }
    expect(find.byType(SessionsScreen), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 31));
  });

  testWidgets("on iOS the app names no font, so the system's (San Francisco) applies", (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    try {
      await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: MemoryPrefs()));
      await tester.pump();
      final title = tester.widget<RichText>(find.descendant(of: find.text('Add this phone'), matching: find.byType(RichText)));
      final family = DefaultTextStyle.of(tester.element(find.text('Add this phone'))).style.merge(title.text.style).fontFamily;
      expect(family, startsWith('CupertinoSystem'));
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });

  // Every enabled button on the screen can be pressed by a screen reader,
  // and says what it is: one drawn by hand whose semantics are its own
  // label keeps the tap.
  List<String> deaf(WidgetTester tester) {
    final out = <String>[];
    void visit(SemanticsNode n) {
      final d = n.getSemanticsData();
      if (d.flagsCollection.isButton && d.flagsCollection.isEnabled != ui.Tristate.isFalse && !d.hasAction(SemanticsAction.tap)) out.add(d.label);
      // And says what it is.
      if (d.flagsCollection.isButton && d.label.trim().isEmpty) out.add('unlabelled at ${n.rect}');
      n.visitChildren((c) {
        visit(c);
        return true;
      });
    }

    visit(tester.binding.renderViews.first.owner!.semanticsOwner!.rootSemanticsNode!);
    return out;
  }

  testWidgets('every button answers a screen reader', (tester) async {
    await phone(tester);
    final semantics = tester.ensureSemantics();
    final model = await fixture(tester);
    model.client.onFrame(Frame(pendingHosts: PendingHosts(hosts: [PendingHost(publicKey: List.filled(32, 7), label: 'build-box', firstSeen: ts(now))])));
    await tester.pumpWidget(frame(SessionsScreen(model: model, open: (_) {}, unfolded: const {'h:laptop', 'h:server', 'g:laptop/work'}, settings: () {})));
    await tester.pump();
    expect(deaf(tester), isEmpty, reason: 'the session list');
    await tester.tap(find.bySemanticsLabel('Open laptop'));
    await tester.pumpAndSettle();
    expect(deaf(tester), isEmpty, reason: "a host's page");
    await tester.tap(find.bySemanticsLabel('Open work'));
    await tester.pumpAndSettle();
    expect(deaf(tester), isEmpty, reason: "a group's page");
    // A new app, or the pages pushed above stay over what follows.
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(frame(ChatScreen(model: model, id: '0101010101010101-i1')));
    await tester.pump();
    expect(deaf(tester), isEmpty, reason: 'a chat');
    model.client.onFrame(Frame(keys: Keys(keys: [RegisteredKey(publicKey: List.filled(32, 1), role: Role.ROLE_HOST, label: 'laptop', online: true)])));
    final settings = await PhoneSettings.load(store: MemoryKeyStore(), prefs: MemoryPrefs('ws://127.0.0.1:9'));
    settings.relay = 'ws://127.0.0.1:9';
    final subscribed = ValueNotifier<StoreStatus?>(StoreStatus(Access.allowed, ends: DateTime.utc(2027, 11, 8), renews: true));
    await tester.pumpWidget(frame(SettingsScreen(settings: settings, model: model, subscription: subscribed, manage: () async {})));
    await tester.pumpAndSettle();
    expect(deaf(tester), isEmpty, reason: 'Settings');
    for (final (access, waiting) in [(Access.never, false), (Access.ended, false), (Access.payment, false), (Access.never, true)]) {
      await tester.pumpWidget(frame(PaywallScreen(
        access: access,
        waiting: waiting,
        product: const StoreProduct(price: '£19.99', trial: (count: 2, unit: 'week')),
        buy: () async => Bought.cancelled,
        restore: () async {},
        manage: () async {},
        retry: () async {},
      )));
      await tester.pump();
      expect(deaf(tester), isEmpty, reason: 'the paywall, ${access.name}${waiting ? ', waiting' : ''}');
    }
    await tester.pumpWidget(frame(PaywallScreen(
      access: Access.ended,
      product: const StoreProduct(price: '£19.99'),
      buy: () async => Bought.cancelled,
      restore: () async {},
      manage: () async {},
      retry: () async {},
      storeName: 'Google Play',
      theStore: 'Google Play',
      accountName: 'Google Play account',
      showTerms: false,
      manageWhenEnded: true,
      join: () {},
    )));
    await tester.pump();
    expect(deaf(tester), isEmpty, reason: "Play's paywall, ended");
    await tester.scrollUntilVisible(find.text('Join with a link'), 100, scrollable: find.descendant(of: find.byType(ListView), matching: find.byType(Scrollable)));
    await tester.pumpAndSettle();
    expect(deaf(tester), isEmpty, reason: "Play's paywall, scrolled to Join with a link");
    expect(find.bySemanticsLabel('Join with a link'), findsOneWidget);
    await tester.pumpWidget(frame(JoinScreen(join: (_) async {}, back: () {})));
    await tester.pump();
    expect(deaf(tester), isEmpty, reason: 'the join screen, from the paywall');
    expect(find.bySemanticsLabel('Back'), findsOneWidget);
    semantics.dispose();
  });

  group('the subscription', () {
    const relay = 'ws://127.0.0.1:9';
    const offered = StoreProduct(price: '£19.99', trial: (count: 2, unit: 'week'));
    final trialEnds = DateTime.utc(2026, 11, 22);

    Future<void> settle(WidgetTester tester, Finder until) async {
      for (var i = 0; i < 10 && until.evaluate().isEmpty; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
        await tester.pump();
      }
    }

    // As many rounds, for what should not come.
    Future<void> rounds(WidgetTester tester) => settle(tester, find.byKey(const ValueKey('nothing')));

    for (final b in Brightness.values) {
      testWidgets('the paywall offers the free trial, its terms said, ${b.name}', (tester) async {
        await phone(tester);
        await tester.pumpWidget(frame(
          PaywallScreen(access: Access.never, product: offered, buy: () async => Bought.cancelled, restore: () async {}, manage: () async {}, retry: () async {}),
          brightness: b,
        ));
        await tester.pump();
        expect(find.text('Start your 14-day free trial'), findsOneWidget);
        expect(find.text('Then £19.99 a year'), findsOneWidget, reason: 'the amount billed, prominent');
        expect(find.textContaining('Free for 14 days, then £19.99 a year. Renews every year until cancelled.'), findsOneWidget);
        expect(find.text('Restore purchases'), findsOneWidget);
        expect(find.text('Terms of Use'), findsOneWidget);
        expect(find.text('Privacy Policy'), findsOneWidget);
        await expectLater(find.byType(PaywallScreen), matchesGoldenFile('goldens/paywall_${b.name}.png'));
      }, skip: !drawsGoldens);
    }

    testWidgets('each state of the paywall', (tester) async {
      await phone(tester);
      Future<void> show(Access access, {StoreProduct? product = offered, bool waiting = false}) async {
        await tester.pumpWidget(frame(PaywallScreen(
          access: access,
          product: product,
          waiting: waiting,
          buy: () async => Bought.cancelled,
          restore: () async {},
          manage: () async {},
          retry: () async {},
        )));
        await tester.pump();
      }

      await show(Access.never, product: const StoreProduct(price: '£19.99'));
      expect(find.text('Subscribe to PiRC'), findsOneWidget, reason: 'the trial had already');
      expect(find.textContaining('£19.99 a year. Renews every year until cancelled.'), findsOneWidget);
      await show(Access.ended, product: const StoreProduct(price: '£19.99'));
      expect(find.text('Your subscription has ended'), findsOneWidget);
      expect(find.text('Subscribe'), findsOneWidget);
      await show(Access.payment);
      expect(find.text("There's a problem with your payment"), findsOneWidget);
      expect(find.text('Fix payment'), findsOneWidget);
      await show(Access.never, waiting: true);
      expect(find.text('Waiting for approval'), findsOneWidget);
      expect(find.text('Ask again'), findsOneWidget, reason: 'a request declined, asked again');
      await show(Access.never, product: null);
      expect(find.textContaining("Can't reach the App Store"), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);
      await show(Access.never, product: const StoreProduct(price: '£19.99', trial: (count: 1, unit: 'month')));
      expect(find.text('Start your 1-month free trial'), findsOneWidget);
      expect(find.textContaining('Free for 1 month, then £19.99 a year.'), findsOneWidget);
      await tester.tap(find.text('Restore purchases'));
      await tester.pump();
      expect(find.text('No subscription to restore on this Apple Account.'), findsOneWidget);
    });

    testWidgets("on Android: Google Play named, the privacy policy alone, and Play's page when ended", (tester) async {
      await phone(tester);
      var managed = 0;
      Future<void> show(Access access, {StoreProduct? product = offered}) async {
        await tester.pumpWidget(frame(PaywallScreen(
          access: access,
          product: product,
          buy: () async => Bought.cancelled,
          restore: () async {},
          manage: () async => managed++,
          retry: () async {},
          storeName: 'Google Play',
          theStore: 'Google Play',
          accountName: 'Google Play account',
          showTerms: false,
          manageWhenEnded: true,
        )));
        await tester.pump();
      }

      await show(Access.never);
      expect(find.textContaining('Cancel at any time in your Google Play settings'), findsOneWidget);
      expect(find.text('Terms of Use'), findsNothing);
      expect(find.text('Privacy Policy'), findsOneWidget);
      expect(find.text('Manage subscription'), findsNothing, reason: 'not had');
      await expectLater(find.byType(PaywallScreen), matchesGoldenFile('goldens/paywall_play_light.png'), skip: !drawsGoldens);
      await show(Access.never, product: null);
      expect(find.text("Can't reach Google Play for the price."), findsOneWidget);
      await tester.tap(find.text('Restore purchases'));
      await tester.pump();
      expect(find.text('No subscription to restore on this Google Play account.'), findsOneWidget);
      await show(Access.ended, product: const StoreProduct(price: '£19.99'));
      expect(find.text('Your subscription has ended'), findsOneWidget);
      expect(find.text('Subscribe'), findsOneWidget);
      await tester.tap(find.text('Manage subscription'));
      await tester.pump();
      expect(managed, 1);
      await show(Access.payment);
      expect(find.text('Google Play could not take the last payment. Update your payment details to keep using PiRC.'), findsOneWidget);
      expect(find.text('Manage subscription'), findsNothing, reason: 'Fix payment is it');
    });

    testWidgets('a new phone: the paywall before joining, then the join screen once the trial starts', (tester) async {
      final store = FakeStore(const StoreStatus(Access.never), offered);
      store.onBuy = () => store.now = StoreStatus(Access.allowed, trial: true, ends: trialEnds, renews: true);
      final prefs = MemoryPrefs();
      await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: prefs, subscription: store, fontFamily: font));
      await settle(tester, find.text('Start free trial'));
      expect(find.text('Add this phone'), findsNothing);
      await tester.tap(find.text('Start free trial'));
      await settle(tester, find.text('Add this phone'));
      expect(find.text('Add this phone'), findsOneWidget);
      expect(await prefs.get('store.until'), trialEnds.add(const Duration(days: 3)).millisecondsSinceEpoch.toString());
    });

    testWidgets('a purchase that never answers: its button says so, and the store saying allowed lets the phone in', (tester) async {
      final store = FakeStore(const StoreStatus(Access.never), offered)..answer = Completer();
      await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: MemoryPrefs(), subscription: store, fontFamily: font));
      await settle(tester, find.text('Start free trial'));
      await tester.tap(find.text('Start free trial'));
      await tester.pump();
      // Waiting: still in its colour, its label and a spinner.
      final button = find.ancestor(of: find.text('Start free trial'), matching: find.byType(CupertinoButton));
      expect(button, findsOneWidget);
      expect(tester.widget<CupertinoButton>(button).onPressed, isNull);
      expect(tester.widget<CupertinoButton>(button).disabledColor, Look.light.accent);
      expect(find.descendant(of: button, matching: find.byType(CupertinoActivityIndicator)), findsOneWidget);
      // The trial started, said outside the purchase.
      store.now = StoreStatus(Access.allowed, trial: true, ends: trialEnds, renews: true);
      store.change();
      await settle(tester, find.text('Add this phone'));
      expect(find.text('Add this phone'), findsOneWidget);
      store.answer!.complete(Bought.bought);
      await tester.pump();
    });

    testWidgets('a purchase that never answers: waited for through the store\'s sheets, given up 30 seconds after, its late error said', (tester) async {
      final store = FakeStore(const StoreStatus(Access.never), offered)..answer = Completer();
      await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: MemoryPrefs(), subscription: store, fontFamily: font));
      await settle(tester, find.text('Start free trial'));
      await tester.tap(find.text('Start free trial'));
      await tester.pump();
      final button = find.ancestor(of: find.text('Start free trial'), matching: find.byType(CupertinoButton));
      bool waiting() => tester.widget<CupertinoButton>(button).onPressed == null;
      expect(waiting(), isTrue);
      // Apple's password prompt, however long it is up, then between it
      // and the next.
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump(const Duration(seconds: 40));
      expect(waiting(), isTrue, reason: 'the store is asking');
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump(const Duration(seconds: 20));
      expect(waiting(), isTrue);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump(const Duration(seconds: 29));
      expect(waiting(), isTrue, reason: '30 seconds from the last sheet');
      await tester.pump(const Duration(seconds: 2));
      expect(waiting(), isFalse, reason: 'given up');
      expect(find.descendant(of: button, matching: find.byType(CupertinoActivityIndicator)), findsNothing);
      // Asked again: a second purchase, also unanswered for now; the
      // first's late answer leaves it waiting.
      final first = store.answer!;
      store.answer = Completer();
      await tester.tap(find.text('Start free trial'));
      await tester.pump();
      expect(store.buys, 2);
      first.completeError(PlatformException(code: 'network'));
      await rounds(tester);
      expect(waiting(), isTrue);
      expect(find.textContaining("Can't reach"), findsNothing, reason: 'the older one says nothing');
      // Given up on too, and then failing: said, nothing newer begun.
      await tester.pump(const Duration(seconds: 31));
      expect(waiting(), isFalse);
      store.answer!.completeError(PlatformException(code: 'network'));
      await rounds(tester);
      expect(find.textContaining("Can't reach"), findsOneWidget);
    });

    testWidgets('a purchase that never answers: back in front, the store allowing it, the phone goes in', (tester) async {
      final store = FakeStore(const StoreStatus(Access.never), offered)..answer = Completer();
      await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: MemoryPrefs(), subscription: store, fontFamily: font));
      await settle(tester, find.text('Start free trial'));
      await tester.tap(find.text('Start free trial'));
      await tester.pump();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      store.now = StoreStatus(Access.allowed, trial: true, ends: trialEnds, renews: true);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await settle(tester, find.text('Add this phone'));
      expect(find.text('Add this phone'), findsOneWidget);
      store.answer!.complete(Bought.bought);
      await tester.pump();
    });

    testWidgets('a purchase waiting for approval is said, across a restart, until it is approved', (tester) async {
      final store = FakeStore(const StoreStatus(Access.never), offered)..bought = Bought.pending;
      final prefs = MemoryPrefs();
      await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: prefs, subscription: store, fontFamily: font));
      await settle(tester, find.text('Start free trial'));
      await tester.tap(find.text('Start free trial'));
      await settle(tester, find.text('Waiting for approval'));
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: prefs, subscription: store, fontFamily: font));
      await settle(tester, find.text('Waiting for approval'));
      expect(find.text('Waiting for approval'), findsOneWidget);
      store.now = StoreStatus(Access.allowed, trial: true, ends: trialEnds);
      store.change();
      await settle(tester, find.text('Add this phone'));
      expect(find.text('Add this phone'), findsOneWidget);
      expect(await prefs.buyWaiting(), isFalse);
    });

    testWidgets('a request declined: asked again and given up, no longer waiting', (tester) async {
      final store = FakeStore(const StoreStatus(Access.never), offered)..bought = Bought.pending;
      final prefs = MemoryPrefs();
      await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: prefs, subscription: store, fontFamily: font));
      await settle(tester, find.text('Start free trial'));
      await tester.tap(find.text('Start free trial'));
      await settle(tester, find.text('Ask again'));
      store.bought = Bought.cancelled;
      await tester.tap(find.text('Ask again'));
      await settle(tester, find.text('Start free trial'));
      expect(find.text('Waiting for approval'), findsNothing);
      expect(await prefs.buyWaiting(), isFalse);
    });

    testWidgets('lapsed while Face ID is asked: not connected behind the paywall; allowed again, unlocked', (tester) async {
      final keys = SlowKeyStore();
      await tester.runAsync(() => KeyHolder.create(keys, relay, protect: false));
      final store = FakeStore(StoreStatus(Access.allowed, ends: DateTime.utc(2027, 11, 8), renews: true), offered);
      await tester.pumpWidget(PircApp(store: keys, prefs: MemoryPrefs(relay), subscription: store, fontFamily: font, protect: false));
      await settle(tester, find.byType(LockScreen));
      expect(keys.waiting, isNotNull, reason: 'the key asked for');
      store.now = const StoreStatus(Access.ended);
      store.change();
      await settle(tester, find.text('Your subscription has ended'));
      keys.answer();
      await settle(tester, find.byType(SessionsScreen));
      expect(find.byType(SessionsScreen), findsNothing);
      expect(find.text('Your subscription has ended'), findsOneWidget);
      store.now = StoreStatus(Access.allowed, ends: DateTime.utc(2028, 11, 8), renews: true);
      store.change();
      await settle(tester, find.byType(LockScreen));
      keys.answer();
      await settle(tester, find.byType(SessionsScreen));
      expect(find.byType(SessionsScreen), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(minutes: 31));
    });

    testWidgets('lapsed while open: the paywall in place of the list, nothing deleted; subscribed again, the list', (tester) async {
      final keys = MemoryKeyStore();
      await tester.runAsync(() => KeyHolder.create(keys, relay, protect: false));
      final store = FakeStore(StoreStatus(Access.allowed, ends: DateTime.utc(2027, 11, 8), renews: true), offered);
      final prefs = MemoryPrefs(relay);
      await tester.pumpWidget(PircApp(store: keys, prefs: prefs, subscription: store, fontFamily: font, protect: false));
      await settle(tester, find.byType(SessionsScreen));
      expect(find.byType(SessionsScreen), findsOneWidget);
      store.now = const StoreStatus(Access.ended);
      store.change();
      await settle(tester, find.text('Your subscription has ended'));
      expect(find.byType(SessionsScreen), findsNothing);
      expect(await prefs.get('store.until'), isNull);
      expect(await prefs.relay(), relay);
      expect(await keys.load(relay, KeyKind.main), isNotNull);
      store.now = StoreStatus(Access.allowed, ends: DateTime.utc(2028, 11, 8), renews: true);
      store.change();
      await settle(tester, find.byType(SessionsScreen));
      expect(find.byType(SessionsScreen), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(minutes: 31));
    });

    testWidgets('the store failing at launch: the time the app last saw it allowed, kept', (tester) async {
      final store = FakeStore(const StoreStatus(Access.never), offered)..fails = PlatformException(code: 'network');
      final until = DateTime.now().toUtc().add(const Duration(days: 2));
      final prefs = MemoryPrefs();
      await prefs.setAllowedUntil(until);
      await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: prefs, subscription: store, fontFamily: font));
      await settle(tester, find.text('Add this phone'));
      expect(find.text('Add this phone'), findsOneWidget, reason: 'allowed until then');
      expect(await prefs.allowedUntil(), until.copyWith(microsecond: 0), reason: 'not cleared by a store that did not answer');
      await prefs.setAllowedUntil(null);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: prefs, subscription: store, fontFamily: font));
      await settle(tester, find.text('Try again'));
      expect(find.text('Try again'), findsOneWidget, reason: 'never seen allowed: the paywall, asking again');
    });

    testWidgets('a joined phone that has not subscribed opens on the paywall, not Face ID', (tester) async {
      final keys = MemoryKeyStore();
      // Kept protected, so that asking for it counts.
      await tester.runAsync(() => KeyHolder.create(keys, relay, protect: true));
      final store = FakeStore(const StoreStatus(Access.never), offered);
      await tester.pumpWidget(PircApp(store: keys, prefs: MemoryPrefs(relay), subscription: store, fontFamily: font, protect: false));
      await settle(tester, find.text('Start free trial'));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
      expect(keys.asked, 0, reason: 'Face ID not asked for');
      expect(find.text('Join with a link'), findsNothing, reason: 'it joins one relay');
    });

    testWidgets("the paywall's Join with a link: the join screen, and back", (tester) async {
      final store = FakeStore(const StoreStatus(Access.never), offered);
      await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: MemoryPrefs(), subscription: store, fontFamily: font));
      await settle(tester, find.text('Start free trial'));
      await tester.tap(find.text('Join with a link'));
      await tester.pump();
      expect(find.text('Add this phone'), findsOneWidget);
      await tester.tap(find.text('Back'));
      await tester.pump();
      expect(find.text('Start free trial'), findsOneWidget);
      // Android's back as well.
      await tester.tap(find.text('Join with a link'));
      await tester.pump();
      await tester.binding.handlePopRoute();
      await tester.pump();
      expect(find.text('Start free trial'), findsOneWidget);
    });

    testWidgets('a join link opened while paywalled: the join screen with it, to be joined with a tap', (tester) async {
      const channel = MethodChannel('dev.pirc.app/links');
      const link = 'pirc://join?relay=wss%3A%2F%2Freview.pirc.dev&token=t1';
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async => call.method == 'launchedWith' ? link : null);
      addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));
      final keys = MemoryKeyStore();
      final store = FakeStore(const StoreStatus(Access.ended), offered);
      await tester.pumpWidget(PircApp(store: keys, prefs: MemoryPrefs(), links: LinkPlatform(), subscription: store, fontFamily: font));
      await settle(tester, find.text('Add this phone'));
      expect(tester.widget<CupertinoTextField>(find.byType(CupertinoTextField)).controller!.text, link);
      expect(await keys.load(reviewRelay, KeyKind.main), isNull, reason: 'not joined without a tap');
    });

    testWidgets("joined to the review relay: allowed whatever the store says, its answer kept, and Settings says so", (tester) async {
      final keys = MemoryKeyStore();
      await tester.runAsync(() => KeyHolder.create(keys, reviewRelay, protect: false));
      final store = FakeStore(const StoreStatus(Access.ended), offered);
      final prefs = MemoryPrefs(reviewRelay);
      await tester.pumpWidget(PircApp(store: keys, prefs: prefs, subscription: store, fontFamily: font, protect: false));
      await settle(tester, find.byType(SessionsScreen));
      expect(find.byType(SessionsScreen), findsOneWidget);
      expect(await prefs.get('store.until'), isNull, reason: 'the store said ended, and that is kept');
      // Asked again, as on coming back: still allowed.
      store.change();
      await settle(tester, find.byType(PaywallScreen));
      expect(find.byType(PaywallScreen), findsNothing);
      expect(find.byType(SessionsScreen), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(minutes: 31));
    });

    testWidgets('Settings on the review relay: review access, and the store only when it allows the phone', (tester) async {
      await phone(tester);
      final settings = await PhoneSettings.load(store: MemoryKeyStore(), prefs: MemoryPrefs(reviewRelay));
      settings.relay = reviewRelay;
      final sub = ValueNotifier<StoreStatus?>(const StoreStatus(Access.ended));
      await tester.pumpWidget(frame(SettingsScreen(settings: settings, subscription: sub, manage: () async {})));
      await tester.pump();
      expect(find.text('Review access'), findsOneWidget);
      expect(find.text('PiRC yearly'), findsNothing);
      sub.value = StoreStatus(Access.allowed, ends: DateTime.utc(2027, 11, 8), renews: true);
      await tester.pump();
      expect(find.text('Review access'), findsOneWidget);
      expect(find.text('Renews 8 Nov 2027'), findsOneWidget);
      settings.relay = relay;
      await tester.pumpWidget(frame(SettingsScreen(key: const ValueKey('other'), settings: settings, subscription: sub, manage: () async {})));
      await tester.pump();
      expect(find.text('Review access'), findsNothing, reason: 'another relay');
    });

    testWidgets('Settings: the trial, a renewal, renewal turned off, a failed payment, and without dates', (tester) async {
      await phone(tester);
      final settings = await PhoneSettings.load(store: MemoryKeyStore(), prefs: MemoryPrefs(relay));
      final sub = ValueNotifier<StoreStatus?>(StoreStatus(Access.allowed, trial: true, ends: trialEnds, renews: true));
      await tester.pumpWidget(frame(SettingsScreen(settings: settings, subscription: sub, manage: () async {})));
      await tester.pump();
      expect(find.text('Free trial'), findsOneWidget);
      expect(find.text('Until 22 Nov 2026, then renews yearly'), findsOneWidget);
      expect(find.text('Manage subscription'), findsOneWidget);
      sub.value = StoreStatus(Access.allowed, ends: DateTime.utc(2027, 11, 8), renews: true);
      await tester.pump();
      expect(find.text('Renews 8 Nov 2027'), findsOneWidget);
      sub.value = StoreStatus(Access.allowed, ends: DateTime.utc(2027, 11, 8), renews: false);
      await tester.pump();
      expect(find.text('Ends 8 Nov 2027'), findsOneWidget);
      sub.value = StoreStatus(Access.allowed, graceEnds: DateTime.utc(2026, 12, 8));
      await tester.pump();
      expect(find.textContaining('Fix it by 8 Dec 2026'), findsOneWidget);
      // Google Play gives the phone no dates.
      sub.value = const StoreStatus(Access.allowed, renews: true);
      await tester.pump();
      expect(find.text('Renews every year'), findsOneWidget);
      sub.value = const StoreStatus(Access.allowed, renews: false);
      await tester.pump();
      expect(find.text("Won't renew"), findsOneWidget);
    });
  });

  // The web page's gallery's table, wider than a phone.
  const wideTable = '''| Option | Change | Reconnect | Risk | Effort |
|---|---|--:|---|--:|
| A | Ping every 15 s | ≤ 15 s | More traffic | 1 h |
| B | Replace the old connection on a duplicate | < 1 s | The old tab loses its stream | 3 h |
| C | Resume token | < 1 s | Protocol change | 2 d |''';

  testWidgets('a wide table: its first column held, its edges shaded, and full screen', (tester) async {
    await phone(tester);
    await tester.pumpWidget(frame(CupertinoPageScaffold(child: SafeArea(child: Padding(padding: const EdgeInsets.all(16), child: Markdown(wideTable))))));
    await tester.pump();
    await tester.pump();
    expect(find.text('Full screen'), findsOneWidget, reason: 'wider than the reply');
    final semantics = tester.ensureSemantics();
    await tester.pump();
    expect(deaf(tester), isEmpty, reason: 'a wide table');
    expect(find.byType(ExcludeSemantics), findsWidgets, reason: 'the held column, read once');
    await expectLater(find.byType(CupertinoApp), matchesGoldenFile('goldens/table_wide_light.png'), skip: !drawsGoldens);
    // Scrolled, the rest pass under the first column.
    await tester.drag(find.text('Ping every 15 s').first, const Offset(-200, 0));
    await tester.pumpAndSettle();
    await expectLater(find.byType(CupertinoApp), matchesGoldenFile('goldens/table_scrolled_light.png'), skip: !drawsGoldens);
    // A drag begun on the held column scrolls the rest too.
    final before = tester.getTopLeft(find.text('Ping every 15 s').first).dx;
    await tester.drag(find.text('B').last, const Offset(100, 0));
    await tester.pumpAndSettle();
    expect(tester.getTopLeft(find.text('Ping every 15 s').first).dx, greaterThan(before));
    await tester.tap(find.text('Full screen'));
    await tester.pumpAndSettle();
    expect(find.text('Turn the phone sideways to see more'), findsOneWidget);
    expect(deaf(tester), isEmpty, reason: 'a table full screen');
    await expectLater(find.byType(CupertinoApp), matchesGoldenFile('goldens/table_full_light.png'), skip: !drawsGoldens);
    await tester.tap(find.bySemanticsLabel('Close'));
    await tester.pumpAndSettle();
    expect(find.text('Turn the phone sideways to see more'), findsNothing);
    semantics.dispose();
  });

  testWidgets('a narrow table: nothing held, no full screen', (tester) async {
    await phone(tester);
    await tester.pumpWidget(frame(CupertinoPageScaffold(child: SafeArea(child: Padding(padding: const EdgeInsets.all(16), child: Markdown('| a | b |\n|---|---|\n| 1 | 2 |'))))));
    await tester.pump();
    await tester.pump();
    expect(find.text('Full screen'), findsNothing);
  });

  group('machines asking to join', () {
    // Two hosts asking, the first 2 minutes ago, as the web page's gallery.
    void asking(PircModel model, [int n = 2]) => model.client.onFrame(Frame(pendingHosts: PendingHosts(hosts: [
          PendingHost(publicKey: List.filled(32, 7), label: 'build-box', software: 'pirc-extension/0.1.9', remote: '203.0.113.24:51022', firstSeen: ts(now - 2 * 60000)),
          PendingHost(publicKey: List.filled(32, 9), label: '', software: '', remote: '', firstSeen: ts(now - 50 * 60000)),
        ].take(n))));

    Frame? lastTo(String which) => sent.lastWhere((f) => f.whichBody().name == which, orElse: () => Frame());

    for (final b in Brightness.values) {
      testWidgets('on the list, and the sheet to decide, ${b.name}', (tester) async {
        await phone(tester);
        final model = await fixture(tester);
        asking(model);
        await tester.pumpWidget(frame(SessionsScreen(model: model, open: (_) {}, unfolded: const {'h:laptop'}, settings: () {}), brightness: b));
        await tester.pump();
        expect(find.text('build-box asks to join'), findsOneWidget);
        expect(find.text('A machine asks to join'), findsOneWidget, reason: 'one that gave no name');
        await expectLater(find.byType(SessionsScreen), matchesGoldenFile('goldens/join_requests_${b.name}.png'));
        await tester.tap(find.text('build-box asks to join'));
        await tester.pumpAndSettle();
        expect(find.text('Add this machine?'), findsOneWidget);
        expect(find.text('Asked 2m ago from 203.0.113.24:51022'), findsOneWidget);
        expect(find.text('It runs pirc-extension/0.1.9.'), findsOneWidget);
        await expectLater(find.byType(CupertinoApp), matchesGoldenFile('goldens/approve_${b.name}.png'));
      }, skip: !drawsGoldens);
    }

    testWidgets('approved under a name of its own: the sheet and its line go once the relay says so', (tester) async {
      await phone(tester);
      final model = await fixture(tester);
      asking(model);
      await tester.pumpWidget(frame(SessionsScreen(model: model, open: (_) {}, unfolded: const {})));
      await tester.pump();
      await tester.tap(find.text('build-box asks to join'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(CupertinoTextField).last, '  desk  ');
      await tester.tap(find.text('Approve'));
      await tester.pump();
      final f = lastTo('approveHost')!;
      expect(f.approveHost.publicKey, List.filled(32, 7));
      expect(f.approveHost.label, 'desk');
      expect(find.text('…'), findsOneWidget, reason: 'waiting for the relay');
      model.client.onFrame(Frame(hostDecided: HostDecided(requestId: f.approveHost.requestId)));
      await tester.pump();
      expect(find.text('Add this machine?'), findsOneWidget, reason: 'until the list changes');
      asking(model, 0);
      await tester.pumpAndSettle();
      expect(find.text('Add this machine?'), findsNothing);
      expect(find.text('build-box asks to join'), findsNothing);
    });

    testWidgets('rejected; and a refusal shown, the sheet kept', (tester) async {
      await phone(tester);
      final model = await fixture(tester);
      asking(model);
      await tester.pumpWidget(frame(SessionsScreen(model: model, open: (_) {}, unfolded: const {})));
      await tester.pump();
      await tester.tap(find.text('A machine asks to join'));
      await tester.pumpAndSettle();
      expect(find.text('Asked 50m ago'), findsOneWidget, reason: 'no address given');
      await tester.tap(find.text('Approve'));
      await tester.pump();
      final f = lastTo('approveHost')!;
      expect(f.approveHost.label, '', reason: 'empty keeps the name it asked with');
      model.client.onFrame(Frame(error: Error(requestId: f.approveHost.requestId, code: ErrorCode.ERROR_CODE_INVALID, message: 'no host awaiting approval has that key')));
      await tester.pump();
      await tester.pump();
      expect(find.text('no host awaiting approval has that key'), findsOneWidget);
      expect(find.text('Approve'), findsOneWidget, reason: 'to try again');
      await tester.tap(find.text('Reject'));
      await tester.pump();
      final r = lastTo('rejectHost')!;
      expect(r.rejectHost.publicKey, List.filled(32, 9));
      expect(find.text('no host awaiting approval has that key'), findsNothing);
      model.client.onFrame(Frame(hostDecided: HostDecided(requestId: r.rejectHost.requestId)));
      asking(model, 1);
      await tester.pumpAndSettle();
      expect(find.text('Add this machine?'), findsNothing);
      expect(find.text('A machine asks to join'), findsNothing);
      expect(find.text('build-box asks to join'), findsOneWidget);
    });

    testWidgets('gone while the sheet closes, or with a screen over it: only the sheet goes', (tester) async {
      await phone(tester);
      final model = await fixture(tester);
      asking(model);
      await tester.pumpWidget(frame(SessionsScreen(model: model, open: (_) {}, unfolded: const {})));
      await tester.pump();
      NavigatorState nav() => tester.state<NavigatorState>(find.byType(Navigator).first);
      // Dismissed, and decided elsewhere mid-animation.
      await tester.tap(find.text('build-box asks to join'));
      await tester.pumpAndSettle();
      nav().pop();
      await tester.pump(const Duration(milliseconds: 100));
      asking(model, 0);
      await tester.pumpAndSettle();
      expect(find.byType(SessionsScreen), findsOneWidget, reason: 'the list stays');
      // A screen opened over it, as a notification's chat is.
      asking(model);
      await tester.pump();
      await tester.tap(find.text('build-box asks to join'));
      await tester.pumpAndSettle();
      nav().push(CupertinoPageRoute<void>(builder: (_) => const CupertinoPageScaffold(child: Text('over it'))));
      await tester.pumpAndSettle();
      asking(model, 0);
      await tester.pumpAndSettle();
      expect(find.text('over it'), findsOneWidget, reason: 'what is over it stays');
      nav().pop();
      await tester.pumpAndSettle();
      expect(find.byType(DecideSheet), findsNothing);
      expect(find.byType(SessionsScreen), findsOneWidget);
    });

    testWidgets('decided elsewhere while its sheet is open: it closes', (tester) async {
      await phone(tester);
      final model = await fixture(tester);
      asking(model);
      await tester.pumpWidget(frame(SessionsScreen(model: model, open: (_) {}, unfolded: const {})));
      await tester.pump();
      await tester.tap(find.text('build-box asks to join'));
      await tester.pumpAndSettle();
      model.client.onFrame(Frame(pendingHosts: PendingHosts(hosts: [PendingHost(publicKey: List.filled(32, 9), firstSeen: ts(now))])));
      await tester.pumpAndSettle();
      expect(find.text('Add this machine?'), findsNothing);
      expect(find.text('A machine asks to join'), findsOneWidget);
    });
  });

  group("the relay's hosts and clients, in Settings", () {
    late List<Frame> out;
    RegisteredKey key(int b, Role role, String label, {bool online = true, bool push = false}) =>
        RegisteredKey(publicKey: List.filled(32, b), role: role, label: label, addedAt: ts(now - 10 * 86400000), online: online, push: push);
    final all = [
      key(1, Role.ROLE_HOST, 'laptop'),
      key(2, Role.ROLE_HOST, 'build-box', online: false),
      key(4, Role.ROLE_CLIENT, 'web'),
      key(3, Role.ROLE_CLIENT, 'iphone', push: true),
      key(5, Role.ROLE_CLIENT, 'pixel', online: false),
    ];

    // Settings for a phone whose key is the 3s, on a relay listing all.
    Future<PircModel> open(WidgetTester tester, {Brightness brightness = Brightness.light, bool ready = true}) async {
      out = [];
      var n = 0;
      final model = PircModel(send: (f) {
        out.add(f);
        return true;
      }, newId: () => 'd-${++n}', now: () => now, publicKey: List.filled(32, 3));
      model.client.onState(RelayView(state: ready ? 'ready' : 'offline', reason: ready ? null : 'no network'));
      model.client.onFrame(Frame(keys: Keys(keys: all)));
      final settings = await PhoneSettings.load(store: MemoryKeyStore(), prefs: MemoryPrefs('ws://127.0.0.1:9'));
      settings.relay = 'wss://relay.example:8443';
      await tester.pumpWidget(frame(SettingsScreen(settings: settings, model: model), brightness: brightness));
      await tester.pumpAndSettle();
      return model;
    }

    Frame sentOf(String which) => out.lastWhere((f) => f.whichBody().name == which);

    for (final b in Brightness.values) {
      testWidgets('listed, ${b.name}', (tester) async {
        tester.view.physicalSize = const Size(390 * 3, 1100 * 3);
        tester.view.devicePixelRatio = 3;
        addTearDown(tester.view.reset);
        await open(tester, brightness: b);
        expect(find.text('This phone'), findsOneWidget, reason: 'first among the clients');
        expect(find.text('Online · Notifications on · key AwMDAwMD…'), findsOneWidget);
        expect(find.text('Offline · key AgICAgIC…'), findsOneWidget);
        await expectLater(find.byType(SettingsScreen), matchesGoldenFile('goldens/settings_devices_${b.name}.png'));
      }, skip: !drawsGoldens);
    }

    testWidgets('a host renamed, the sheet closing once the relay has it', (tester) async {
      await phone(tester);
      final model = await open(tester);
      await tester.ensureVisible(find.text('build-box'));
      await tester.tap(find.text('build-box'));
      await tester.pumpAndSettle();
      expect(find.text('This host'), findsOneWidget);
      expect(find.text('Added ${day(now - 10 * 86400000, false)}, 2026'), findsOneWidget);
      await tester.enterText(find.descendant(of: find.byType(DeviceSheet), matching: find.byType(CupertinoTextField)), ' ci-box ');
      await tester.tap(find.text('Save'));
      await tester.pump();
      final f = sentOf('renameKey');
      expect(f.renameKey.publicKey, List.filled(32, 2));
      expect(f.renameKey.label, 'ci-box');
      model.client.onFrame(Frame(keyChanged: KeyChanged(requestId: f.renameKey.requestId)));
      await tester.pumpAndSettle();
      expect(find.byType(DeviceSheet), findsNothing);
    });

    testWidgets('an app removed after Remove? / Back / Remove; a refusal said', (tester) async {
      await phone(tester);
      final model = await open(tester);
      await tester.ensureVisible(find.text('pixel'));
      await tester.tap(find.text('pixel'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Remove this app'));
      await tester.pumpAndSettle();
      expect(find.text('Remove pixel?'), findsOneWidget);
      expect(find.textContaining('signed out of the relay'), findsOneWidget);
      await tester.tap(find.text('Back'));
      await tester.pumpAndSettle();
      expect(find.text('This app'), findsOneWidget);
      await tester.tap(find.text('Remove this app'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Remove'));
      await tester.pump();
      var f = sentOf('removeKey');
      expect(f.removeKey.publicKey, List.filled(32, 5));
      model.client.onFrame(Frame(error: Error(requestId: f.removeKey.requestId, code: ErrorCode.ERROR_CODE_INVALID, message: 'no such key')));
      await tester.pump();
      await tester.pump();
      expect(find.text('no such key'), findsOneWidget);
      await tester.tap(find.text('Remove'));
      await tester.pump();
      f = sentOf('removeKey');
      model.client.onFrame(Frame(keys: Keys(keys: all.where((k) => k.label != 'pixel'))));
      model.client.onFrame(Frame(keyChanged: KeyChanged(requestId: f.removeKey.requestId)));
      await tester.pumpAndSettle();
      expect(find.byType(DeviceSheet), findsNothing);
      expect(find.text('pixel'), findsNothing);
    });

    testWidgets("this phone's own row renames, and has no Remove", (tester) async {
      await phone(tester);
      await open(tester);
      await tester.ensureVisible(find.text('This phone'));
      await tester.tap(find.text('This phone'));
      await tester.pumpAndSettle();
      expect(find.descendant(of: find.byType(DeviceSheet), matching: find.text('This phone')), findsOneWidget);
      expect(find.text('Remove this app'), findsNothing);
      expect(tester.widget<CupertinoTextField>(find.descendant(of: find.byType(DeviceSheet), matching: find.byType(CupertinoTextField))).controller!.text, 'iphone');
    });

    testWidgets('a host removed elsewhere while its sheet is open: it closes', (tester) async {
      await phone(tester);
      final model = await open(tester);
      await tester.tap(find.text('laptop'));
      await tester.pumpAndSettle();
      model.client.onFrame(Frame(keys: Keys(keys: all.where((k) => k.label != 'laptop'))));
      await tester.pumpAndSettle();
      expect(find.byType(DeviceSheet), findsNothing);
      expect(find.byType(SettingsScreen), findsOneWidget);
    });

    testWidgets('an app added: a one-time link and its QR code, copied as a secret, until it expires', (tester) async {
      await phone(tester);
      final copied = <(String, int?)>[];
      final secured = <bool>[];
      var clock = now;
      out = [];
      final model = PircModel(send: (f) {
        out.add(f);
        return true;
      }, newId: () => 'i-1', now: () => clock, publicKey: List.filled(32, 3));
      model.client.onState(const RelayView(state: 'ready'));
      model.client.onFrame(Frame(keys: Keys(keys: all)));
      await tester.pumpWidget(frame(InviteSheet(
        model: model,
        relay: 'wss://relay.example:8443',
        role: 'client',
        copy: (text, {expiresAt}) async => copied.add((text, expiresAt)),
        secure: (on) async => secured.add(on),
      )));
      await tester.pump();
      expect(find.text('With a one-time token, valid for 15 minutes'), findsOneWidget);
      await tester.enterText(find.byType(CupertinoTextField), ' ipad ');
      await tester.tap(find.text('Make a token'));
      await tester.pump();
      final f = sentOf('issueToken');
      expect(f.issueToken.role, Role.ROLE_CLIENT);
      expect(f.issueToken.label, 'ipad');
      final expires = now + 15 * 60000;
      model.client.onFrame(Frame(tokenIssued: TokenIssued(requestId: f.issueToken.requestId, token: 'tok+/en=', expiresAt: ts(expires))));
      await tester.pump();
      await tester.pump();
      expect(secured, [true], reason: 'kept out of snapshots while it shows');
      final end = DateTime.fromMillisecondsSinceEpoch(expires);
      expect(find.text('Valid until ${(end.hour + 11) % 12 + 1}:${end.minute.toString().padLeft(2, '0')} ${end.hour < 12 ? 'AM' : 'PM'}, for one app'), findsOneWidget,
          reason: "the phone's 12-hour clock");
      expect(find.byType(QrView), findsOneWidget);
      final link = tester.widget<QrView>(find.byType(QrView)).text;
      expect(find.text(link), findsOneWidget, reason: 'the link beside it');
      final parsed = parseJoinLink(link)!;
      expect((parsed.relay, parsed.token), ('wss://relay.example:8443', 'tok+/en='), reason: 'as the app reads it');
      await expectLater(find.byType(CupertinoApp), matchesGoldenFile('goldens/invite_light.png'), skip: !drawsGoldens);
      await tester.tap(find.text('Copy'));
      await tester.pump();
      expect(copied.single, (link, expires), reason: 'gone from the clipboard when it expires');
      expect(find.text('Copied'), findsOneWidget);
      await tester.pump(const Duration(seconds: 2));
      expect(find.text('Copy'), findsOneWidget);
      clock = expires;
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('The token has expired'), findsOneWidget);
      expect(find.byType(QrView), findsNothing);
      expect(find.text(link), findsNothing, reason: 'no longer shown');
      expect(secured, [true, false], reason: 'expired: nothing left to hide');
      await tester.tap(find.text('Done'));
      await tester.pumpAndSettle();
      expect(secured, [true, false]);
    });

    testWidgets('a host added: the /pirc enrol line; a refusal said', (tester) async {
      await phone(tester);
      out = [];
      final model = PircModel(send: (f) {
        out.add(f);
        return true;
      }, newId: () => 'i-2', now: () => now, publicKey: List.filled(32, 3));
      model.client.onState(const RelayView(state: 'ready'));
      final secured = <bool>[];
      await tester.pumpWidget(frame(InviteSheet(model: model, relay: 'wss://relay.example:8443', role: 'host', copy: (_, {expiresAt}) async {}, secure: (on) async => secured.add(on))));
      await tester.pump();
      expect(find.text('Add a host'), findsOneWidget);
      await tester.tap(find.text('Make a token'));
      await tester.pump();
      var f = sentOf('issueToken');
      expect(f.issueToken.role, Role.ROLE_HOST);
      expect(f.issueToken.label, '', reason: 'its own, if left empty');
      model.client.onFrame(Frame(error: Error(requestId: f.issueToken.requestId, code: ErrorCode.ERROR_CODE_INVALID, message: 'label too long')));
      await tester.pump();
      await tester.pump();
      expect(find.text('label too long'), findsOneWidget);
      expect(secured, isEmpty, reason: 'no token, nothing to hide');
      await tester.tap(find.text('Make a token'));
      await tester.pump();
      f = sentOf('issueToken');
      model.client.onFrame(Frame(tokenIssued: TokenIssued(requestId: f.issueToken.requestId, token: 'T0KEN', expiresAt: ts(now + 15 * 60000))));
      await tester.pump();
      await tester.pump();
      expect(find.text('/pirc enrol wss://relay.example:8443 T0KEN'), findsOneWidget);
      expect(find.byType(QrView), findsNothing);
      expect(secured, [true]);
      // Gone while it showed, as on a relock.
      await tester.pumpWidget(const SizedBox());
      expect(secured, [true, false], reason: 'closed while it showed: the screen as it was');
    });

    testWidgets('out of reach of the relay: said so', (tester) async {
      await phone(tester);
      await open(tester, ready: false);
      expect(find.text('Not connected to the relay.'), findsNWidgets(2));
    });
  });

  group('Settings', () {
    const relay = 'ws://127.0.0.1:9';
    late MemoryPrefs prefs;
    late List<String> calls;
    late String permission;
    var resynced = 0;

    // The phone's push, answering as told and noting what it was asked.
    PushPlatform push(WidgetTester tester) {
      const channel = MethodChannel('test/settings-push');
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call.method);
        switch (call.method) {
          case 'permission':
            return permission;
          case 'ask':
            permission = 'granted';
            return true;
        }
        return null;
      });
      addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));
      return PushPlatform(channel);
    }

    // Settings for a phone joined with store's key, unlocked, over the list.
    Future<PhoneSettings> open(WidgetTester tester, MemoryKeyStore store, {bool protect = true, Brightness brightness = Brightness.light}) async {
      final keys = await tester.runAsync(() => KeyHolder.create(store, relay, protect: protect));
      final s = await PhoneSettings.load(store: store, prefs: prefs, push: push(tester), resync: () => resynced++);
      s
        ..relay = relay
        ..key = keys!.main;
      await tester.pumpWidget(frame(SettingsScreen(settings: s), brightness: brightness));
      await tester.pumpAndSettle();
      return s;
    }

    Finder switchOf(String label) => find.descendant(of: find.ancestor(of: find.text(label), matching: find.byType(Row)).first, matching: find.byType(CupertinoSwitch));

    setUp(() {
      prefs = MemoryPrefs(relay);
      calls = [];
      permission = 'granted';
      resynced = 0;
    });

    for (final b in Brightness.values) {
      testWidgets('this phone, ${b.name}', (tester) async {
        await phone(tester);
        await open(tester, MemoryKeyStore(), brightness: b);
        expect(find.text('Lock with Face ID'), findsOneWidget);
        expect(find.text('Ask again after'), findsOneWidget);
        expect(find.text('30 min'), findsOneWidget);
        expect(tester.widget<CupertinoSwitch>(switchOf('Notifications')).value, isTrue);
        await expectLater(find.byType(SettingsScreen), matchesGoldenFile('goldens/settings_${b.name}.png'));
      }, skip: !drawsGoldens);
    }

    testWidgets('the lock turned off asks once and keeps the key unprotected; on again protects it', (tester) async {
      final store = MemoryKeyStore();
      final s = await open(tester, store);
      await tester.tap(switchOf('Lock with Face ID'));
      await tester.pumpAndSettle();
      expect(store.asked, 1);
      expect(store.protected(relay), isFalse);
      expect(await prefs.locks(), isFalse);
      expect(s.lock, isFalse);
      expect(find.text('Off: PiRC opens without asking.'), findsOneWidget);
      expect(find.text('Ask again after'), findsNothing, reason: 'nothing to ask again');
      await tester.tap(switchOf('Lock with Face ID'));
      await tester.pumpAndSettle();
      expect(store.asked, 1, reason: 'locking asks no one on iOS');
      expect(store.protected(relay), isTrue);
      expect(await prefs.locks(), isTrue);
      expect(find.text('Ask again after'), findsOneWidget);
    });

    testWidgets('turning the lock off, declined: it stays on', (tester) async {
      final store = MemoryKeyStore();
      await open(tester, store);
      store.decline = true;
      await tester.tap(switchOf('Lock with Face ID'));
      await tester.pumpAndSettle();
      expect(store.protected(relay), isTrue);
      expect(await prefs.locks(), isTrue);
      expect(tester.widget<CupertinoSwitch>(switchOf('Lock with Face ID')).value, isTrue);
    });

    testWidgets('turning the lock on with no passcode: it stays off, the key kept, saying why', (tester) async {
      await prefs.setLocks(false);
      final store = _NoPasscode();
      await open(tester, store, protect: false);
      await tester.tap(switchOf('Lock with Face ID'));
      await tester.pumpAndSettle();
      expect(find.text('Set a passcode on this phone to lock PiRC'), findsOneWidget);
      expect(store.protected(relay), isFalse, reason: 'kept again as it was');
      expect(await prefs.locks(), isFalse);
    });

    testWidgets("the licences, with the app's name and version", (tester) async {
      await phone(tester);
      LicenseRegistry.addLicense(() => Stream.value(const LicenseEntryWithLineBreaks(['qr'], 'Copyright 2014, the Dart QR project authors.')));
      final s = await PhoneSettings.load(store: MemoryKeyStore(), prefs: prefs);
      await tester.pumpWidget(frame(SettingsScreen(settings: s, version: () async => '1.0.0 (3)')));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Licences'));
      await tester.tap(find.text('Licences'));
      await tester.pumpAndSettle();
      expect(find.byType(LicensePage), findsOneWidget);
      expect(find.text('PiRC'), findsWidgets);
      expect(find.text('1.0.0 (3)'), findsOneWidget);
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
      await tester.pumpAndSettle();
      expect(find.text('qr'), findsOneWidget, reason: "a package's licence listed");
    });

    testWidgets('how long it holds is chosen and kept', (tester) async {
      await phone(tester);
      final s = await open(tester, MemoryKeyStore());
      await tester.tap(find.text('5 min'));
      await tester.pump();
      expect(s.hold, const Duration(minutes: 5));
      expect(await prefs.hold(), const Duration(minutes: 5));
      await tester.tap(find.text('Every time'));
      await tester.pump();
      expect(await prefs.hold(), Duration.zero);
    });

    testWidgets('notifications turned off here are unregistered at the relay; on again, registered', (tester) async {
      await open(tester, MemoryKeyStore());
      await tester.tap(switchOf('Notifications'));
      await tester.pumpAndSettle();
      expect(await prefs.notifies(), isFalse);
      expect(resynced, 1);
      await tester.tap(switchOf('Notifications'));
      await tester.pumpAndSettle();
      expect(await prefs.notifies(), isTrue);
      expect(resynced, 2);
      expect(calls, isNot(contains('ask')), reason: 'already allowed');
    });

    testWidgets('notifications never asked for: turning them on asks the phone', (tester) async {
      permission = 'undetermined';
      await open(tester, MemoryKeyStore());
      expect(tester.widget<CupertinoSwitch>(switchOf('Notifications')).value, isFalse);
      expect(find.text('When a turn ends or pi asks.'), findsOneWidget, reason: 'not refused, only not yet asked');
      expect(find.text("Open the phone's Settings"), findsNothing);
      await tester.tap(switchOf('Notifications'));
      await tester.pumpAndSettle();
      expect(calls, contains('ask'));
      expect(tester.widget<CupertinoSwitch>(switchOf('Notifications')).value, isTrue);
      expect(resynced, 1);
    });

    testWidgets("notifications refused by the phone: said so, with the way to its Settings", (tester) async {
      permission = 'denied';
      await open(tester, MemoryKeyStore());
      expect(tester.widget<CupertinoSwitch>(switchOf('Notifications')).value, isFalse);
      expect(tester.widget<CupertinoSwitch>(switchOf('Notifications')).onChanged, isNull, reason: 'turned on only there');
      expect(find.text("Off for PiRC in the phone's Settings."), findsOneWidget);
      await tester.tap(find.text("Open the phone's Settings"));
      await tester.pump();
      expect(calls, contains('settings'));
      // Allowed there, and back.
      permission = 'granted';
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(tester.widget<CupertinoSwitch>(switchOf('Notifications')).value, isTrue);
      expect(find.text("Open the phone's Settings"), findsNothing);
    });

    // The app with a protected key, asking "every time"; open on its list.
    Future<MemoryKeyStore> app(WidgetTester tester) async {
      final store = MemoryKeyStore();
      await tester.runAsync(() => KeyHolder.create(store, relay, protect: true));
      await prefs.setHold(Duration.zero);
      await tester.pumpWidget(PircApp(store: store, prefs: prefs, fontFamily: font));
      for (var i = 0; i < 5 && find.byType(SessionsScreen).evaluate().isEmpty; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
        await tester.pump();
      }
      expect(find.byType(SessionsScreen), findsOneWidget);
      return store;
    }

    Future<void> away(WidgetTester tester) async {
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      for (var i = 0; i < 3; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
        await tester.pump();
      }
    }

    testWidgets('the app locks again after its hold, and unlocks as on opening', (tester) async {
      final store = await app(tester);
      expect(store.asked, 1);
      await tester.tap(find.bySemanticsLabel('Settings'));
      await tester.pumpAndSettle();
      expect(find.byType(SettingsScreen), findsOneWidget);
      store.decline = true;
      await away(tester);
      await tester.pumpAndSettle();
      expect(find.text('PiRC is locked'), findsOneWidget);
      expect(find.byType(SettingsScreen), findsNothing, reason: 'what was open goes with the key');
      store.decline = false;
      await tester.tap(find.text('Unlock'));
      for (var i = 0; i < 3; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
        await tester.pump();
      }
      expect(find.byType(SessionsScreen), findsOneWidget);
      expect(store.asked, 3);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a trip to the photo picker is not leaving; with the lock off, nothing locks', (tester) async {
      final store = await app(tester);
      await goingOutside(() => away(tester));
      expect(find.byType(SessionsScreen), findsOneWidget);
      expect(store.asked, 1);
      await prefs.setLocks(false);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(PircApp(store: store, prefs: prefs, fontFamily: font));
      for (var i = 0; i < 5 && find.byType(SessionsScreen).evaluate().isEmpty; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
        await tester.pump();
      }
      final asked = store.asked;
      await away(tester);
      expect(find.byType(SessionsScreen), findsOneWidget);
      expect(store.asked, asked);
      await tester.pumpWidget(const SizedBox());
    });
  });

  test(goldensSkip, () {}, skip: drawsGoldens ? 'golden images drawn here' : goldensSkip);
}

// A phone with no passcode, which keeps no key protected.
class _NoPasscode extends MemoryKeyStore {
  @override
  Future<void> store(String relay, KeyKind kind, Uint8List seed, {required bool protect}) async {
    if (protect) throw const KeyUnavailable('Set a passcode on this phone to lock PiRC');
    await super.store(relay, kind, seed, protect: protect);
  }
}

// The phone's photo picker, handing over the pictures given.
class _Picker extends ImagePickerPlatform {
  _Picker(this.pictures);
  final List<Uint8List> pictures;
  MultiImagePickerOptions? asked;
  ({ImageSource source, ImagePickerOptions options})? took;
  // The camera refused, as by the phone's settings.
  bool refuse = false;

  @override
  Future<XFile?> getImageFromSource({required ImageSource source, ImagePickerOptions options = const ImagePickerOptions()}) async {
    took = (source: source, options: options);
    if (refuse) throw PlatformException(code: 'camera_access_denied', message: 'The user did not allow camera access.');
    return XFile.fromData(pictures.first);
  }

  @override
  Future<List<XFile>> getMultiImageWithOptions({MultiImagePickerOptions options = const MultiImagePickerOptions()}) async {
    asked = options;
    return [for (final p in pictures) XFile.fromData(p)];
  }
}

// A store that answers as the test sets it, and tells of a change when
// asked.
class FakeStore implements Store {
  FakeStore(this.now, [this._product]);

  StoreStatus now;
  final StoreProduct? _product;
  Bought bought = Bought.bought;
  // What status throws instead of answering, as Play may.
  Object? fails;
  void Function()? onBuy;
  // Buying answers only when this does, if ever, as StoreKit's purchase
  // did once on TestFlight after asking for the password twice.
  Completer<Bought>? answer;
  var buys = 0;
  final _changed = StreamController<void>.broadcast();

  void change() => _changed.add(null);

  @override
  Stream<void> get changed => _changed.stream;
  @override
  Future<StoreStatus> status() async => fails == null ? now : throw fails!;
  @override
  Future<StoreProduct?> product() async => _product;
  @override
  Future<Bought> buy() async {
    buys++;
    onBuy?.call();
    return answer?.future ?? bought;
  }

  @override
  Future<void> restore() async {}
  @override
  Future<void> manage() async {}
}

// A key store whose main key comes only when the test answers, as Face ID
// does when the person looks.
class SlowKeyStore extends MemoryKeyStore {
  Completer<void>? waiting;

  void answer() {
    waiting?.complete();
    waiting = null;
  }

  @override
  Future<Uint8List?> load(String relay, KeyKind kind, {String reason = ''}) async {
    if (kind == KeyKind.main) await (waiting = Completer<void>()).future;
    return super.load(relay, kind, reason: reason);
  }
}
