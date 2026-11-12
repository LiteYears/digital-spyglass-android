package org.darknetcrawler.mobile;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Process;
import android.webkit.CookieManager;
import android.webkit.WebStorage;
import android.webkit.WebView;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.RandomAccessFile;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Screen state detector & anti-forensic panic wipe plugin.
 *
 * 1. Fires a "screenOff" Capacitor event when ACTION_SCREEN_OFF is received so
 *    the JS layer purges RAM session data on device lock.
 * 2. Provides panicWipeAndKill() (and static executeHardPanicWipe()) implementing
 *    OWASP MASTG-TEST-0037 + Molly/NewPipe anti-forensic teardown:
 *      - Clears in-memory Tor SOCKS5 cookie jar
 *      - Clears WebView RAM/disk cache, form data, history, WebStorage, and cookies
 *      - Overwrites with zeroes and unlinks files in cacheDir, codeCacheDir, and app_webview
 *      - Calls Activity.finishAndRemoveTask() to drop the Recents card
 *      - Terminates the Linux process via Process.killProcess + Runtime.halt(0)
 */
@CapacitorPlugin(name = "PianoScreen")
public class PianoScreenPlugin extends Plugin {

    private static final AtomicBoolean WIPE_IN_PROGRESS = new AtomicBoolean(false);
    private BroadcastReceiver screenReceiver;

    @Override
    public void load() {
        screenReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (Intent.ACTION_SCREEN_OFF.equals(intent.getAction())) {
                    PianoTorHttpPlugin.clearCookieJarStatic();
                    notifyListeners("screenOff", new JSObject());
                }
            }
        };
        IntentFilter filter = new IntentFilter(Intent.ACTION_SCREEN_OFF);
        ContextCompat.registerReceiver(
                getContext(),
                screenReceiver,
                filter,
                ContextCompat.RECEIVER_NOT_EXPORTED
        );
    }

    @PluginMethod
    public void panicWipeAndKill(final PluginCall call) {
        final Activity activity = getActivity();
        final Context context = getContext();
        call.resolve();
        if (activity != null) {
            activity.runOnUiThread(() -> executeHardPanicWipe(activity, findBridgeWebView()));
        } else {
            executeHardPanicWipe(context, null);
        }
    }

    private WebView findBridgeWebView() {
        try {
            return getBridge() != null ? getBridge().getWebView() : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    public static void scrubEphemeralDiskArtifacts(Context context) {
        if (context == null) return;
        try {
            File exportsDir = new File(context.getCacheDir(), "piano");
            shredRecursively(exportsDir, false);
            File webViewCache = new File(context.getCacheDir(), "WebView");
            shredRecursively(webViewCache, false);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                File dataDir = context.getDataDir();
                if (dataDir != null) {
                    File appWebViewDefault = new File(new File(dataDir, "app_webview"), "Default");
                    shredRecursively(new File(appWebViewDefault, "Cache"), false);
                    shredRecursively(new File(appWebViewDefault, "Code Cache"), false);
                }
            }
        } catch (Exception ignored) {
        }
    }

    public static void executeHardPanicWipe(Context context, WebView webView) {
        if (!WIPE_IN_PROGRESS.compareAndSet(false, true)) {
            return;
        }
        try {
            PianoTorHttpPlugin.clearCookieJarStatic();
        } catch (Exception ignored) {
        }

        try {
            if (webView != null) {
                webView.stopLoading();
                webView.loadUrl("about:blank");
                webView.clearCache(true);
                webView.clearFormData();
                webView.clearHistory();
            }
        } catch (Exception ignored) {
        }

        try {
            WebStorage.getInstance().deleteAllData();
        } catch (Exception ignored) {
        }

        try {
            CookieManager cm = CookieManager.getInstance();
            cm.removeAllCookies(null);
            cm.flush();
        } catch (Exception ignored) {
        }

        if (context != null) {
            // Most sensitive first and isolated: shared_prefs holds the registry
            // import and trusted keys — a failure in a later shred must never
            // leave them behind (an earlier exception would skip the rest of a
            // shared try block).
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                try {
                    File dataDir = context.getDataDir();
                    if (dataDir != null) {
                        shredRecursively(new File(dataDir, "shared_prefs"), true);
                    }
                } catch (Exception ignored) {
                }
            }
            try {
                shredRecursively(context.getCacheDir(), false);
                shredRecursively(context.getCodeCacheDir(), false);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    File dataDir = context.getDataDir();
                    if (dataDir != null) {
                        shredRecursively(new File(dataDir, "app_webview"), true);
                    }
                }
            } catch (Exception ignored) {
            }
        }

        if (context instanceof Activity) {
            Activity act = (Activity) context;
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    act.finishAndRemoveTask();
                } else {
                    act.finish();
                }
            } catch (Exception ignored) {
            }
        }

        Process.killProcess(Process.myPid());
        Runtime.getRuntime().halt(0);
    }

    private static void shredRecursively(File target, boolean deleteRoot) {
        if (target == null || !target.exists()) return;
        if (target.isDirectory()) {
            File[] children = target.listFiles();
            if (children != null) {
                for (File child : children) {
                    shredRecursively(child, true);
                }
            }
            if (deleteRoot) {
                //noinspection ResultOfMethodCallIgnored
                target.delete();
            }
        } else if (target.isFile()) {
            long len = target.length();
            if (len > 0 && len <= 16 * 1024 * 1024) {
                try (RandomAccessFile raf = new RandomAccessFile(target, "rws")) {
                    byte[] zeroes = new byte[4096];
                    long rem = len;
                    while (rem > 0) {
                        int n = (int) Math.min(zeroes.length, rem);
                        raf.write(zeroes, 0, n);
                        rem -= n;
                    }
                } catch (Exception ignored) {
                }
            }
            //noinspection ResultOfMethodCallIgnored
            target.delete();
        }
    }

    @Override
    public void handleOnDestroy() {
        if (screenReceiver != null) {
            try {
                getContext().unregisterReceiver(screenReceiver);
            } catch (Exception ignored) {
            }
            screenReceiver = null;
        }
    }
}
