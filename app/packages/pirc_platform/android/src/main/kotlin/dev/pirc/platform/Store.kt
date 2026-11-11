// The yearly subscription through Google Play (docs/design.md, step 15,
// Price), for lib/app/store.dart over 'dev.pirc.app/store', as Store.swift
// is for the App Store. Play Billing on the phone says whether the account
// has the subscription, active (the trial, paid, or in the grace after a
// failed payment) or suspended (past the grace, on hold), and whether it
// renews; it offers the free trial only to an account that has never had
// it, which is how "never" is told from "ended". It gives no dates, which
// only Google's server API would, and no server of ours asks.
package dev.pirc.platform

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClient.BillingResponseCode
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

private const val PRODUCT = "dev.pirc.app.yearly"
private const val BASE_PLAN = "yearly"

class Store(private val context: Context, private val activity: () -> Activity?) : MethodChannel.MethodCallHandler, PurchasesUpdatedListener {
    var channel: MethodChannel? = null
    private val main = Handler(Looper.getMainLooper())
    private var client = newClient()
    // Calls waiting for the connection to Play, which is made on the first
    // and again after Play drops it.
    private val waiting = mutableListOf<(BillingResult) -> Unit>()
    private var connecting = false
    // Which attempt is current, so that a late callback of an earlier one
    // does not answer for it.
    private var attempt = 0
    // The purchase Play's sheet is open for, answered when Play says how
    // it went.
    private var buying: MethodChannel.Result? = null

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "status" -> status(result)
            "product" -> product(result)
            "buy" -> buy(result)
            // Play has no restore of its own: what the account has comes
            // with each status.
            "restore" -> result.success(null)
            "manage" -> manage(result)
            else -> result.notImplemented()
        }
    }

    fun close() = client.endConnection()

    private fun newClient() = BillingClient.newBuilder(context)
        .setListener(this)
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().enablePrepaidPlans().build())
        .build()

    private fun status(result: MethodChannel.Result) = ready(result) {
        val params = QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).includeSuspendedSubscriptions(true).build()
        client.queryPurchasesAsync(params) { r, purchases ->
            main.post {
                if (r.responseCode != BillingResponseCode.OK) return@post fail(result, r)
                val ours = purchases.filter { PRODUCT in it.products && it.purchaseState == Purchase.PurchaseState.PURCHASED }
                ours.forEach(::acknowledge)
                // A pending purchase is not reported: the app keeps that it
                // waits (store.waiting) until one is bought.
                val active = ours.firstOrNull { !it.isSuspended }
                when {
                    active != null -> result.success(mapOf("state" to "allowed", "renews" to active.isAutoRenewing))
                    ours.isNotEmpty() -> result.success(mapOf("state" to "payment"))
                    // Play lists the trial only to an account that has never
                    // had the subscription; unknown, as offline, never. The
                    // one Play failure answered as a status, which is safe:
                    // not allowed either way, so nothing kept is extended.
                    else -> details { d, _ -> result.success(mapOf("state" to if (d != null && trial(d) == null) "ended" else "never")) }
                }
            }
        }
    }

    private fun product(result: MethodChannel.Result) = details { d, r ->
        if (d == null) return@details if (r.responseCode == BillingResponseCode.OK) result.success(null) else fail(result, r)
        val price = base(d)?.pricingPhases?.pricingPhaseList?.lastOrNull()?.formattedPrice ?: return@details result.success(null)
        val free = trial(d)?.pricingPhases?.pricingPhaseList?.firstOrNull()?.let { length(it.billingPeriod) }
        result.success(mapOf("price" to price, "trial" to free))
    }

    private fun buy(result: MethodChannel.Result) {
        val a = activity() ?: return result.error("store", "no activity", null)
        if (buying != null) return result.error("store", "a purchase is under way", null)
        buying = result
        details { d, r ->
            val offer = d?.let { trial(it) ?: base(it) }
            if (d == null || offer == null) {
                buying = null
                return@details if (r.responseCode != BillingResponseCode.OK) fail(result, r) else result.error("store", "no product", null)
            }
            val params = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(listOf(BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(d).setOfferToken(offer.offerToken).build()))
                .build()
            // A launch that fails also comes to onPurchasesUpdated, which
            // then finds nothing being bought: buying is cleared first.
            val launched = client.launchBillingFlow(a, params)
            if (launched.responseCode != BillingResponseCode.OK) {
                buying = null
                bought(result, launched, emptyList())
            }
        }
    }

    // Play's own page for the subscription: cancelling, or fixing a payment.
    private fun manage(result: MethodChannel.Result) {
        val page = Uri.parse("https://play.google.com/store/account/subscriptions?sku=$PRODUCT&package=${context.packageName}")
        try {
            val a = activity()
            if (a != null) a.startActivity(Intent(Intent.ACTION_VIEW, page)) else context.startActivity(Intent(Intent.ACTION_VIEW, page).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            result.success(null)
        } catch (e: ActivityNotFoundException) {
            result.error("unavailable", e.message, null)
        }
    }

    // From Play's sheet, and outside a purchase: a pending one completed,
    // or one bought on another device. One of those while the sheet is open
    // answers for it; the status asked for after a purchase sets it right.
    override fun onPurchasesUpdated(r: BillingResult, purchases: List<Purchase>?) {
        main.post {
            val ours = purchases.orEmpty().filter { PRODUCT in it.products }
            ours.filter { it.purchaseState == Purchase.PurchaseState.PURCHASED }.forEach(::acknowledge)
            val b = buying
            buying = null
            if (b != null) bought(b, r, ours) else channel?.invokeMethod("changed", null)
        }
    }

    private fun bought(result: MethodChannel.Result, r: BillingResult, ours: List<Purchase>) = when (r.responseCode) {
        BillingResponseCode.OK -> result.success(
            when {
                ours.any { it.purchaseState == Purchase.PurchaseState.PURCHASED } -> "bought"
                ours.any { it.purchaseState == Purchase.PurchaseState.PENDING } -> "pending"
                else -> "cancelled"
            },
        )
        BillingResponseCode.USER_CANCELED -> result.success("cancelled")
        BillingResponseCode.ITEM_ALREADY_OWNED -> result.success("bought")
        else -> fail(result, r)
    }

    // Play refunds a purchase not acknowledged within 3 days; one that
    // fails is acknowledged at the next status.
    private fun acknowledge(p: Purchase) {
        if (p.isAcknowledged || p.purchaseState != Purchase.PurchaseState.PURCHASED) return
        client.acknowledgePurchase(AcknowledgePurchaseParams.newBuilder().setPurchaseToken(p.purchaseToken).build()) {}
    }

    private fun details(then: (ProductDetails?, BillingResult) -> Unit) = ready({ r -> then(null, r) }) {
        val product = QueryProductDetailsParams.Product.newBuilder().setProductId(PRODUCT).setProductType(BillingClient.ProductType.SUBS).build()
        client.queryProductDetailsAsync(QueryProductDetailsParams.newBuilder().setProductList(listOf(product)).build()) { r, found ->
            main.post { then(found.productDetailsList.firstOrNull { it.productId == PRODUCT }, r) }
        }
    }

    private fun ready(result: MethodChannel.Result, then: () -> Unit) = ready({ r -> fail(result, r) }, then)

    private fun ready(failed: (BillingResult) -> Unit, then: () -> Unit) {
        if (client.isReady) return then()
        waiting += { r -> if (r.responseCode == BillingResponseCode.OK) then() else failed(r) }
        if (connecting) return
        connecting = true
        val mine = ++attempt
        client.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(r: BillingResult) {
                main.post { connected(mine, r) }
            }

            // Made again by the next call.
            override fun onBillingServiceDisconnected() {
                main.post { connected(mine, BillingResult.newBuilder().setResponseCode(BillingResponseCode.SERVICE_DISCONNECTED).build()) }
            }
        })
        // Play may never answer: given up after 15 seconds, with a client
        // made anew, since one still connecting refuses to start again.
        main.postDelayed({
            if (mine == attempt && connecting) {
                client.endConnection()
                client = newClient()
                connected(mine, BillingResult.newBuilder().setResponseCode(BillingResponseCode.SERVICE_TIMEOUT).build())
            }
        }, 15_000)
    }

    private fun connected(mine: Int, r: BillingResult) {
        if (mine != attempt || !connecting) return
        connecting = false
        val calls = waiting.toList()
        waiting.clear()
        calls.forEach { it(r) }
    }
}

