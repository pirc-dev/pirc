// Keeping a secret off the screen's copies, for lib/ui/invite.dart over
// 'dev.pirc.app/screen': while secure, FLAG_SECURE, so that the recents
// snapshot and screenshots show nothing; kept across the activity being
// made again, as on rotation.
package dev.pirc.platform

import android.app.Activity
import android.view.WindowManager
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

class Screen(private val activity: () -> Activity?) : MethodChannel.MethodCallHandler {
    private var secure = false

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        if (call.method != "secure") return result.notImplemented()
        secure = call.argument<Boolean>("on") ?: false
        apply(activity())
        result.success(null)
    }

    fun apply(a: Activity?) {
        val window = a?.window ?: return
        if (secure) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }
}
