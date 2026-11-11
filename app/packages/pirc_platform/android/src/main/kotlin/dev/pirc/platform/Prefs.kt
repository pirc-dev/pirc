// What the app keeps besides its keys, for lib/app/app.dart's ChannelPrefs
// over the channel 'dev.pirc.app/prefs': strings in a JSON file in
// noBackupFilesDir, out of backups as the keys are, written aside and
// renamed.
package dev.pirc.platform

import android.content.Context
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import org.json.JSONObject

class Prefs(context: Context) : MethodChannel.MethodCallHandler {
    private val file = File(context.noBackupFilesDir, "prefs.json")

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val key = call.argument<String>("key") ?: return result.error("args", "no key", null)
        val prefs = if (file.exists()) JSONObject(file.readText()) else JSONObject()
        when (call.method) {
            "get" -> result.success(prefs.optString(key).ifEmpty { null })
            "set" -> {
                val value = call.argument<String>("value")
                if (value == null) prefs.remove(key) else prefs.put(key, value)
                val aside = File(file.path + ".new")
                aside.writeText(prefs.toString())
                aside.renameTo(file)
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }
}
