// Settings, over the session list from its button, as the web page's
// Settings.tsx in the Native look: this phone's settings, kept on it (the
// lock, how long it holds, notifications), its subscription, then the
// hosts and the clients registered with the relay, and last the licences
// of what the app is built from. The web page's look and keys have nothing to set here.
import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
// Only for the licences: Flutter's page of them is Material's.
import 'package:flutter/material.dart' show LicensePage, Theme, ThemeData;
import 'package:flutter/services.dart';

import '../app/model.dart';
import '../app/settings.dart';
import '../app/store.dart';
import '../push/push.dart';
import 'devices.dart';
import 'look.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key, required this.settings, this.model, this.subscription, this.manage, this.version = appVersion, this.wide = false});
  final PhoneSettings settings;
  // The relay's, for its hosts and clients; none before joining.
  final PircModel? model;
  // What the store says of the subscription, and its page for managing
  // it; none where there is no store.
  final ValueListenable<StoreStatus?>? subscription;
  final Future<void> Function()? manage;
  // The app's version as the build gave it, for the licences.
  final Future<String?> Function() version;
  // Beside the list (a wide screen): no way back, as the web page's.
  final bool wide;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.settings.checkPermission();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  // Back from the phone's Settings, where notifications may have changed.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) widget.settings.checkPermission();
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final s = widget.settings;
    return CupertinoPageScaffold(
      backgroundColor: look.page,
      child: ListenableBuilder(
        listenable: Listenable.merge([s, ?widget.subscription]),
        builder: (context, _) => ListView(
          padding: EdgeInsets.only(top: MediaQuery.paddingOf(context).top, bottom: MediaQuery.paddingOf(context).bottom + 40),
          children: [
            if (!widget.wide)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 4, 20, 0),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: CupertinoButton(
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    minimumSize: const Size(44, 44),
                    onPressed: () => Navigator.of(context).maybePop(),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      Icon(CupertinoIcons.chevron_back, size: 22, color: look.accent),
                      Text('Sessions', style: look.text(color: look.accent)),
                    ]),
                  ),
                ),
              ),
            Padding(
              padding: EdgeInsets.fromLTRB(20, widget.wide ? 12 : 0, 20, 6),
              child: Semantics(header: true, child: Text('Settings', style: look.text(size: 34, weight: FontWeight.w700, spacing: 0.34, height: 1.25))),
            ),
            _Section(title: 'This phone', sub: 'Kept here: each phone has its own.', rows: [
              _Row(
                label: 'Lock with ${s.lockWith}',
                sub: s.lock ? 'Asked for when PiRC opens.' : 'Off: PiRC opens without asking.',
                end: _Switch(on: s.lock, disabled: s.busy || s.key == null, set: s.setLock),
                problem: s.lockProblem,
              ),
              if (s.lock)
                _Row(
                  label: 'Ask again after',
                  below: _Holds(hold: s.hold, set: s.setHold),
                ),
              if (s.push != null) ...[
                _Row(
                  label: 'Notifications',
                  sub: s.permission == Permission.denied ? "Off for PiRC in the phone's Settings." : 'When a turn ends or pi asks.',
                  // Refused by the phone: turned on only in its Settings.
                  end: _Switch(on: s.notifying, disabled: s.busy || s.permission == null || s.permission == Permission.denied, set: s.setNotify),
                ),
                if (s.permission == Permission.denied) _Link(label: "Open the phone's Settings", onTap: s.openPhoneSettings),
              ],
            ]),
            if (widget.subscription?.value case final sub?) _Section(title: 'Subscription', sub: 'Through your ${_store()}.', rows: [
              // The stores' reviewers, who may not subscribe; the store's own
              // answer, beside it, is shown only when it allows the phone.
              if (s.relay == reviewRelay) const _Row(label: 'Review access', sub: "Joined to PiRC's app review relay, which works without a subscription."),
              if (sub.access == Access.allowed) _Row(label: _subscribed(sub), sub: _until(sub), problem: sub.graceEnds != null ? _grace(sub) : null),
              if (widget.manage != null) _Link(label: 'Manage subscription', onTap: () => widget.manage!()),
            ]),
            if (widget.model != null) ...[
              _Section(title: 'Hosts', sub: 'Computers running pi, whose sessions show here.', rows: [DeviceList(model: widget.model!, role: 'host', relay: s.relay)]),
              _Section(title: 'Clients', sub: 'This phone, the web app and the other phones, each reaching every host.', rows: [DeviceList(model: widget.model!, role: 'client', relay: s.relay)]),
            ],
            _Section(title: 'About', sub: 'PiRC and what it is built from.', rows: [_Link(label: 'Licences', onTap: _licences)]),
          ],
        ),
      ),
    );
  }
}

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

String _date(DateTime d) {
  final l = d.toLocal();
  return '${l.day} ${_months[l.month - 1]} ${l.year}';
}

String _store() => defaultTargetPlatform == TargetPlatform.android ? 'Google Play account' : 'Apple Account';

String _subscribed(StoreStatus s) => s.trial ? 'Free trial' : 'PiRC yearly';

// When it renews or ends, as far as the store said: offline, whether it
// renews is not known; Google Play gives the phone no dates.
String? _until(StoreStatus s) {
  final ends = s.ends;
  if (ends == null) {
    if (defaultTargetPlatform != TargetPlatform.android) return null;
    return switch (s.renews) {
      true => 'Renews every year',
      false => "Won't renew",
      null => null,
    };
  }
  return switch (s.renews) {
    true => s.trial ? 'Until ${_date(ends)}, then renews yearly' : 'Renews ${_date(ends)}',
    false => 'Ends ${_date(ends)}',
    null => 'Until ${_date(ends)}',
  };
}