// The base plan's own offer, at the full price.
private fun base(d: ProductDetails) = d.subscriptionOfferDetails?.firstOrNull { it.basePlanId == BASE_PLAN && it.offerId == null }

// The free-trial offer, which Play lists only while the account can have it.
private fun trial(d: ProductDetails) = d.subscriptionOfferDetails?.firstOrNull {
    it.basePlanId == BASE_PLAN && it.offerId != null && it.pricingPhases.pricingPhaseList.firstOrNull()?.priceAmountMicros == 0L
}

// An ISO 8601 period as Play gives it ("P14D", "P2W", "P1M") as the trial's
// length.
private fun length(period: String): Map<String, Any>? {
    val m = Regex("P(\\d+)([DWMY])").matchEntire(period) ?: return null
    val unit = mapOf("D" to "day", "W" to "week", "M" to "month", "Y" to "year").getValue(m.groupValues[2])
    return mapOf("count" to m.groupValues[1].toInt(), "unit" to unit)
}

private fun fail(result: MethodChannel.Result, r: BillingResult) = result.error(
    when (r.responseCode) {
        BillingResponseCode.NETWORK_ERROR, BillingResponseCode.SERVICE_UNAVAILABLE, BillingResponseCode.SERVICE_DISCONNECTED, BillingResponseCode.SERVICE_TIMEOUT -> "network"
        // No Play Store, or no account signed in to it.
        BillingResponseCode.BILLING_UNAVAILABLE -> "unavailable"
        else -> "store"
    },
    r.debugMessage,
    null,
)
