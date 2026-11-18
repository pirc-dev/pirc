// Play Integrity for the hosted relay (docs/e2e.md, section 6;
// docs/design.md, step 14), over 'dev.pirc.app/attest': a classic request
// whose nonce is base64url(SHA-256(what the relay's login binds)), with
// the Cloud project linked to the app in Play Console. The relay has
// Google decode the token.
package dev.pirc.platform

import android.content.Context
import android.util.Base64
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.IntegrityTokenRequest
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.security.MessageDigest

// The Firebase project's, linked to the app for Play Integrity.
private const val CLOUD_PROJECT = 811217912464L

class Attest(private val context: Context) : MethodChannel.MethodCallHandler {
    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val data = call.arguments as? ByteArray
        if (call.method != "attest" || data == null) return result.notImplemented()
        val hash = MessageDigest.getInstance("SHA-256").digest(data)
        val nonce = Base64.encodeToString(hash, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        IntegrityManagerFactory.create(context)
            .requestIntegrityToken(IntegrityTokenRequest.builder().setNonce(nonce).setCloudProjectNumber(CLOUD_PROJECT).build())
            .addOnSuccessListener { result.success(mapOf("token" to it.token())) }
            .addOnFailureListener { result.error("attest", it.message, null) }
    }
}
