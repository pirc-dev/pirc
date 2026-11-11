// The plugin's subscription (packages/pirc_platform, Store.swift) against
// StoreKit's test store, PiRC.storekit, on a simulator:
//   xcodebuild test -workspace Runner.xcworkspace -scheme Runner \
//     -destination 'platform=iOS Simulator,name=<device>' -only-testing:RunnerTests
// The test store does not answer on the iOS 26.3 simulator (Xcode 26.3's,
// an Apple bug), so on an older one: iOS 18.6 does.
import StoreKit
import StoreKitTest
import UIKit
import XCTest
@testable import pirc_platform

final class StoreTests: XCTestCase {
  private var session: SKTestSession!

  override func setUpWithError() throws {
    session = try SKTestSession(configurationFileNamed: "PiRC")
    session.resetToDefaultState()
    session.clearTransactions()
    session.disableDialogs = true
  }

  private func state() async -> String? { await Subscription.status()["state"] as? String }

  // The status once StoreKit has taken in a change made through the test
  // session, which it does a moment later, as on a phone.
  private func status(until done: ([String: Any]) -> Bool) async throws -> [String: Any] {
    for _ in 0..<50 {
      let now = await Subscription.status()
      if done(now) { return now }
      try await Task.sleep(nanoseconds: 200_000_000)
    }
    return await Subscription.status()
  }

  private func state(becoming expected: String) async throws -> String? {
    try await status { $0["state"] as? String == expected }["state"] as? String
  }

  private func only() throws -> SKTestTransaction { try XCTUnwrap(session.allTransactions().last) }

  // As the channel buys: confirmed in the app's scene.
  @MainActor private func buy() async throws -> String {
    try await Subscription.buy(in: UIApplication.shared.connectedScenes.first as? UIWindowScene)
  }

  // The store's servers asked for no longer than the time, though what
  // asks them goes on: not stopped by cancelling, as a call may not be.
  func testWithinAnswersAtTheTime() async {
    let start = Date()
    let answer: Int? = await Subscription.within(seconds: 0.5) {
      await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) { c.resume() }
      }
      return 1
    }
    XCTAssertNil(answer)
    XCTAssertLessThan(Date().timeIntervalSince(start), 1.5)
    let quick: Int? = await Subscription.within(seconds: 3) { 2 }
    XCTAssertEqual(quick, 2)
  }

  func testNeverSubscribedIsOfferedTheTrial() async throws {
    let state = await state()
    XCTAssertEqual(state, "never")
    let product = try await Subscription.product()
    XCTAssertEqual(product?["price"] as? String, "£19.99")
    let trial = product?["trial"] as? [String: Any]
    XCTAssertEqual(trial?["count"] as? Int, 2)
    XCTAssertEqual(trial?["unit"] as? String, "week")
  }

  func testBuyingStartsTheFreeTrial() async throws {
    let bought = try await buy()
    XCTAssertEqual(bought, "bought")
    // Whether it renews, from the store's servers, once they answer in
    // time.
    let status = try await status { $0["renews"] != nil }
    XCTAssertEqual(status["state"] as? String, "allowed")
    XCTAssertEqual(status["trial"] as? Bool, true)
    XCTAssertEqual(status["renews"] as? Bool, true)
    let ends = try XCTUnwrap(status["ends"] as? Int)
    let days = Double(ends) / 1000 - Date().timeIntervalSince1970
    XCTAssertEqual(days / 86400, 14, accuracy: 0.1)
    // The trial is had once per Apple Account.
    let after = try await Subscription.product()
    let product = try XCTUnwrap(after)
    XCTAssertNil(product["trial"])
  }

  func testExpiredHasEnded() async throws {
    _ = try await buy()
    try session.expireSubscription(productIdentifier: Subscription.yearly)
    let state = try await state(becoming: "ended")
    XCTAssertEqual(state, "ended")
  }

  func testRefundedHasEnded() async throws {
    _ = try await buy()
    try session.refundTransaction(identifier: only().identifier)
    let state = try await state(becoming: "ended")
    XCTAssertEqual(state, "ended")
  }

  func testRenewalTurnedOff() async throws {
    _ = try await buy()
    try session.disableAutoRenewForTransaction(identifier: only().identifier)
    let status = try await status { $0["renews"] as? Bool == false }
    XCTAssertEqual(status["state"] as? String, "allowed")
    XCTAssertEqual(status["renews"] as? Bool, false)
  }

  @available(iOS 15.4, *)
  func testFailedPaymentInGraceIsAllowed() async throws {
    session.billingGracePeriodIsEnabled = true
    session.shouldEnterBillingRetryOnRenewal = true
    _ = try await buy()
    try session.forceRenewalOfSubscription(productIdentifier: Subscription.yearly)
    // The store's servers say grace before the phone takes in the
    // renewal that failed.
    let status = try await status { $0["graceEnds"] != nil && $0["ends"] == nil }
    XCTAssertEqual(status["state"] as? String, "allowed")
    XCTAssertNotNil(status["graceEnds"])
    // The trial's payment failed: no longer in the trial, nor with its
    // end, which has passed.
    XCTAssertEqual(status["trial"] as? Bool, false)
    XCTAssertNil(status["ends"])
  }

  @available(iOS 15.4, *)
  func testFailedPaymentPastGraceIsAPaymentProblem() async throws {
    session.shouldEnterBillingRetryOnRenewal = true
    _ = try await buy()
    try session.forceRenewalOfSubscription(productIdentifier: Subscription.yearly)
    let state = try await state(becoming: "payment")
    XCTAssertEqual(state, "payment")
  }

  func testAskToBuyWaitsForApproval() async throws {
    session.askToBuyEnabled = true
    let bought = try await buy()
    XCTAssertEqual(bought, "pending")
    let waiting = await state()
    XCTAssertEqual(waiting, "never")
    try session.approveAskToBuyTransaction(identifier: only().identifier)
    let approved = try await state(becoming: "allowed")
    XCTAssertEqual(approved, "allowed")
  }
}
