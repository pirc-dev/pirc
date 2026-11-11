// The folder for what the app keeps of what it shows (the chats, the
// drafts), for lib/app/files.dart over the channel 'dev.pirc.app/files':
// in noBackupFilesDir, out of backups and of transfers to another phone, as
// the keys and the prefs are. Files there need nothing more.
package dev.pirc.platform

import android.content.Context
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File

class Files(private val context: Context) : MethodChannel.MethodCallHandler {
    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "folder" -> result.success(File(context.noBackupFilesDir, "private").apply { mkdirs() }.path)
            "protect" -> result.success(null)
            "protection" -> result.success(mapOf("protection" to "", "excludedFromBackup" to true))
            else -> result.notImplemented()
        }
    }
}
