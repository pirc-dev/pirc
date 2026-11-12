// The app's shell: the paywall while the store does not allow this phone,
// join when there is no relay, unlock the main key, then the session list
// and chats over a live relay connection, closed while the app is in the
// background so that the relay wakes it by push.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart' show DefaultMaterialLocalizations;
import 'package:flutter/services.dart';

import '../core/view.dart';
import '../join.dart';
import '../keys/key_holder.dart';
import '../keys/key_store.dart';
import '../relay/connection.dart';
import '../relay/keys.dart';
import '../ui/chat_screen.dart';
import '../ui/join_screen.dart';
import '../ui/lock_screen.dart';
import '../ui/notify_screen.dart';
import '../ui/paywall_screen.dart';
import '../ui/scan_screen.dart';
import '../ui/look.dart';
import '../push/notifications.dart';
import '../push/push.dart';
import '../ui/sessions_screen.dart';
import '../ui/settings_screen.dart';
import 'chat_cache.dart';
import 'drafts.dart';
import 'links.dart';
import 'model.dart';
import 'outside.dart';
import 'settings.dart';
import 'store.dart';

// What the app keeps besides its keys, by key: on iOS in the App Group's
// defaults, which the notification extension reads ("relay", "notices.v1");
// on Android in a file out of backups.
abstract class AppPrefs {
  Future<String?> get(String key);
  Future<void> set(String key, String? value);

  // The relay it joined.
  Future<String?> relay() => get('relay');
  Future<void> setRelay(String? relay) => set('relay', relay);

  // The hosts and groups open in the session list; all start closed.
  Future<Set<String>> unfolded() async {
    try {
      final v = await get('unfolded');
      return v == null ? {} : {...(jsonDecode(v) as List).cast<String>()};
    } on FormatException {
      return {};
    }
  }

  Future<void> setUnfolded(Set<String> keys) => set('unfolded', jsonEncode([...keys]));

  // Whether what the camera is for has been said, before the system first
  // asks for it.
  Future<bool> cameraExplained() async => await get('camera') != null;
  Future<void> setCameraExplained() => set('camera', 'explained');

  // Whether what notifications are for has been said, before the system
  // asks.
  Future<bool> notificationsExplained() async => await get('notifications') != null;
  Future<void> setNotificationsExplained() => set('notifications', 'explained');

  // What was last shown, as PircNotices reads it.
  Future<Shown> notices() async => Shown.parse(await get('notices.v1'));
  Future<void> setNotices(Shown shown) => set('notices.v1', jsonEncode(shown.toJson()));

  // The token last registered with the relay, through the gateway.
  Future<PushToken?> pushed() async {
    final v = await get('push');
    if (v == null) return null;
    return PushToken.fromJson(jsonDecode(v) as Map<String, Object?>);
  }

  Future<void> setPushed(PushToken? t) => set('push', t == null ? null : jsonEncode(t.toJson()));

  // Settings: the lock, on unless turned off; how long an unlocked key is
  // held, 30 minutes unless changed; and notifications, on unless turned
  // off.
  Future<bool> locks() async => await get('lock') != 'off';
  Future<void> setLocks(bool on) => set('lock', on ? null : 'off');
  Future<Duration> hold() async => Duration(minutes: int.tryParse(await get('hold') ?? '') ?? 30);
  Future<void> setHold(Duration d) => set('hold', '${d.inMinutes}');
  Future<bool> notifies() async => await get('notify') != 'off';
  Future<void> setNotifies(bool on) => set('notify', on ? null : 'off');

  // A purchase waiting for approval (Ask to Buy, or the bank's own check),
  // which the store does not say, for the paywall to say across restarts.
  Future<bool> buyWaiting() async => await get('store.waiting') != null;
  Future<void> setBuyWaiting(bool waiting) => set('store.waiting', waiting ? 'yes' : null);

  // Until when notifications may show what happened while the store does
  // not answer the notification extension (or on Android the wake) itself
  // (ms since the epoch).
  Future<DateTime?> allowedUntil() async {
    final ms = int.tryParse(await get('store.until') ?? '');
    return ms == null ? null : DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true);
  }

  Future<void> setAllowedUntil(DateTime? until) => set('store.until', until?.millisecondsSinceEpoch.toString());

  // That this build has no subscription, a build from source's
  // (store.dart's storeBuild), for the iOS notification extension, which
  // is built apart from the app and would otherwise ask StoreKit.
  Future<void> setNoStore(bool none) => set('store.none', none ? 'yes' : null);
}

