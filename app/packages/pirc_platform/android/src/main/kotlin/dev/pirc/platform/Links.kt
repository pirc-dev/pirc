// pirc://join links opened in the app, for lib/app/links.dart over
// 'dev.pirc.app/links': the one the activity was started with, once, and
// those that come while it runs. The token in a link goes to Dart only,
// never to a log.
package dev.pirc.platform

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry

class Links(private val activity: () -> Activity?) :
    MethodChannel.MethodCallHandler, PluginRegistry.NewIntentListener, ActivityPluginBinding.OnSaveInstanceStateListener {
    var channel: MethodChannel? = null
    // Whether the activity's starting link was offered. Made again after
    // its process went (reopened from Recents), the activity gets the
    // intent it was first started with, which its saved state marks as
    // offered.
    private var offered = false
    // A link that came before Dart asked, as when the activity is made
    // again from its saved state and given the new link as a new intent;
    // the newest wins over the starting one.
    private var asked = false
    private var waiting: String? = null

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        if (call.method != "launchedWith") return result.notImplemented()
        val intent = activity()?.intent
        val link = waiting ?: intent?.takeIf { !offered && it.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY == 0 }?.let(::joinLink)
        offered = true
        asked = true
        waiting = null
        result.success(link)
    }

    override fun onSaveInstanceState(bundle: Bundle) = bundle.putBoolean(OFFERED, offered)

    override fun onRestoreInstanceState(bundle: Bundle?) {
        if (bundle?.getBoolean(OFFERED) == true) offered = true
    }

    // A link while the app runs (the activity is singleTop).
    override fun onNewIntent(intent: Intent): Boolean {
        val link = joinLink(intent) ?: return false
        if (asked) channel?.invokeMethod("opened", link) else waiting = link
        return true
    }
}

private const val OFFERED = "dev.pirc.platform.links.offered"

private fun joinLink(intent: Intent): String? {
    val data = intent.data ?: return null
    if (intent.action != Intent.ACTION_VIEW || data.scheme != "pirc" || data.host != "join") return null
    return data.toString()
}
