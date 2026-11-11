// The app's version, for lib/ui/settings_screen.dart's Licences over
// 'dev.pirc.app/about': as the build gave it, "1.0.0 (3)". And the notices
// of the Android libraries, which the app's build writes into its assets
// (android/app/build.gradle.kts), for lib/app/notices.dart.
package dev.pirc.platform

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.FileNotFoundException

class About(private val context: Context) : MethodChannel.MethodCallHandler {
    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "version" -> {
                val info = if (Build.VERSION.SDK_INT >= 33) {
                    context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
                } else {
                    @Suppress("DEPRECATION") context.packageManager.getPackageInfo(context.packageName, 0)
                }
                result.success("${info.versionName ?: ""} (${info.longVersionCode})")
            }
            // Off the main thread: about a megabyte. None in a debug build.
            "notices" -> Thread {
                val main = android.os.Handler(context.mainLooper)
                try {
                    val text = try {
                        context.assets.open("pirc/android_notices.json").use { it.readBytes().decodeToString() }
                    } catch (_: FileNotFoundException) {
                        null
                    }
                    main.post { result.success(text) }
                } catch (e: Throwable) {
                    main.post { result.error("notices", e.toString(), null) }
                }
            }.start()
            else -> result.notImplemented()
        }
    }
}
