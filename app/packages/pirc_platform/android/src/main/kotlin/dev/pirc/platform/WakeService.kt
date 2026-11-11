// FCM's data message {"wake": "1"} (docs/gateway.md): a Flutter engine of
// its own runs the app's Dart entry point wakeMain (lib/main.dart), which
// reads the relay with the read-only key and posts the notifications, and
// says when it is done; it has until then, or 18 of Android's 20 seconds.
package dev.pirc.platform

import android.os.Handler
import android.os.Looper
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import io.flutter.FlutterInjector
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.dart.DartExecutor
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class WakeService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        if (message.data["wake"] != "1") return
        val done = CountDownLatch(1)
        val main = Handler(Looper.getMainLooper())
        var engine: FlutterEngine? = null
        main.post {
            try {
                val loader = FlutterInjector.instance().flutterLoader()
                loader.startInitialization(applicationContext)
                loader.ensureInitializationComplete(applicationContext, null)
                // Its plugins, this one included, are registered with it.
                val e = FlutterEngine(applicationContext)
                engine = e
                MethodChannel(e.dartExecutor.binaryMessenger, "dev.pirc.app/wake").setMethodCallHandler { call, result ->
                    result.success(null)
                    if (call.method == "done") done.countDown()
                }
                e.dartExecutor.executeDartEntrypoint(DartExecutor.DartEntrypoint(loader.findAppBundlePath(), "wakeMain"))
            } catch (_: Exception) {
                post(applicationContext, null, "PiRC", "A session needs you")
                done.countDown()
            }
        }
        if (!done.await(18, TimeUnit.SECONDS)) post(applicationContext, null, "PiRC", "A session needs you")
        main.post { engine?.destroy() }
    }

    // A new token is registered when the app next opens (lib/push/sync.dart).
    override fun onNewToken(token: String) {}
}