// The platform's, over a channel (packages/pirc_platform).
class ChannelPrefs extends AppPrefs {
  ChannelPrefs([this.channel = const MethodChannel('dev.pirc.app/prefs')]);

  final MethodChannel channel;

  @override
  Future<String?> get(String key) => channel.invokeMethod<String>('get', {'key': key});
  @override
  Future<void> set(String key, String? value) => channel.invokeMethod('set', {'key': key, 'value': value});
}

class MemoryPrefs extends AppPrefs {
  MemoryPrefs([String? relay, Set<String>? unfolded]) {
    if (relay != null) _values['relay'] = relay;
    if (unfolded != null) _values['unfolded'] = jsonEncode([...unfolded]);
  }

  final _values = <String, String>{};

  @override
  Future<String?> get(String key) async => _values[key];
  @override
  Future<void> set(String key, String? value) async => value == null ? _values.remove(key) : _values[key] = value;
}

class PircApp extends StatefulWidget {
  const PircApp({super.key, required this.store, required this.prefs, this.cache, this.drafts, this.scan, this.camera = false, this.protect = true, this.push, this.links, this.subscription, this.fontFamily});

  final KeyStore store;
  final AppPrefs prefs;
  final ChatCache? cache;
  // What is being written in each chat; none kept when absent.
  final Drafts? drafts;
  final Future<String?> Function()? scan;
  // Scanning with the camera (ScanScreen), when no scan is given.
  final bool camera;
  // Whether the main key may ask for Face ID or the passcode; false in
  // tests, which keep it unprotected whatever Settings says.
  final bool protect;
  // Notifications (lib/push); none in tests.
  final PushPlatform? push;
  // pirc://join links opened from outside the app; none in tests.
  final LinkPlatform? links;
  // The store's subscription (store.dart); none, no paywall: in tests that
  // are not of it, and on Android until Play's is built.
  final Store? subscription;
  final String? fontFamily;

  @override
  State<PircApp> createState() => _PircAppState();
}

