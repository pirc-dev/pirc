// The phone's keys, for lib/keys/key_store.dart over the channel
// 'dev.pirc.app/keys' (docs/design.md, section 12, step 13): each seed in a
// file encrypted with an AES key in the Keystore, since the Keystore holds
// Ed25519 keys only from Android 13. The main key's AES key, when
// protected, works only after a fingerprint, the face or the device's PIN,
// asked for at each use; the read-only key's needs no one, readable from
// the first unlock. The files are in noBackupFilesDir, out of backups.
package dev.pirc.platform

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.security.InvalidAlgorithmParameterException
import java.security.KeyStore as JavaKeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

// activity: the app's, to ask the person in; none in the background, where
// only the read-only key, which asks no one, can be had.
class KeyStore(context: Context, private val activity: () -> FragmentActivity?) : MethodChannel.MethodCallHandler {
    private val dir = File(context.noBackupFilesDir, "keys").apply { mkdirs() }
    private val keystore = JavaKeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val relay = call.argument<String>("relay") ?: return result.error("args", "no relay", null)
        when (call.method) {
            "store" -> {
                val kind = call.argument<String>("kind")
                val seed = call.argument<ByteArray>("seed")
                if (kind == null || seed == null) return result.error("args", "no kind or seed", null)
                store(relay, kind, seed, call.argument<Boolean>("protect") ?: true, result)
            }
            "load" -> {
                val kind = call.argument<String>("kind") ?: return result.error("args", "no kind", null)
                load(relay, kind, call.argument<String>("reason") ?: "", result)
            }
            "delete" -> {
                for (kind in listOf("main", "read")) forget(relay, kind)
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    // A key's name, as its AES key's alias and its file's: the kind and the
    // relay's URL, in one of two slots. A key kept again goes in the other
    // slot, and the first is removed only once it is written, so that a
    // prompt cancelled, or the app killed while it shows, loses neither.
    private fun name(relay: String, kind: String, slot: Int) =
        "$kind." + Base64.encodeToString(relay.toByteArray(), Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP) + if (slot == 0) "" else ".1"

    private fun file(relay: String, kind: String, slot: Int) = File(dir, name(relay, kind, slot))

    private fun forget(relay: String, kind: String, slot: Int) {
        file(relay, kind, slot).delete()
        keystore.deleteEntry(name(relay, kind, slot))
    }

    private fun forget(relay: String, kind: String) {
        forget(relay, kind, 0)
        forget(relay, kind, 1)
    }

    // The slot a key is in: its file and AES key both there, the newer if
    // both are; null when neither is. Both are there only if the app died
    // between writing one and removing the other, so both hold the same
    // seed, and a tie in lastModified (which may count whole seconds),
    // taken as slot 0, at worst keeps the old protection until the next
    // store.
    private fun slot(relay: String, kind: String): Int? =
        listOf(0, 1).filter { file(relay, kind, it).exists() && keystore.containsAlias(name(relay, kind, it)) }
            .maxByOrNull { file(relay, kind, it).lastModified() }

    private fun store(relay: String, kind: String, seed: ByteArray, protect: Boolean, result: MethodChannel.Result) {
        val old = slot(relay, kind)
        val slot = if (old == 0) 1 else 0
        forget(relay, kind, slot)
        val asks = protect && kind == "main"
        val spec = KeyGenParameterSpec.Builder(name(relay, kind, slot), KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
        if (asks) {
            spec.setUserAuthenticationRequired(true)
                .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
                // A fingerprint added later does not lose the key, as on iOS.
                .setInvalidatedByBiometricEnrollment(false)
        }
        val key = try {
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
                init(spec.build())
                generateKey()
            }
        } catch (e: InvalidAlgorithmParameterException) {
            // No screen lock to ask with.
            return result.error("no-passcode", "Set a screen lock on this phone to lock PiRC", null)
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
        use(cipher, if (asks) "Lock PiRC" else null, result, failed = { forget(relay, kind, slot) }) {
            // Whole or not at all: written beside it, then moved in.
            val f = file(relay, kind, slot)
            val part = File(dir, f.name + ".part")
            part.writeBytes(it.iv + it.doFinal(seed))
            if (!part.renameTo(f)) throw java.io.IOException("could not keep the key")
            if (old != null) forget(relay, kind, old)
            null
        }
    }

    private fun load(relay: String, kind: String, reason: String, result: MethodChannel.Result) {
        val slot = slot(relay, kind) ?: return result.success(null)
        val f = file(relay, kind, slot)
        val key = keystore.getKey(name(relay, kind, slot), null) as SecretKey? ?: return result.success(null)
        val bytes = f.readBytes()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes, 0, 12)) }
        val info = SecretKeyFactory.getInstance(key.algorithm, "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java) as KeyInfo
        val prompt = if (info.isUserAuthenticationRequired) reason.ifEmpty { "Unlock PiRC" } else null
        use(cipher, prompt, result) { it.doFinal(bytes, 12, bytes.size - 12) }
    }

    // Runs f with the cipher, after asking the person when prompt is given,
    // and answers with what it returns; failed runs first if it is not run.
    private fun use(cipher: Cipher, prompt: String?, result: MethodChannel.Result, failed: () -> Unit = {}, f: (Cipher) -> Any?) {
        if (prompt == null) return answer(result, failed) { f(cipher) }
        val activity = activity() ?: return run {
            failed()
            result.error("no-activity", "The app is not open to ask", null)
        }
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(prompt)
            .setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
            .build()
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(r: BiometricPrompt.AuthenticationResult) =
                answer(result, failed) { f(r.cryptoObject!!.cipher!!) }

            override fun onAuthenticationError(code: Int, text: CharSequence) {
                failed()
                when (code) {
                    BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON, BiometricPrompt.ERROR_CANCELED ->
                        result.error("cancelled", text.toString(), null)
                    else -> result.error("auth", text.toString(), null)
                }
            }
        }
        BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback).authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    private fun answer(result: MethodChannel.Result, failed: () -> Unit = {}, f: () -> Any?) =
        try {
            result.success(f())
        } catch (e: Exception) {
            failed()
            result.error("keystore", e.toString(), null)
        }
}
