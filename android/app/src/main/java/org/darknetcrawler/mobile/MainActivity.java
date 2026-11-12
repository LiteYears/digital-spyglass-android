package org.darknetcrawler.mobile;

import android.content.pm.ApplicationInfo;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /**
     * Live bridge WebView for callers that cannot reach the Capacitor bridge
     * (PanicResponderActivity runs as a standalone panic target). Best-effort
     * only — consumers must tolerate null and stale references.
     */
    private static WebView activeWebView;

    public static WebView getActiveWebView() {
        return activeWebView;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Blocks screenshots, screen recording and the recents thumbnail.
        // Debuggable builds skip it so device testing can capture screens.
        boolean debuggable =
            (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (!debuggable) {
            getWindow().setFlags(
                WindowManager.LayoutParams.FLAG_SECURE,
                WindowManager.LayoutParams.FLAG_SECURE
            );
        }
        // Android 13+: explicitly disable Recents task snapshot generation.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            try {
                setRecentsScreenshotEnabled(false);
            } catch (Exception ignored) {
            }
        }
        // Android 12+: hide overlay windows to prevent tapjacking attacks
        // that could trick the user into interacting with invisible UI.
        // Wrapped in try/catch because some Samsung One UI builds throw
        // SecurityException even with the permission declared.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                getWindow().setHideOverlayWindows(true);
            } catch (SecurityException e) {
                // Non-fatal: FLAG_SECURE already provides the primary defense
            }
        }
        // Scrub any leftover export or WebView cache files from previous sessions.
        PianoScreenPlugin.scrubEphemeralDiskArtifacts(this);
        // VPN transport detection: @capacitor/network does not report TRANSPORT_VPN.
        registerPlugin(PianoVpnPlugin.class);
        // Tor SOCKS5 HTTP: bypasses system DNS for .onion via Orbot localhost:9050.
        registerPlugin(PianoTorHttpPlugin.class);
        // Screen-off detection: purge session when screen saver / lock activates.
        registerPlugin(PianoScreenPlugin.class);
        // Registry trust anchor: exposes this APK's signing-cert public key so
        // the WebView can verify the bundled engines.sig.json (RSA-PSS).
        registerPlugin(PianoRegistryAnchorPlugin.class);
        // Local inference transport for query-content privacy: raw loopback
        // socket to 127.0.0.1 (WebView fetch is blocked by the cleartext policy).
        registerPlugin(PianoLocalInferencePlugin.class);
        super.onCreate(savedInstanceState);

        try {
            WebView wv = getBridge() != null ? getBridge().getWebView() : null;
            activeWebView = wv;
            if (wv != null) {
                WebSettings ws = wv.getSettings();
                ws.setCacheMode(WebSettings.LOAD_NO_CACHE);
                ws.setSaveFormData(false);
                // Opt the WebView out of the platform autofill framework so the
                // OS has no reason to fetch form-detection models from Google.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    wv.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
                }
            }
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onPause() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            try {
                if (getWindow() != null && getWindow().getDecorView() != null) {
                    getWindow().getDecorView().setAlpha(0f);
                }
            } catch (Exception ignored) {
            }
        }
        super.onPause();
    }

    @Override
    public void onResume() {
        super.onResume();
        try {
            activeWebView = getBridge() != null ? getBridge().getWebView() : null;
        } catch (Exception ignored) {
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            try {
                if (getWindow() != null && getWindow().getDecorView() != null) {
                    getWindow().getDecorView().setAlpha(1f);
                }
            } catch (Exception ignored) {
            }
        }
    }

    @Override
    public void onDestroy() {
        activeWebView = null;
        super.onDestroy();
    }

    /**
     * Prevent Android from saving activity state across process death.
     * Ghost is RAM-only — any saved state would persist sensitive data
     * (queries, results) to disk, violating the anti-forensics model.
     */
    @Override
    public void onSaveInstanceState(Bundle outState) {
        try {
            super.onSaveInstanceState(outState);
        } finally {
            outState.clear();
        }
    }
}
