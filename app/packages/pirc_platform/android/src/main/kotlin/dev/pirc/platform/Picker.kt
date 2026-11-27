// Files the person picks with the system's document picker, for
// lib/ui/files.dart over 'dev.pirc.app/pick': each as its name, type and
// size, with its bytes while they come to the call's max together, read
// off the main thread; one that cannot be read comes without them.
package dev.pirc.platform

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry

class Picker(private val context: Context, private val activity: () -> Activity?) : MethodChannel.MethodCallHandler, PluginRegistry.ActivityResultListener {
    private var pending: MethodChannel.Result? = null
    private var max = 0L

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        if (call.method != "files") return result.notImplemented()
        val a = activity()
        if (pending != null || a == null) return result.error("busy", "the picker cannot show now", null)
        pending = result
        max = (call.argument<Number>("max") ?: 0).toLong()
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        a.startActivityForResult(intent, REQUEST)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != REQUEST) return false
        val result = pending ?: return true
        pending = null
        val uris = mutableListOf<Uri>()
        if (resultCode == Activity.RESULT_OK && data != null) {
            val clip = data.clipData
            if (clip != null) for (i in 0 until clip.itemCount) uris += clip.getItemAt(i).uri
            else data.data?.let { uris += it }
        }
        val max = this.max
        Thread {
            var room = max
            val files = uris.map { uri ->
                val f = try {
                    read(uri, room)
                } catch (e: Exception) {
                    mapOf<String, Any>("name" to (uri.lastPathSegment ?: "file"), "mimeType" to "application/octet-stream", "size" to 0L)
                }
                (f["data"] as? ByteArray)?.let { room -= it.size }
                f
            }
            Handler(Looper.getMainLooper()).post { result.success(files) }
        }.start()
        return true
    }

    private fun read(uri: Uri, max: Long): Map<String, Any> {
        val r = context.contentResolver
        var name = uri.lastPathSegment ?: "file"
        var size = -1L
        r.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                c.getString(0)?.let { name = it }
                if (!c.isNull(1)) size = c.getLong(1)
            }
        }
        val file = mutableMapOf<String, Any>("name" to name, "mimeType" to (r.getType(uri) ?: "application/octet-stream"), "size" to size.coerceAtLeast(0))
        if (size <= max) {
            val bytes = try {
                r.openInputStream(uri)?.use { s -> upTo(s, max + 1) }
            } catch (e: Exception) {
                null
            }
            if (bytes != null) {
                file["size"] = bytes.size.toLong()
                if (bytes.size <= max) file["data"] = bytes
            }
        }
        return file
    }

    // At most n bytes of a stream.
    private fun upTo(s: java.io.InputStream, n: Long): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(64 * 1024)
        while (out.size() < n) {
            val got = s.read(buf, 0, minOf(buf.size.toLong(), n - out.size()).toInt())
            if (got < 0) break
            out.write(buf, 0, got)
        }
        return out.toByteArray()
    }

    private companion object {
        const val REQUEST = 0x7069
    }
}
