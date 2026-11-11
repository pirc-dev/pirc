// The yearly subscription through StoreKit 2, for lib/app/store.dart over
// 'dev.pirc.app/store' (docs/design.md, step 15, Price): what the App Store
// says of it, buying it, which starts the free trial where the Apple
// Account has not had it, restoring, and the store's page for managing it.
// The app learns only that: StoreKit checks Apple's signature, and nothing
// it cannot verify, nor anything refunded or revoked, counts.
import Flutter
import StoreKit
import UIKit

enum Subscription {
  static let yearly = "dev.pirc.app.yearly"

  // The subscription's state:
  //   allowed  the trial, paid, or in the store's billing grace period
  //   payment  past the grace, the store still retrying the payment
  //   ended    had and no longer, refunded or revoked included
  //   never    never had on this Apple Account
  // with "trial" while in the free trial, "ends" (ms) when the current
  // period ends, "renews" whether it will, and "graceEnds" (ms) in grace.
  // What only the store's servers know (grace, retry, renewal) is left
  // out offline, or when they take more than a few seconds; the rest
  // StoreKit answers from the phone.
  static func status(now: Date = Date()) async -> [String: Any] {
    var current: Transaction?
    for await result in Transaction.currentEntitlements {
      if case .verified(let t) = result, t.productID == yearly, t.revocationDate == nil { current = t }
    }
    // Any transaction at all, even one that fails verification, means the
    // account has had it: never grants nothing, but offers the trial.
    let latest = await Transaction.latest(for: yearly)
    var out: [String: Any] = ["state": current != nil ? "allowed" : latest != nil ? "ended" : "never"]
    if let t = current {
      out["trial"] = false
      // Past its end and still allowed, it is in the grace period after
      // a failed payment, the trial's or a year's: neither in the trial,
      // nor with an end the app could count on.
      if let end = t.expirationDate, end > now {
        out["ends"] = ms(end)
        out["trial"] = introductory(t)
      }
    } else if case .verified(let t)? = latest, let end = t.expirationDate {
      out["ends"] = ms(end)
    }
    if let status = await within(seconds: 3, serverStatus) {
      if case .verified(let renewal) = status.renewalInfo {
        out["renews"] = renewal.willAutoRenew
        if status.state == .inGracePeriod, let end = renewal.gracePeriodExpirationDate { out["graceEnds"] = ms(end) }
      }
      if current == nil, status.state == .inBillingRetryPeriod { out["state"] = "payment" }
    }
    return out
  }

  // The product as the store shows it in the phone's country: its price,
  // and the free trial where this Apple Account can still have it.
  static func product() async throws -> [String: Any]? {
    guard let product = try await Product.products(for: [yearly]).first, let sub = product.subscription else { return nil }
    var out: [String: Any] = ["price": product.displayPrice]
    if let offer = sub.introductoryOffer, offer.paymentMode == .freeTrial, await sub.isEligibleForIntroOffer {
      out["trial"] = ["count": offer.period.value, "unit": unit(offer.period.unit)]
    }
    return out
  }

  // bought, pending (Ask to Buy, or the bank's own check) or cancelled.
  // Confirmed in the app's scene in front, as Apple asks of an app with
  // scenes, from iOS 17.
  @MainActor static func buy(in scene: UIWindowScene?) async throws -> String {
    guard let product = try await Product.products(for: [yearly]).first else { throw StoreError.noProduct }
    let outcome: Product.PurchaseResult
    do {
      if #available(iOS 17.0, *), let scene {
        outcome = try await product.purchase(confirmIn: scene)
      } else {
        outcome = try await product.purchase()
      }
    } catch StoreKitError.userCancelled {
      return "cancelled"
    }
    switch outcome {
    case .success(.verified(let t)):
      await t.finish()
      return "bought"
    case .success(.unverified):
      throw StoreError.unverified
    case .pending:
      return "pending"
    case .userCancelled:
      return "cancelled"
    @unknown default:
      return "cancelled"
    }
  }

  // The subscription's status from the store's servers, with its renewal.
  static func serverStatus() async -> Product.SubscriptionInfo.Status? {
    guard let product = try? await Product.products(for: [yearly]).first,
          let statuses = try? await product.subscription?.status else { return nil }
    return statuses.first { if case .verified(let t) = $0.transaction { return t.productID == yearly } else { return false } }
  }

  // What work gives within the time, or nil: at the time, whether or not
  // the work has stopped. A task group would wait for it, however long
  // the store's servers take, cancelled or not.
  static func within<T>(seconds: Double, _ work: @escaping () async -> T?) async -> T? {
    let first = First<T?>()
    return await withCheckedContinuation { done in
      first.set(done)
      let running = Task { first.give(await work()) }
      Task {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        running.cancel()
        first.give(nil)
      }
    }
  }

  private static func introductory(_ t: Transaction) -> Bool {
    if #available(iOS 17.2, *) { return t.offer?.type == .introductory }
    return t.offerType == .introductory
  }

  private static func unit(_ u: Product.SubscriptionPeriod.Unit) -> String {
    switch u {
    case .day: return "day"
    case .week: return "week"
    case .month: return "month"
    case .year: return "year"
    @unknown default: return "day"
    }
  }

  private static func ms(_ d: Date) -> Int { Int(d.timeIntervalSince1970 * 1000) }
}

