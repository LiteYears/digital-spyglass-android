package org.darknetcrawler.mobile;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.provider.Settings;

import java.net.NetworkInterface;
import java.util.Collections;
import java.util.Enumeration;

@CapacitorPlugin(name = "PianoVpn")
public class PianoVpnPlugin extends Plugin {

    @PluginMethod
    public void isVpnActive(PluginCall call) {
        try {
            boolean vpn = checkTransportVpn() || checkTunInterface();
            JSObject ret = new JSObject();
            ret.put("active", vpn);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("VPN check failed", e);
        }
    }

    @PluginMethod
    public void isVirtualDevice(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("isVirtual", detectEmulatorBuild());
        call.resolve(ret);
    }

    static boolean detectEmulatorBuild() {
        String fp = Build.FINGERPRINT != null ? Build.FINGERPRINT : "";
        String model = Build.MODEL != null ? Build.MODEL : "";
        String manufacturer = Build.MANUFACTURER != null ? Build.MANUFACTURER : "";
        String brand = Build.BRAND != null ? Build.BRAND : "";
        String device = Build.DEVICE != null ? Build.DEVICE : "";
        String product = Build.PRODUCT != null ? Build.PRODUCT : "";
        String hardware = Build.HARDWARE != null ? Build.HARDWARE : "";
        return fp.startsWith("generic")
                || fp.startsWith("unknown")
                || model.contains("google_sdk")
                || model.contains("Emulator")
                || model.contains("Android SDK built for")
                || model.contains("sdk_gphone")
                || manufacturer.contains("Genymotion")
                || (brand.startsWith("generic") && device.startsWith("generic"))
                || "google_sdk".equals(product)
                || product.contains("sdk_gphone")
                || product.contains("emulator")
                || hardware.contains("goldfish")
                || hardware.contains("ranchu");
    }

    /**
     * Method 1: Check all networks for TRANSPORT_VPN.
     * Works for full-device VPN, may fail for per-app VPN if our app's UID
     * is not in the VPN's allowed list (Android hides those networks).
     */
    private boolean checkTransportVpn() {
        try {
            ConnectivityManager cm =
                    (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            Network[] networks = cm.getAllNetworks();
            if (networks == null) return false;
            for (Network net : networks) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(net);
                if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                    return true;
                }
            }
        } catch (Exception e) {
            /* ignore — fall through to TUN interface check */
        }
        return false;
    }

    /**
     * Method 2: Check for a TUN network interface (tun0, tun1, etc.).
     * Orbot and other VPN apps create a TUN interface when the VPN is active.
     * This works regardless of per-app VPN UID restrictions because
     * NetworkInterface enumeration is not UID-filtered.
     */
    private boolean checkTunInterface() {
        // A bare tun\d+ match cannot attribute the tunnel to Orbot — any
        // co-resident VPN app (e.g. PCAPdroid) satisfies it (Beam audit F12).
        // When the system always-on VPN package is known, only count a tun
        // interface if that package is Orbot; otherwise the tunnel is almost
        // certainly the other app's. If always-on is unset, keep the
        // heuristic (tun attribution is not exposed to apps).
        try {
            String alwaysOn = Settings.Secure.getString(
                getContext().getContentResolver(),
                "always_on_vpn_package"
            );
            if (alwaysOn != null && !alwaysOn.equals("org.torproject.android")) {
                return false;
            }
        } catch (Exception e) {
            /* setting unreadable — fall back to heuristic */
        }
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            if (interfaces == null) return false;
            for (NetworkInterface nif : Collections.list(interfaces)) {
                String name = nif.getName();
                if (name != null && name.matches("tun\\d+") && nif.isUp()) {
                    return true;
                }
            }
        } catch (Exception e) {
            /* ignore */
        }
        return false;
    }
}
