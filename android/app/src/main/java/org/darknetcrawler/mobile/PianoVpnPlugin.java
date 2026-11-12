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

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.util.Collections;
import java.util.Enumeration;
import java.util.Locale;

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
    public void isTorSocksReachable(PluginCall call) {
        String host = call.getString("host", "127.0.0.1");
        Integer portObj = call.getInt("port");
        int targetPort = (portObj != null && portObj >= 1 && portObj <= 65535) ? portObj : 9050;
        int[] portsToTry = (targetPort == 9050 && "127.0.0.1".equals(host))
                ? new int[]{9050, 9150} : new int[]{targetPort};
        new Thread(() -> {
            boolean reachable = false;
            int activePort = targetPort;
            for (int p : portsToTry) {
                try (Socket socket = new Socket()) {
                    socket.connect(new InetSocketAddress(host, p), 2000);
                    socket.setSoTimeout(2000);
                    OutputStream out = socket.getOutputStream();
                    InputStream in = socket.getInputStream();
                    out.write(new byte[]{0x05, 0x01, 0x00});
                    out.flush();
                    int ver = in.read();
                    int method = in.read();
                    if (ver == 0x05) {
                        reachable = true;
                        activePort = p;
                        break;
                    }
                } catch (Exception ignored) {
                }
            }
            JSObject ret = new JSObject();
            ret.put("reachable", reachable);
            ret.put("port", activePort);
            call.resolve(ret);
        }, "PianoVpn-SocksCheck").start();
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
     * Method 1: Check active network and all networks for TRANSPORT_VPN.
     */
    private boolean checkTransportVpn() {
        try {
            ConnectivityManager cm =
                    (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;

            // Direct check on active network
            Network activeNet = cm.getActiveNetwork();
            if (activeNet != null) {
                NetworkCapabilities activeCaps = cm.getNetworkCapabilities(activeNet);
                if (activeCaps != null && activeCaps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                    return true;
                }
            }

            // Check across all registered networks
            Network[] networks = cm.getAllNetworks();
            if (networks != null) {
                for (Network net : networks) {
                    NetworkCapabilities caps = cm.getNetworkCapabilities(net);
                    if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                        return true;
                    }
                }
            }
        } catch (Exception e) {
            /* ignore — fall through to TUN interface check */
        }
        return false;
    }

    /**
     * Method 2: Check for active TUN network interfaces (tun0, tun1, etc.).
     */
    private boolean checkTunInterface() {
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            if (interfaces == null) return false;
            for (NetworkInterface nif : Collections.list(interfaces)) {
                String name = nif.getName();
                if (name != null && name.toLowerCase(Locale.ROOT).matches("tun\\d*|ppp\\d*|wg\\d*") && nif.isUp()) {
                    return true;
                }
            }
        } catch (Exception e) {
            /* ignore */
        }
        return false;
    }
}
