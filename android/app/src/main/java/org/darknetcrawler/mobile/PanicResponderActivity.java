package org.darknetcrawler.mobile;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/**
 * Guardian Project PanicKit responder activity.
 *
 * Responds to system-wide emergency triggers (e.g. Guardian Project's Ripple
 * panic button sending "info.guardianproject.panic.action.TRIGGER") by
 * immediately executing Ghost's full anti-forensic wipe and terminating the
 * application process.
 */
public class PanicResponderActivity extends Activity {

    public static final String PANIC_TRIGGER_ACTION = "info.guardianproject.panic.action.TRIGGER";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent intent = getIntent();
        if (intent != null && PANIC_TRIGGER_ACTION.equals(intent.getAction())) {
            // Pass the live bridge WebView so its in-memory clears run on the
            // PanicKit path too (was null — skipped webview wipe entirely).
            PianoScreenPlugin.executeHardPanicWipe(this, MainActivity.getActiveWebView());
            return;
        }
        finish();
    }
}
