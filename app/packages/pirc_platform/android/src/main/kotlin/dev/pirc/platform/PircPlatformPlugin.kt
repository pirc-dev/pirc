// The key store, the prefs, the private folder, the clipboard, the
// screen's secure flag, the app's version, notifications, join links and the
// subscription on every Flutter engine: the app's, and the one WakeService
// starts for a push, which has no activity, so that a protected key cannot be
// asked for there (nor a purchase made).
package dev.pirc.platform

import androidx.fragment.app.FragmentActivity
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodChannel

class PircPlatformPlugin : FlutterPlugin, ActivityAware {
    private var activity: FragmentActivity? = null
    private var binding: ActivityPluginBinding? = null
    private val channels = mutableListOf<MethodChannel>()
    private var push: Push? = null
    private var screen: Screen? = null
    private var links: Links? = null
    private var store: Store? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        val context = binding.applicationContext
        channels += MethodChannel(binding.binaryMessenger, "dev.pirc.app/keys").apply { setMethodCallHandler(KeyStore(context) { activity }) }
        channels += MethodChannel(binding.binaryMessenger, "dev.pirc.app/prefs").apply { setMethodCallHandler(Prefs(context)) }
        channels += MethodChannel(binding.binaryMessenger, "dev.pirc.app/files").apply { setMethodCallHandler(Files(context)) }
        channels += MethodChannel(binding.binaryMessenger, "dev.pirc.app/clipboard").apply { setMethodCallHandler(Clipboard(context)) }
        channels += MethodChannel(binding.binaryMessenger, "dev.pirc.app/about").apply { setMethodCallHandler(About(context)) }
        val sc = Screen { activity }
        screen = sc
        channels += MethodChannel(binding.binaryMessenger, "dev.pirc.app/screen").apply { setMethodCallHandler(sc) }
        val p = Push(context) { activity }
        push = p
        channels += MethodChannel(binding.binaryMessenger, "dev.pirc.app/push").apply {
            setMethodCallHandler(p)
            p.channel = this
        }
        val l = Links { activity }
        links = l
        channels += MethodChannel(binding.binaryMessenger, "dev.pirc.app/links").apply {
            setMethodCallHandler(l)
            l.channel = this
        }
        val st = Store(context) { activity }
        store = st
        channels += MethodChannel(binding.binaryMessenger, "dev.pirc.app/store").apply {
            setMethodCallHandler(st)
            st.channel = this
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        for (c in channels) c.setMethodCallHandler(null)
        channels.clear()
        store?.close()
        store = null
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding.activity as? FragmentActivity
        this.binding = binding
        screen?.apply(binding.activity)
        push?.let {
            binding.addRequestPermissionsResultListener(it)
            binding.addOnNewIntentListener(it)
        }
        links?.let {
            binding.addOnNewIntentListener(it)
            binding.addOnSaveStateListener(it)
        }
    }

    override fun onDetachedFromActivityForConfigChanges() = onDetachedFromActivity()

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) = onAttachedToActivity(binding)

    override fun onDetachedFromActivity() {
        push?.let {
            binding?.removeRequestPermissionsResultListener(it)
            binding?.removeOnNewIntentListener(it)
        }
        links?.let {
            binding?.removeOnNewIntentListener(it)
            binding?.removeOnSaveStateListener(it)
        }
        binding = null
        activity = null
    }
}