// The first of several answers to a continuation, the rest dropped.
private final class First<T>: @unchecked Sendable {
  private let lock = NSLock()
  private var done: CheckedContinuation<T, Never>?

  func set(_ c: CheckedContinuation<T, Never>) {
    lock.lock()
    done = c
    lock.unlock()
  }

  func give(_ value: T) {
    lock.lock()
    let c = done
    done = nil
    lock.unlock()
    c?.resume(returning: value)
  }
}

enum StoreError: Error {
  case noProduct, unverified
}

// The channel. Transactions that come outside a purchase (renewals,
// refunds, an approved Ask to Buy, one bought on another device, and at
// launch any left unfinished) are listened to from launch, as Apple asks,
// finished, and told to Dart as "changed", which asks for the status
// again; one that fails verification is left unfinished, and comes again
// at the next launch. From iOS 17, so are changes that bring no
// transaction (grace, a failed payment, renewal turned off); before it,
// and for those everywhere while the app was not running, Dart asks
// again on coming to the front and after the store's own pages.
final class Store {
  private let channel: FlutterMethodChannel
  private var updates: Task<Void, Never>?
  private var statuses: Task<Void, Never>?

  init(channel: FlutterMethodChannel) {
    self.channel = channel
    channel.setMethodCallHandler { [weak self] call, result in self?.handle(call, result) }
    updates = Task.detached { [weak self] in
      for await result in Transaction.updates {
        if case .verified(let t) = result { await t.finish() }
        await self?.changed()
      }
    }
    if #available(iOS 17.0, *) {
      statuses = Task.detached { [weak self] in
        for await _ in Product.SubscriptionInfo.Status.updates { await self?.changed() }
      }
    }
  }

  deinit {
    updates?.cancel()
    statuses?.cancel()
  }

  @MainActor private func changed() { channel.invokeMethod("changed", arguments: nil) }

  // The app's scene in front, for the store's sheets and pages.
  @MainActor private func scene() -> UIWindowScene? {
    UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene
  }

  private func handle(_ call: FlutterMethodCall, _ result: @escaping FlutterResult) {
    Task { @MainActor in
      do {
        switch call.method {
        case "status": result(await Subscription.status())
        case "product": result(try await Subscription.product())
        case "buy": result(try await Subscription.buy(in: self.scene()))
        case "restore":
          try await AppStore.sync()
          result(nil)
        case "manage":
          guard let scene = self.scene() else {
            return result(FlutterError(code: "store", message: "no scene", details: nil))
          }
          try await AppStore.showManageSubscriptions(in: scene)
          result(nil)
        default:
          result(FlutterMethodNotImplemented)
        }
      } catch StoreKitError.userCancelled {
        // Cancelled signing in to restore, or a page closed: nothing done.
        result(nil)
      } catch Product.PurchaseError.purchaseNotAllowed {
        result(FlutterError(code: "notAllowed", message: nil, details: nil))
      } catch StoreKitError.networkError(_) {
        result(FlutterError(code: "network", message: nil, details: nil))
      } catch {
        result(FlutterError(code: "store", message: String(describing: error), details: nil))
      }
    }
  }
}
