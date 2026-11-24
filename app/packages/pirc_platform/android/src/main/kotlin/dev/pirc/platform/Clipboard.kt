// The clipboard over 'dev.pirc.app/clipboard': copying a secret, for
// lib/ui/invite.dart's copySecret, marked sensitive, so that Android 13 and
// later hide it in the clipboard's preview and keyboards do not suggest it;
// and images for a message, for lib/ui/images.dart: whether it holds any,
// from its description alone; the images, each as it came; and 'changed'
// told as the clipboard changes.
package dev.pirc.platform

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

class Clipboard(private val context: Context, private val channel: MethodChannel) : MethodChannel.MethodCallHandler {
    private val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    private val changed = ClipboardManager.OnPrimaryClipChangedListener { channel.invokeMethod("changed", null) }

    init {
        clipboard.addPrimaryClipChangedListener(changed)
    }

    fun close() = clipboard.removePrimaryClipChangedListener(changed)

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "copySecret" -> {
                val text = call.argument<String>("text") ?: return result.error("args", "no text", null)
                val clip = ClipData.newPlainText("PiRC", text)
                clip.description.extras = PersistableBundle().apply {
                    // ClipDescription.EXTRA_IS_SENSITIVE from Android 13; the same key
                    // before it, which older versions ignore.
                    putBoolean(if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE", true)
                }
                clipboard.setPrimaryClip(clip)
                result.success(null)
            }
            "hasImages" -> result.success(clipboard.primaryClipDescription?.hasMimeType("image/*") == true)
            "images" -> {
                // Read here, where the app has the focus the clipboard asks
                // for; the bytes off the main thread, at most a size a phone's
                // photo has.
                val clip = clipboard.primaryClip ?: return result.success(emptyList<ByteArray>())
                val described = clip.description.hasMimeType("image/*")
                val uris = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }.filter {
                    context.contentResolver.getType(it)?.startsWith("image/") ?: described
                }
                val main = Handler(Looper.getMainLooper())
                Thread {
                    val found = mutableListOf<ByteArray>()
                    for (uri in uris) {
                        try {
                            context.contentResolver.openInputStream(uri)?.use {
                                val bytes = it.readNBytesCompat(MAX_BYTES + 1)
                                if (bytes.size <= MAX_BYTES) found += bytes
                            }
                        } catch (_: Exception) {
                        }
                    }
                    main.post { result.success(found) }
                }.start()
            }
            else -> result.notImplemented()
        }
    }
}

private const val MAX_BYTES = 64 shl 20

// At most n bytes of the stream.
private fun java.io.InputStream.readNBytesCompat(n: Int): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    val buf = ByteArray(64 shl 10)
    while (out.size() < n) {
        val r = read(buf, 0, minOf(buf.size, n - out.size()))
        if (r < 0) break
        out.write(buf, 0, r)
    }
    return out.toByteArray()
}
