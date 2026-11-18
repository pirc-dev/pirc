// The relay's address, from Settings: changed when the relay moved, as to
// another port. The phone keeps its keys and chats; it logs in at the new
// address with its key, and keeps that address only once the relay there
// answers as its own (join.dart, follow). Otherwise it says why and stays
// on the old.
import 'package:flutter/cupertino.dart';

import 'look.dart';

class RelayAddressScreen extends StatefulWidget {
  const RelayAddressScreen({super.key, required this.relay, required this.follow});

  // The address the phone uses now.
  final String relay;
  // Follows the relay there: null when it did, otherwise why not.
  final Future<String?> Function(String to) follow;

  @override
  State<RelayAddressScreen> createState() => _RelayAddressScreenState();
}

class _RelayAddressScreenState extends State<RelayAddressScreen> {
  late final _address = TextEditingController(text: widget.relay);
  var _busy = false;
  String? _error;

  @override
  void dispose() {
    _address.dispose();
    super.dispose();
  }

  Future<void> _go() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final error = await widget.follow(_address.text);
    // Followed, the app went back to the session list, and this page with it.
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return PopScope(
      canPop: !_busy,
      child: CupertinoPageScaffold(
        backgroundColor: look.page,
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
            children: [
              Align(
                alignment: Alignment.centerLeft,
                child: CupertinoButton(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  minimumSize: const Size(44, 44),
                  onPressed: _busy ? null : () => Navigator.of(context).maybePop(),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    Icon(CupertinoIcons.chevron_back, size: 22, color: look.accent),
                    Text('Settings', style: look.text(color: look.accent)),
                  ]),
                ),
              ),
              Semantics(header: true, child: Text('Relay address', style: look.text(size: 28, weight: FontWeight.w700))),
              const SizedBox(height: 10),
              Text(
                'If the relay moved, to another port or name, put its new address here. '
                'This phone connects there with the key it has, and keeps its chats. '
                'Until the relay answers there, it stays on the old address.',
                style: look.text(size: 15, color: look.secondary),
              ),
              const SizedBox(height: 20),
              CupertinoTextField(
                controller: _address,
                placeholder: 'wss://…',
                placeholderStyle: look.text(color: look.secondary),
                style: look.mono(size: 15, color: look.ink),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: look.card, borderRadius: BorderRadius.circular(10)),
                autocorrect: false,
                enableSuggestions: false,
                keyboardType: TextInputType.url,
                textInputAction: TextInputAction.go,
                onSubmitted: (_) => _busy ? null : _go(),
                enabled: !_busy,
              ),
              const SizedBox(height: 10),
              CupertinoButton(
                onPressed: _busy ? null : _go,
                child: _busy ? const CupertinoActivityIndicator() : Text('Connect', style: look.text(color: look.accent)),
              ),
              if (_error != null) Semantics(liveRegion: true, child: Text(_error!, textAlign: TextAlign.center, style: look.text(size: 15, color: look.failed))),
            ],
          ),
        ),
      ),
    );
  }
}