class _PircAppState extends State<PircApp> with WidgetsBindingObserver {
  String? _relay;
  var _loaded = false;
  var _unfolded = <String>{};
  KeyHolder? _holder;
  DeviceKey? _key;
  String? _lockError;
  PhoneSettings? _settings;
  // What is open beside the list on a wide screen, or over it on a narrow
  // one: a session's chat, or Settings; kept across the width changing, as
  // a tablet turns or a window is resized.
  final _chat = ValueNotifier<String?>(null);
  var _inSettings = false;
  // Whether the list and what is open are side by side.
  var _wide = false;
  // The list's own pages (a host's, a group's), in its column when wide.
  final _listNav = GlobalKey<NavigatorState>();
  // The chat or Settings pushed over the list, on a narrow screen.
  Route<void>? _detail;
  // What is on the app's navigator, to move only what crossing the width
  // moves.
  final _routes = _Routes();
  // When the app went to the background, to lock it again after the hold,
  // and whether it went for a trip outside (outside.dart).
  DateTime? _awaySince;
  var _awayOutside = false;
  RelayConnection? _conn;
  PircModel? _model;
  // The app's navigator, which is below this widget, not above it.
  final _nav = GlobalKey<NavigatorState>();
  // A join link opened from outside, for the join screen; and one that
  // came before the prefs were read.
  final _incoming = ValueNotifier<String?>(null);
  String? _early;
  // The join screen in place of the paywall, before subscribing: from its
  // "Join with a link", or for a link opened from outside.
  var _joinFirst = false;
  StreamSubscription<String>? _links;
  // What the store last said, and the product for the paywall.
  final _access = ValueNotifier<StoreStatus?>(null);
  StoreProduct? _product;
  var _buyWaiting = false;
  StreamSubscription<void>? _storeChanged;
  // Each purchase, so that one given up on and answered late changes no
  // newer one's waiting.
  var _buys = 0;
  // One ask of the store at a time, and one more after it when asked
  // meanwhile; one unlock at a time, which a shut since it began stops
  // short of connecting.
  Future<void>? _refreshing;
  var _refreshAgain = false;
  Future<void>? _unlocking;
  var _shuts = 0;
  late final Notifications? _notes = widget.push == null ? null : Notifications(platform: widget.push!, prefs: widget.prefs, open: _openChat);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final subscription = widget.subscription;
    Future.wait([
      // Said before anything connects, and so before any notification.
      widget.prefs.setNoStore(subscription == null).then((_) => widget.prefs.relay()),
      widget.prefs.unfolded(),
      PhoneSettings.load(store: widget.store, prefs: widget.prefs, push: widget.push, resync: () => _notes?.answered(), protect: widget.protect),
      if (subscription != null) _askStore(subscription),
      widget.prefs.buyWaiting(),
    ]).then((v) {
      if (!mounted) return;
      final r = v[0] as String?;
      setState(() {
        _unfolded = v[1] as Set<String>;
        _settings = v[2] as PhoneSettings;
        _relay = r;
        if (subscription != null) _access.value = (v[3] as (StoreStatus, bool)).$1;
        _buyWaiting = v.last as bool;
        _loaded = true;
      });
      if (subscription != null && (v[3] as (StoreStatus, bool)).$2) _stored(_access.value!);
      if (r != null && _allowed) _unlock();
      final early = _early;
      _early = null;
      if (early != null) _opened(early);
    });
    final links = widget.links;
    if (links != null) {
      _links = links.opened.listen(_opened);
      links.launchedWith().then((l) {
        if (l != null) _opened(l);
      }, onError: (_) {});
    }
    _storeChanged = subscription?.changed.listen((_) => _refresh());
  }

  // Whether the store lets this phone be used: the trial, paid, or in its
  // grace after a failed payment; always, with no store, and while joined
  // to the review relay, whatever the store says.
  bool get _allowed => widget.subscription == null || _relay == reviewRelay || _access.value?.access == Access.allowed;

  bool get _play => defaultTargetPlatform == TargetPlatform.android;

  // The store's answer, and whether it answered; when it fails or takes
  // longer than 8 seconds (Play may, and its errors come as exceptions),
  // the last one, or before any whether the app last saw the phone allowed
  // until now (store.until), or never subscribed.
  Future<(StoreStatus, bool)> _askStore(Store store) async {
    try {
      return (await store.status().timeout(const Duration(seconds: 8)), true);
    } on Object {
      final last = _access.value;
      if (last != null) return (last, false);
      final until = await widget.prefs.allowedUntil();
      return (until != null && until.isAfter(DateTime.now()) ? const StoreStatus(Access.allowed) : const StoreStatus(Access.never), false);
    }
  }

  // Asked again: on coming to the front, after the store's own sheets and
  // pages, and when it says something changed. Allowed no longer, what is
  // open closes as on locking; allowed again, the app opens as it would.
  Future<void> _refresh() {
    final running = _refreshing;
    if (running != null) {
      _refreshAgain = true;
      return running;
    }
    return _refreshing = _refreshOnce().then((_) {
      _refreshing = null;
      if (!_refreshAgain) return null;
      _refreshAgain = false;
      return _refresh();
    });
  }

  Future<void> _refreshOnce() async {
    final store = widget.subscription;
    if (store == null || !_loaded) return;
    final was = _allowed;
    final (status, answered) = await _askStore(store);
    if (!mounted) return;
    setState(() => _access.value = status);
    // What the store did not say changes nothing kept.
    if (answered) _stored(status);
    if (was && !_allowed) {
      _shut();
    } else if (!was && _allowed && _relay != null && _model == null) {
      _unlock();
    }
  }

  // What follows from the store's answer: the product for the paywall,
  // the waiting purchase done with once allowed, and until when the
  // notification extension may show what happened: the period's end, or
  // the grace's, and a few days beyond, so that a renewal while the app is
  // not opened does not silence them (the extension asks StoreKit itself
  // first).
  void _stored(StoreStatus status) {
    if (status.access == Access.allowed) {
      _waitingDone();
      final end = status.graceEnds ?? status.ends ?? DateTime.now();
      widget.prefs.setAllowedUntil(end.add(const Duration(days: 3)));
    } else {
      widget.prefs.setAllowedUntil(null);
      // Each time: whether the account can still have the trial changes
      // with it used on another device.
      widget.subscription!.product().then((p) {
        if (mounted && p != null) setState(() => _product = p);
      }, onError: (_) {});
    }
  }

  void _waitingDone() {
    if (!_buyWaiting) return;
    if (mounted) setState(() => _buyWaiting = false);
    widget.prefs.setBuyWaiting(false);
  }

  Future<Bought> _buy() async {
    final mine = ++_buys;
    final bought = await widget.subscription!.buy();
    // Bought again meanwhile, it leaves the newer purchase's waiting to
    // the newer one, and the rest to the store's status.
    final latest = mine == _buys;
    if (latest && bought == Bought.pending) {
      if (mounted) setState(() => _buyWaiting = true);
      await widget.prefs.setBuyWaiting(true);
    } else if (latest && bought == Bought.cancelled) {
      // Asked again and given up, as after a request declined.
      _waitingDone();
    }
    await _refresh();
    return bought;
  }

  Future<void> _restore() async {
    await widget.subscription!.restore();
    await _refresh();
  }

  Future<void> _manage() async {
    await widget.subscription!.manage();
    await _refresh();
  }

  // Try again, when the store could not be reached or to see whether a
  // purchase was approved.
  Future<void> _retry() async {
    _product = null;
    await _refresh();
  }

  // A pirc://join link from outside the app (links.dart): the join screen
  // with it filled in, never joined without the person's tap; on a phone
  // that has joined already, said so, since it joins one relay.
  void _opened(String link) {
    if (!_loaded) {
      _early = link;
      return;
    }
    if (_relay == null) {
      _nav.currentState?.popUntil((r) => r.isFirst);
      _incoming.value = link;
      if (!_allowed) setState(() => _joinFirst = true);
      return;
    }
    // After the next frame: a link that brings the app back comes before
    // the return, which may lock it again and close what is open.
    WidgetsBinding.instance.addPostFrameCallback((_) => _alreadyAdded());
    WidgetsBinding.instance.scheduleFrame();
  }

  void _alreadyAdded() {
    final context = _nav.currentState?.overlay?.context;
    if (context == null) return;
    showCupertinoDialog<void>(
      context: context,
      builder: (context) => CupertinoAlertDialog(
        title: const Text('This phone is already added'),
        content: const Text('It has joined a relay, so the link was not used.'),
        actions: [CupertinoDialogAction(isDefaultAction: true, onPressed: () => Navigator.of(context).pop(), child: const Text('OK'))],
      ),
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _conn?.stop();
    _notes?.dispose();
    _links?.cancel();
    _storeChanged?.cancel();
    _incoming.dispose();
    _access.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refresh();
    if (state == AppLifecycleState.paused) {
      _conn?.stop();
      if (_model != null && _awaySince == null) {
        _awaySince = DateTime.now();
        _awayOutside = outside;
      }
    } else if (state == AppLifecycleState.resumed && _key != null) {
      final away = _awaySince;
      _awaySince = null;
      final settings = _settings!;
      if (settings.lock && away != null && _locks(DateTime.now().difference(away), settings.hold)) return _lock();
      _notes?.resumed();
      _conn?.start();
    }
  }

  // Whether time away locks the app again. A trip outside, which takes
  // Android to the background (iOS stays in front for the picker, the
  // camera and its prompts), is not leaving, unless it lasts as long as the
  // hold and at least 5 minutes, as when the person goes home from it.
  bool _locks(Duration away, Duration hold) {
    if (_awayOutside && defaultTargetPlatform == TargetPlatform.android) return away >= hold && away >= tripMax;
    return away >= hold;
  }

  // Locked again, after the hold: the key is forgotten, with the
  // connection that logged in with it, and asked for as on opening, once
  // the store has said it still allows it.
  void _lock() {
    _shut();
    if (widget.subscription == null) {
      _unlock();
      return;
    }
    _refresh().whenComplete(() {
      if (mounted && _allowed && _relay != null && _model == null) _unlock();
    });
  }

  // What is open closed, and the key forgotten with the connection.
  void _shut() {
    _shuts++;
    _detail = null;
    _nav.currentState?.popUntil((r) => r.isFirst);
    _chat.value = null;
    _inSettings = false;
    _conn?.stop();
    _notes?.detach();
    _holder?.forget();
    _settings!.key = null;
    setState(() {
      _key = null;
      _conn = null;
      _model = null;
      _lockError = null;
    });
  }

  Future<void> _unlock() => _unlocking ??= _unlockOnce().whenComplete(() => _unlocking = null);

  Future<void> _unlockOnce() async {
    final relay = _relay!;
    final holder = _holder ??= KeyHolder(widget.store, relay, holdFor: _settings!.hold, protect: widget.protect);
    final shuts = _shuts;
    try {
      final key = await holder.unlock();
      if (!mounted) return;
      // Shut while Face ID was asked, as when the store stopped allowing
      // the phone: not connected behind the paywall.
      if (shuts != _shuts || !_allowed) {
        holder.forget();
        return;
      }
      if (key == null) {
        // The keys are gone (the app reinstalled): join again.
        await widget.prefs.setRelay(null);
        setState(() => _relay = null);
        return;
      }
      _connect(relay, key);
    } on KeyUnavailable catch (e) {
      setState(() => _lockError = e.cancelled ? null : e.reason);
    }
  }

  void _connect(String relay, DeviceKey key) {
    late final PircModel model;
    final conn = RelayConnection(
      url: relay,
      key: key,
      onFrame: (f) {
        _notes?.onFrame(f);
        model.client.onFrame(f);
      },
      onState: (s) {
        if (s is Refused && s.removed) _removed(relay);
        _notes?.onState(s is Ready);
        model.client.onState(switch (s) {
        Ready() => const RelayView(state: 'ready'),
        Connecting() || AwaitingApproval() => const RelayView(state: 'connecting'),
        Offline(:final reason) => RelayView(state: 'offline', reason: reason),
        Refused(:final reason) => RelayView(state: 'refused', reason: reason),
        Stopped() => const RelayView(state: 'stopped'),
        });
      },
    );
    model = PircModel(send: conn.send, cache: widget.cache, publicKey: key.publicKey);
    _notes?.attach(model, conn.send);
    _settings!
      ..relay = relay
      ..key = key;
    setState(() {
      _key = key;
      _conn = conn;
      _model = model;
    });
    model.restore().whenComplete(conn.start);
    _explainNotifications();
  }

  // Once, after joining (or on the first open since notifications came):
  // what they are for, then the system's prompt.
  Future<void> _explainNotifications() async {
    final push = widget.push;
    if (push == null || await widget.prefs.notificationsExplained()) return;
    if (await push.permission() == Permission.granted) return widget.prefs.setNotificationsExplained();
    await widget.prefs.setNotificationsExplained();
    final nav = _nav.currentState;
    if (nav == null || !mounted) return;
    await nav.push(CupertinoPageRoute<void>(
      fullscreenDialog: true,
      builder: (context) => NotifyScreen(
        allow: () async {
          Navigator.of(context).pop();
          await goingOutside(push.ask);
          await _notes?.answered();
        },
        later: () => Navigator.of(context).pop(),
      ),
    ));
  }

  // A session's chat, over the list; with here, over what is open (a host's
  // or group's page), so that going back returns to it.
  // Wide, it is beside the list instead, whatever was there before.
  void _openChat(String id, {bool here = false}) {
    final model = _model;
    final nav = _nav.currentState;
    if (model == null || nav == null) return;
    if (_wide) {
      nav.popUntil((r) => r.isFirst);
      setState(() {
        _chat.value = id;
        _inSettings = false;
      });
      return;
    }
    if (!here) nav.popUntil((r) => r.isFirst);
    _pushChat(model, id);
  }

  void _pushChat(PircModel model, String id) {
    _chat.value = id;
    _inSettings = false;
    _pushDetail(CupertinoPageRoute<void>(builder: (_) => ChatScreen(model: model, id: id, drafts: widget.drafts, open: _openChat)));
  }

  // The chat or Settings over the list. Closed on a narrow screen, nothing
  // is open; not when another took its place, or when it went because the
  // screen grew wide, where it is beside the list now.
  void _pushDetail(Route<void> route) {
    _detail = route;
    _nav.currentState!.push(route).then((_) {
      if (!identical(_detail, route)) return;
      _detail = null;
      if (_wide) return;
      _chat.value = null;
      _inSettings = false;
    });
  }

  void _openSettings() {
    if (_wide) {
      _nav.currentState?.popUntil((r) => r.isFirst);
      setState(() {
        _inSettings = true;
        _chat.value = null;
      });
      return;
    }
    _pushSettings();
  }

  void _pushSettings() {
    _inSettings = true;
    _chat.value = null;
    _pushDetail(CupertinoPageRoute<void>(builder: (_) => SettingsScreen(settings: _settings!, model: _model, subscription: widget.subscription == null ? null : _access, manage: _manage)));
  }

  // Crossing 1024 points: what was over the list goes beside it, or what
  // was beside it over it. Only that, and the list's host and group pages,
  // move: a sheet or a full screen page of the list's stays where it is.
  void _crossed(bool wide) {
    _wide = wide;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final nav = _nav.currentState;
      if (nav == null || _model == null || _wide != wide) return;
      if (wide) {
        final stack = _routes.stack;
        final detail = _detail;
        final at = detail == null ? -1 : stack.indexOf(detail);
        // The chat or Settings, with any sheet over it, which was its own,
        // and the list's pages, which are in its column now.
        final going = [
          for (final (i, r) in stack.indexed)
            if (identical(r, detail) || r.settings.name == scopeRoute || (at >= 0 && i > at && r is PopupRoute)) r,
        ];
        _detail = null;
        for (final r in going.reversed) {
          nav.removeRoute(r);
        }
      } else {
        _narrowed();
      }
    });
  }

  // Narrowed with a chat or Settings beside the list: over it now, once
  // nothing else is (a sheet, a full screen page), so as not to bury it.
  void _narrowed() {
    final model = _model;
    if (_wide || model == null || _detail != null || (_chat.value == null && !_inSettings)) return;
    if (_routes.stack.length > 1) {
      _routes.changed = _narrowed;
      return;
    }
    _routes.changed = null;
    if (_chat.value != null) {
      _pushChat(model, _chat.value!);
    } else {
      _pushSettings();
    }
  }

  // Removed from the relay by another client: its keys and kept chats go,
  // and the app is back to joining.
  Future<void> _removed(String relay) async {
    _conn?.stop();
    await widget.store.delete(relay);
    await widget.cache?.clear();
    await widget.drafts?.clear();
    await widget.prefs.setRelay(null);
    _holder?.forget();
    _notes?.detach();
    _settings!
      ..relay = null
      ..key = null;
    _chat.value = null;
    _inSettings = false;
    _detail = null;
    setState(() {
      _relay = null;
      _key = null;
      _conn = null;
      _model = null;
      _holder = null;
    });
  }

  // The camera's scan, over the join screen; the link it read, or null.
  Future<String?> _scan() async {
    final explained = await widget.prefs.cameraExplained();
    return _nav.currentState!.push<String>(CupertinoPageRoute(
      fullscreenDialog: true,
      builder: (_) => ScanScreen(explained: explained, onExplained: widget.prefs.setCameraExplained),
    ));
  }

  Future<void> _join(JoinLink link) async {
    final keys = await join(link, widget.store, protect: _settings!.lock);
    await widget.prefs.setRelay(link.relay);
    setState(() {
      _relay = link.relay;
      _joinFirst = false;
    });
    // A link opened while joining, which the join screen kept for after.
    if (_incoming.value != null) {
      _incoming.value = null;
      _alreadyAdded();
    }
    // Joined from the paywall, to a relay other than the review relay: the
    // paywall again, not connected until the store allows the phone, as for
    // a lapsed subscription.
    if (!_allowed) return;
    _holder = KeyHolder(widget.store, link.relay, holdFor: _settings!.hold, protect: widget.protect);
    _connect(link.relay, keys.main);
  }

  @override
  Widget build(BuildContext context) {
    final brightness = MediaQuery.platformBrightnessOf(context);
    final look = (brightness == Brightness.dark ? Look.dark : Look.light).withFont(widget.fontFamily, mono: widget.fontFamily);
    final Widget home;
    if (!_loaded) {
      home = CupertinoPageScaffold(backgroundColor: look.page, child: const SizedBox.shrink());
    } else if (!_allowed && _relay == null && _joinFirst) {
      home = JoinScreen(join: _join, incoming: _incoming, scan: widget.scan ?? (widget.camera ? _scan : null), back: () => setState(() => _joinFirst = false));
    } else if (!_allowed) {
      home = PaywallScreen(
        access: _access.value?.access ?? Access.never,
        product: _product,
        waiting: _buyWaiting,
        buy: _buy,
        restore: _restore,
        manage: _manage,
        retry: _retry,
        storeName: _play ? 'Google Play' : 'App Store',
        theStore: _play ? 'Google Play' : 'the App Store',
        accountName: _play ? 'Google Play account' : 'Apple Account',
        // Apple's standard licence is the App Store's; the Play build links
        // only the privacy policy.
        showTerms: !_play,
        manageWhenEnded: _play,
        // It joins one relay.
        join: _relay == null ? () => setState(() => _joinFirst = true) : null,
      );
    } else if (_relay == null) {
      home = JoinScreen(join: _join, incoming: _incoming, scan: widget.scan ?? (widget.camera ? _scan : null));
    } else if (_model == null) {
      home = LockScreen(unlock: _unlock, error: _lockError);
    } else {
      final model = _model!;
      // As the web page's: at 1024 points or wider (a tablet, a foldable
      // opened, a wide window), the list in a column of 380 beside what is
      // open; narrower, one or the other.
      final wide = MediaQuery.sizeOf(context).width >= 1024;
      if (wide != _wide) _crossed(wide);
      final list = SessionsScreen(
        model: model,
        unfolded: _unfolded,
        onFold: (keys) {
          _unfolded = keys;
          widget.prefs.setUnfolded(keys);
        },
        open: _openChat,
        openHere: (id) => _openChat(id, here: true),
        settings: _openSettings,
        selected: wide ? _chat : null,
      );
      home = !wide
          ? list
          : ListenableBuilder(
              listenable: _chat,
              builder: (context, _) => Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                // Its own navigator, so that a host's or group's page stays
                // in the column; sheets and full screen pages still cover
                // everything.
                SizedBox(
                  width: 380,
                  // The system's back (Android's) goes to the column's
                  // pages first.
                  child: NavigatorPopHandler(
                    onPopWithResult: (_) => _listNav.currentState?.maybePop(),
                    child: Navigator(key: _listNav, onGenerateRoute: (_) => CupertinoPageRoute<void>(builder: (_) => list)),
                  ),
                ),
                Container(width: 0.5, color: look.rule),
                Expanded(
                  child: _inSettings
                      ? SettingsScreen(key: const ValueKey('settings'), settings: _settings!, model: model, subscription: widget.subscription == null ? null : _access, manage: _manage, wide: true)
                      : _chat.value != null
                          ? ChatScreen(key: ValueKey(_chat.value), model: model, id: _chat.value!, drafts: widget.drafts, open: _openChat, wide: true)
                          : CupertinoPageScaffold(
                              backgroundColor: look.card,
                              child: Center(child: Text('Choose a session to see its chat.', style: look.text(size: 16, color: look.ink2, spacing: 0))),
                            ),
                ),
              ]),
            );
    }
    return LookScope(
      look: look,
      child: CupertinoApp(
        navigatorKey: _nav,
        navigatorObservers: [_routes],
        title: 'PiRC',
        theme: CupertinoThemeData(brightness: brightness, primaryColor: look.accent, scaffoldBackgroundColor: look.page),
        // Material's too, for Flutter's page of the licences (Settings).
        localizationsDelegates: const [DefaultMaterialLocalizations.delegate, DefaultCupertinoLocalizations.delegate, DefaultWidgetsLocalizations.delegate],
        builder: (context, child) => LookScope(look: look, child: child!),
        home: home,
      ),
    );
  }
}

// The routes on the app's navigator, bottom first, and a call when they
// change.
class _Routes extends NavigatorObserver {
  final stack = <Route<dynamic>>[];
  VoidCallback? changed;

  void _changed() => WidgetsBinding.instance.addPostFrameCallback((_) => changed?.call());

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    stack.add(route);
    _changed();
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    stack.remove(route);
    _changed();
  }

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) {
    stack.remove(route);
    _changed();
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    final i = oldRoute == null ? -1 : stack.indexOf(oldRoute);
    if (i >= 0 && newRoute != null) stack[i] = newRoute;
    _changed();
  }
}
