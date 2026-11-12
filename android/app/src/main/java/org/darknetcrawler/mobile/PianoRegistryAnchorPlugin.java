package org.darknetcrawler.mobile;

import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.io.ByteArrayInputStream;

/**
 * Registry trust anchor: hands the WebView the public key of whoever signed
 * this APK. The JS layer verifies engines.sig.json (a detached RSA-PSS
 * signature over the canonical engine registry) against this key — proving the
 * registry was authored by the same key that signed the APK, i.e. the identity
 * F-Droid pins via AllowedAPKSigningKeys. There is no embedded second key:
 * the anchor is derived from the platform, not bundled with the data it
 * vouches for.
 */
@CapacitorPlugin(name = "PianoRegistryAnchor")
public class PianoRegistryAnchorPlugin extends Plugin {

    @PluginMethod
    public void getRegistryAnchor(PluginCall call) {
        try {
            byte[] certBytes = readSignerCertBytes();
            if (certBytes == null) {
                call.reject("no signing certificate found");
                return;
            }
            CertificateFactory cf = CertificateFactory.getInstance("X.509");
            X509Certificate cert = (X509Certificate)
                    cf.generateCertificate(new ByteArrayInputStream(certBytes));
            byte[] spki = cert.getPublicKey().getEncoded();
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(certBytes);

            JSObject ret = new JSObject();
            ret.put("spkiBase64", Base64.encodeToString(spki, Base64.NO_WRAP));
            ret.put("certSha256", toHex(digest));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("registry anchor unavailable", e);
        }
    }

    private byte[] readSignerCertBytes() throws PackageManager.NameNotFoundException {
        PackageManager pm = getContext().getPackageManager();
        String pkg = getContext().getPackageName();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageInfo info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES);
            if (info.signingInfo == null) return null;
            Signature[] signers = info.signingInfo.getApkContentsSigners();
            if (signers == null || signers.length == 0) return null;
            return signers[0].toByteArray();
        }
        @SuppressWarnings("deprecation")
        PackageInfo info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES);
        @SuppressWarnings("deprecation")
        Signature[] sigs = info.signatures;
        if (sigs == null || sigs.length == 0) return null;
        return sigs[0].toByteArray();
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format("%02x", b & 0xff));
        return sb.toString();
    }
}