String _grace(StoreStatus s) => "There's a problem with your payment. Fix it by ${_date(s.graceEnds!)} to keep using PiRC.";

extension on _SettingsScreenState {
  // Flutter's page of every package's licence, from the NOTICES file each
  // build carries, in the phone's light or dark.
  Future<void> _licences() async {
    String? version;
    try {
      version = await widget.version();
    } on Object {
      version = null;
    }
    if (!mounted) return;
    final brightness = MediaQuery.platformBrightnessOf(context);
    await Navigator.of(context).push(CupertinoPageRoute<void>(
      builder: (_) => Theme(data: ThemeData(brightness: brightness), child: LicensePage(applicationName: 'PiRC', applicationVersion: version)),
    ));
  }
}

// The app's version, "1.0.0 (3)", from the platform.
Future<String?> appVersion() => const MethodChannel('dev.pirc.app/about').invokeMethod<String>('version');

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.sub, required this.rows});
  final String title;
  final String sub;
  final List<Widget> rows;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 20),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32),
          child: Semantics(header: true, child: Text(title.toUpperCase(), style: look.text(size: 13, color: look.ink2, spacing: 0.4))),
        ),
        Padding(padding: const EdgeInsets.fromLTRB(32, 4, 32, 10), child: Text(sub, style: look.text(size: 13, color: look.ink3, spacing: 0))),
        Container(
          margin: const EdgeInsets.symmetric(horizontal: 16),
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(color: look.card, borderRadius: BorderRadius.circular(14)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            for (final (i, r) in rows.indexed) ...[if (i > 0) Container(height: 0.5, color: look.rule), r],
          ]),
        ),
      ]),
    );
  }
}

// A row: a label, a line under it, and its control at the end; or, with
// below, a control under the label.
class _Row extends StatelessWidget {
  const _Row({required this.label, this.sub, this.end, this.below, this.problem});
  final String label;
  final String? sub;
  final Widget? end;
  final Widget? below;
  final String? problem;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 32),
          child: Row(spacing: 12, children: [
            Expanded(
              child: MergeSemantics(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  Text(label, style: look.text(size: 16, spacing: 0)),
                  if (sub != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Semantics(liveRegion: true, child: Text(sub!, style: look.text(size: 13, color: look.ink2, spacing: 0))),
                    ),
                ]),
              ),
            ),
            ?end,
          ]),
        ),
        if (below != null) Padding(padding: const EdgeInsets.only(top: 10), child: below),
        if (problem != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Semantics(liveRegion: true, child: Text(problem!, style: look.text(size: 13, color: look.block, spacing: 0))),
          ),
      ]),
    );
  }
}

// An on/off switch, as the phone's own, in the web page's Native green.
class _Switch extends StatelessWidget {
  const _Switch({required this.on, required this.set, this.disabled = false});
  final bool on;
  final bool disabled;
  final void Function(bool) set;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Opacity(
      opacity: disabled ? 0.4 : 1,
      child: CupertinoSwitch(value: on, activeTrackColor: const Color(0xff34c759), inactiveTrackColor: look.wash2, onChanged: disabled ? null : set),
    );
  }
}

// How long an unlocked key is held, as the web page's looks are chosen.
class _Holds extends StatelessWidget {
  const _Holds({required this.hold, required this.set});
  final Duration hold;
  final void Function(Duration) set;

  static String name(Duration d) => d == Duration.zero ? 'Every time' : d.inMinutes < 60 ? '${d.inMinutes} min' : '${d.inHours} h';

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(color: look.wash, borderRadius: BorderRadius.circular(12)),
      child: Row(spacing: 3, children: [
        for (final d in holds)
          Expanded(
            flex: d == Duration.zero ? 5 : 3,
            child: Semantics(
              button: true,
              selected: d == hold,
              label: d == Duration.zero ? 'Every time' : d.inMinutes < 60 ? '${d.inMinutes} minutes' : '${d.inHours} ${d.inHours == 1 ? 'hour' : 'hours'}',
              excludeSemantics: true,
              onTap: () => set(d),
              child: GestureDetector(
                onTap: () => set(d),
                child: Container(
                  height: 36,
                  alignment: Alignment.center,
                  decoration: d == hold
                      ? BoxDecoration(color: look.page, borderRadius: BorderRadius.circular(9), boxShadow: const [BoxShadow(color: Color(0x1f000000), blurRadius: 3, offset: Offset(0, 1))])
                      : null,
                  child: Text(name(d),
                      maxLines: 1,
                      style: look.text(size: 14, weight: d == hold ? FontWeight.w600 : FontWeight.w400, color: d == hold ? look.ink : look.ink2, spacing: 0)),
                ),
              ),
            ),
          ),
      ]),
    );
  }
}

// A row that does something, in the accent colour.
class _Link extends StatelessWidget {
  const _Link({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Semantics(
      button: true,
      container: true,
      label: label,
      excludeSemantics: true,
      onTap: onTap,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 48),
          padding: const EdgeInsets.symmetric(horizontal: 16),
          alignment: Alignment.centerLeft,
          child: Text(label, style: look.text(size: 16, color: look.accent, spacing: 0)),
        ),
      ),
    );
  }
}
