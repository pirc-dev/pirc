// Copying a secret, for lib/ui/invite.dart's copySecret over
// 'dev.pirc.app/clipboard': marked sensitive, so that Android 13 and later
// hide it in the clipboard's preview and keyboards do not suggest it.
package dev.pirc.platform

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

class Clipboard(private val context: Context) : MethodChannel.MethodCallHandler {
    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        if (call.method != "copySecret") return result.notImplemented()
        val text = call.argument<String>("text") ?: return result.error("args", "no text", null)
        val clip = ClipData.newPlainText("PiRC", text)
        clip.description.extras = PersistableBundle().apply {
            // ClipDescription.EXTRA_IS_SENSITIVE from Android 13; the same key
            // before it, which older versions ignore.
            putBoolean(if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE", true)
        }
        (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(clip)
        result.success(null)
    }
}
