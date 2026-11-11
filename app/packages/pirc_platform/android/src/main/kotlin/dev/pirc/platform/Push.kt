// Notifications on Android, for lib/push/push.dart over 'dev.pirc.app/push':
// whether they are allowed and asking for them (Android 13 and later ask),
// the FCM token, posting one for a session, and the session of the one the
// person tapped. Posting works without an activity, from a wake too.
package dev.pirc.platform

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessaging
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry

// The intent extra a notification opens the app with.
const val SESSION_EXTRA = "dev.pirc.app.session"
private const val CHANNEL_ID = "sessions"
private const val ASK_CODE = 0x9124

class Push(private val context: Context, private val activity: () -> android.app.Activity?) :
    MethodChannel.MethodCallHandler, PluginRegistry.RequestPermissionsResultListener, PluginRegistry.NewIntentListener {
    var channel: MethodChannel? = null
    private var asking: MethodChannel.Result? = null

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "permission" -> result.success(
                when {
                    allowed() -> "granted"
                    // Android 13 and later ask; until the app has, they are not refused.
                    Build.VERSION.SDK_INT >= 33 && !asked() -> "undetermined"
                    else -> "denied"
                },
            )
            "ask" -> ask(result)
            "token" -> FirebaseMessaging.getInstance().token.addOnCompleteListener { t ->
                result.success(if (t.isSuccessful && t.result != null) mapOf("platform" to "fcm", "token" to t.result) else null)
            }
            "post" -> {
                post(context, call.argument<String>("session"), call.argument<String>("title") ?: "PiRC", call.argument<String>("body") ?: "")
                result.success(null)
            }
            "settings" -> {
                // The app's notifications in the phone's Settings.
                context.startActivity(
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
                result.success(null)
            }
            "launchedFor" -> result.success(activity()?.intent?.getStringExtra(SESSION_EXTRA)?.also { activity()?.intent?.removeExtra(SESSION_EXTRA) })
            else -> result.notImplemented()
        }
    }

    private fun allowed() = NotificationManagerCompat.from(context).areNotificationsEnabled() &&
        (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

    private fun asked() = context.getSharedPreferences("dev.pirc.push", Context.MODE_PRIVATE).getBoolean("asked", false)

    private fun ask(result: MethodChannel.Result) {
        val a = activity()
        if (allowed() || Build.VERSION.SDK_INT < 33 || a == null) return result.success(allowed())
        asking = result
        context.getSharedPreferences("dev.pirc.push", Context.MODE_PRIVATE).edit().putBoolean("asked", true).apply()
        ActivityCompat.requestPermissions(a, arrayOf(Manifest.permission.POST_NOTIFICATIONS), ASK_CODE)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray): Boolean {
        if (requestCode != ASK_CODE) return false
        asking?.success(allowed())
        asking = null
        return true
    }

    // A tap on a notification while the app runs.
    override fun onNewIntent(intent: Intent): Boolean {
        val session = intent.getStringExtra(SESSION_EXTRA) ?: return false
        channel?.invokeMethod("opened", mapOf("session" to session))
        return true
    }
}

// Posts a notification, one per session (a newer one replaces it); with no
// session, the fixed text.
fun post(context: Context, session: String?, title: String, body: String) {
    val manager = context.getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL_ID) == null) {
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Sessions", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "When a session finishes, fails or asks you something"
        })
    }
    val open = context.packageManager.getLaunchIntentForPackage(context.packageName)!!.apply {
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        if (session != null) putExtra(SESSION_EXTRA, session)
    }
    val tag = session ?: "pirc"
    val tap = PendingIntent.getActivity(context, tag.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val n = NotificationCompat.Builder(context, CHANNEL_ID)
        // The app's white mark (sh/app-icons.sh), as Android wants one.
        .setSmallIcon(context.resources.getIdentifier("ic_notification", "drawable", context.packageName).takeIf { it != 0 } ?: context.applicationInfo.icon)
        .setColor(0xFF57D9A1.toInt())
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(NotificationCompat.BigTextStyle().bigText(body))
        .setContentIntent(tap)
        .setAutoCancel(true)
        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        .build()
    if (NotificationManagerCompat.from(context).areNotificationsEnabled()) {
        try {
            NotificationManagerCompat.from(context).notify(tag, 1, n)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS withdrawn meanwhile.
        }
    }
}
