// The yearly subscription (docs/design.md, step 15, Price), from
// packages/pirc_platform over 'dev.pirc.app/store': whether the store
// lets this phone be used, the product as the store shows it, buying it
// (which starts the free trial where the account has not had it),
// restoring and the store's page for managing it. The app learns only
// that; the stores take the payment.
import 'dart:async';

import 'package:flutter/services.dart';

// The relay PiRC runs for the stores' app review, with only its own demo
// host: joined to it, the phone is allowed without the subscription, and
// the store's answer is left as it is (docs/design.md, step 15, Price).
const reviewRelay = 'wss://review.pirc.dev';

// What the store says of the subscription.
enum Access {
  // The free trial, paid, or in the store's billing grace period.
  allowed,
  // Past the grace, the store still retrying the payment.
  payment,
  // Had and no longer: run out, refunded or revoked.
  ended,
  // Never had on this store account.
  never,
}

class StoreStatus {
  const StoreStatus(this.access, {this.trial = false, this.ends, this.renews, this.graceEnds});

  factory StoreStatus.fromMap(Map<Object?, Object?> m) => StoreStatus(
    switch (m['state']) {
      'allowed' => Access.allowed,
      'payment' => Access.payment,
      'ended' => Access.ended,
      _ => Access.never,
    },
    trial: m['trial'] == true,
    ends: _time(m['ends']),
    renews: m['renews'] as bool?,
    graceEnds: _time(m['graceEnds']),
  );

  final Access access;
  // In the free trial.
  final bool trial;
  // When the current period, or the trial, ends; none in grace, whose
  // end only graceEnds gives, and only online; never on Android, whose
  // store does not say on the phone, nor whether it is the trial.
  final DateTime? ends;
  // Whether it renews then; unknown offline.
  final bool? renews;
  // When the store's grace period ends, while the payment has failed.
  final DateTime? graceEnds;

  static DateTime? _time(Object? ms) => ms is int ? DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true) : null;
}

// A free trial's length, as the store counts it: 2 weeks, 14 days.
typedef TrialLength = ({int count, String unit});

class StoreProduct {
  const StoreProduct({required this.price, this.trial});

  factory StoreProduct.fromMap(Map<Object?, Object?> m) {
    final t = m['trial'];
    return StoreProduct(
      price: m['price'] as String,
      trial: t is Map ? (count: t['count'] as int, unit: t['unit'] as String) : null,
    );
  }

  // The yearly price in the phone's country, as the store writes it.
  final String price;
  // The free trial, when this account can still have it.
  final TrialLength? trial;
}

// What buying came to: bought (the trial started, or paid), pending (Ask
// to Buy, or the bank's own check, told later by changed) or cancelled.
enum Bought { bought, pending, cancelled }

// Errors come as PlatformExceptions: 'notAllowed' (purchases turned off
// on this phone), 'unavailable' (no Play Store, or no account signed in to
// it), 'network', or 'store' with what the store said.
abstract class Store {
  Future<StoreStatus> status();
  // Null when the store does not answer.
  Future<StoreProduct?> product();
  Future<Bought> buy();
  // Asks the store again, which may ask the person to sign in.
  Future<void> restore();
  Future<void> manage();
  // Something changed outside a purchase: a renewal, a refund, an
  // approval, and from iOS 17 grace, a failed payment or renewal turned
  // off; on Android, only a purchase completed or made elsewhere. Not
  // everything comes so: the status is asked for again on coming to the
  // front and after the store's own pages.
  Stream<void> get changed;
}

class ChannelStore implements Store {
  ChannelStore([this.channel = const MethodChannel('dev.pirc.app/store')]) {
    channel.setMethodCallHandler((call) async {
      if (call.method == 'changed') _changed.add(null);
    });
  }

  final MethodChannel channel;
  final _changed = StreamController<void>.broadcast();

  @override
  Stream<void> get changed => _changed.stream;

  @override
  Future<StoreStatus> status() async => StoreStatus.fromMap((await channel.invokeMethod<Map<Object?, Object?>>('status'))!);

  @override
  Future<StoreProduct?> product() async {
    final m = await channel.invokeMethod<Map<Object?, Object?>>('product');
    return m == null ? null : StoreProduct.fromMap(m);
  }

  @override
  Future<Bought> buy() async => switch (await channel.invokeMethod<String>('buy')) {
    'bought' => Bought.bought,
    'pending' => Bought.pending,
    _ => Bought.cancelled,
  };

  @override
  Future<void> restore() => channel.invokeMethod('restore');

  @override
  Future<void> manage() => channel.invokeMethod('manage');
}
