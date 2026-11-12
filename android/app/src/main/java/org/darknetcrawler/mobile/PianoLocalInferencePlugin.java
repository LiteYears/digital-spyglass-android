package org.darknetcrawler.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;

/**
 * Local inference transport for the query-content privacy layer (27v).
 *
 * WebView fetch to http://127.0.0.1 is blocked by the network security
 * cleartext policy (measured: net::ERR_CLEARTEXT_NOT_PERMITTED), and the
 * policy must not be relaxed. This plugin speaks plain HTTP/1.1 over a raw
 * java.net.Socket to literal 127.0.0.1 only — raw sockets are not subject
 * to the NSC cleartext gate (that applies to HttpURLConnection/OkHttp),
 * and no cleartext ever leaves the device.
 *
 * Hard loopback binding: the host is the 4 literal bytes 127.0.0.1 passed
 * to InetAddress.getByAddress — no DNS lookup anywhere, no LAN ranges, no
 * IPv6, no caller-supplied host. Reachability of the user's local
 * inference server (e.g. llama.cpp llama-server /v1/chat/completions) is
 * probed at call time; a dead endpoint degrades to "unavailable".
 *
 * Error contract: rejects with a short generic code only
 * (bad_args, unavailable, timeout, cancelled, bad_response, too_large).
 * Prompt and response content never appear in errors or logs, and nothing
 * is persisted — no files, no preferences.
 */
@CapacitorPlugin(name = "PianoLocalInference")
public class PianoLocalInferencePlugin extends Plugin {

    private static final byte[] LOOPBACK = new byte[]{127, 0, 0, 1};
    private static final String REQUEST_PATH = "/v1/chat/completions";
    private static final int CONNECT_TIMEOUT_MS = 2_000;
    private static final int MAX_HEADER_BYTES = 16 * 1024;
    private static final int MAX_BODY_BYTES = 64 * 1024;
    private static final int MAX_PROMPT_CHARS = 4_096;
    private static final int MAX_CONTENT_CHARS = 4_096;
    private static final int MIN_PORT = 1_024;
    private static final int MAX_PORT = 65_535;
    private static final int MIN_TIMEOUT_MS = 1_000;
    private static final int MAX_TIMEOUT_MS = 60_000;
    private static final int MAX_TOKENS = 512;
    private static final int MAX_IN_FLIGHT = 4;
    private static final Pattern CALL_ID = Pattern.compile("^[A-Za-z0-9_-]{1,64}$");

    private static final int RUNNING = 0;
    private static final int DONE = 1;
    private static final int CANCELLED = 2;
    private static final int TIMED_OUT = 3;

    static final class CallHandle {
        final Socket socket = new Socket();
        final AtomicInteger state = new AtomicInteger(RUNNING);
    }

    static final class InferenceException extends Exception {
        final String code;
        InferenceException(String code) {
            super(code);
            this.code = code;
        }
    }

    private static final ConcurrentHashMap<String, CallHandle> IN_FLIGHT = new ConcurrentHashMap<>();
    private static final Object ADMISSION = new Object();

    private static ThreadFactory daemonThreads(final String name) {
        return (Runnable r) -> {
            Thread t = new Thread(r, name);
            t.setDaemon(true);
            return t;
        };
    }

    private static final ExecutorService EXECUTOR =
            Executors.newFixedThreadPool(MAX_IN_FLIGHT, daemonThreads("PianoLocalInference-call"));
    private static final ScheduledExecutorService WATCHDOGS =
            Executors.newScheduledThreadPool(1, daemonThreads("PianoLocalInference-watchdog"));

    static int inFlightCount() {
        return IN_FLIGHT.size();
    }

    @PluginMethod
    public void complete(final PluginCall call) {
        final Integer port = call.getInt("port");
        final String system = call.getString("system");
        final String user = call.getString("user");
        final Integer maxTokens = call.getInt("maxTokens");
        final Integer timeoutMs = call.getInt("timeoutMs");
        final String callId = call.getString("callId");
        String error = validateArgs(port, system, user, maxTokens, timeoutMs, callId);
        if (error != null) {
            call.reject(error);
            return;
        }
        final CallHandle handle;
        try {
            handle = admit(callId);
        } catch (InferenceException e) {
            call.reject(e.code);
            return;
        }
        // Admission happens on the caller thread so a cancel() that arrives
        // before the executor starts still finds and closes the socket.
        EXECUTOR.execute(() -> executeAndDeliver(handle, callId, port, system, user,
                maxTokens, timeoutMs, new Delivery() {
                    @Override
                    public void resolved(String text) {
                        JSObject result = new JSObject();
                        result.put("text", text);
                        call.resolve(result);
                    }

                    @Override
                    public void rejected(String code) {
                        call.reject(code);
                    }
                }));
    }

    @PluginMethod
    public void cancel(final PluginCall call) {
        cancelCall(call.getString("callId"));
        call.resolve();
    }

    @Override
    public void handleOnDestroy() {
        for (CallHandle handle : IN_FLIGHT.values()) {
            if (handle.state.compareAndSet(RUNNING, CANCELLED)) {
                try {
                    handle.socket.close();
                } catch (IOException ignored) {
                }
            }
        }
    }

    static String validateArgs(Integer port, String system, String user,
                               Integer maxTokens, Integer timeoutMs, String callId) {
        if (port == null || port < MIN_PORT || port > MAX_PORT) return "bad_args";
        if (system == null || system.length() > MAX_PROMPT_CHARS) return "bad_args";
        if (user == null || user.length() > MAX_PROMPT_CHARS) return "bad_args";
        if (maxTokens == null || maxTokens < 1 || maxTokens > MAX_TOKENS) return "bad_args";
        if (timeoutMs == null || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
            return "bad_args";
        }
        if (callId == null || !CALL_ID.matcher(callId).matches()) return "bad_args";
        return null;
    }

    static CallHandle admit(String callId) throws InferenceException {
        synchronized (ADMISSION) {
            if (IN_FLIGHT.containsKey(callId)) {
                throw new InferenceException("bad_args");
            }
            if (IN_FLIGHT.size() >= MAX_IN_FLIGHT) {
                throw new InferenceException("unavailable");
            }
            CallHandle handle = new CallHandle();
            IN_FLIGHT.put(callId, handle);
            return handle;
        }
    }

    static void release(String callId, CallHandle handle) {
        IN_FLIGHT.remove(callId, handle);
        try {
            handle.socket.close();
        } catch (IOException ignored) {
        }
    }

    static void cancelCall(String callId) {
        if (callId == null) return;
        CallHandle handle = IN_FLIGHT.get(callId);
        if (handle != null && handle.state.compareAndSet(RUNNING, CANCELLED)) {
            try {
                handle.socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    /**
     * Full lifecycle for tests: validate -> admit -> run -> release.
     */
    static String executeCall(int port, String system, String user,
                              int maxTokens, int timeoutMs, String callId) throws InferenceException {
        String error = validateArgs(port, system, user, maxTokens, timeoutMs, callId);
        if (error != null) throw new InferenceException(error);
        CallHandle handle = admit(callId);
        try {
            return runCall(handle, port, system, user, maxTokens, timeoutMs);
        } finally {
            release(callId, handle);
        }
    }

    /**
     * Runs the call and delivers the outcome. The in-flight slot is released
     * BEFORE resolved/rejected fires — a caller that immediately issues the
     * next request must never see the slot still occupied.
     */
    static void executeAndDeliver(CallHandle handle, String callId, int port,
                                  String system, String user, int maxTokens,
                                  int timeoutMs, Delivery delivery) {
        String text = null;
        InferenceException failure = null;
        try {
            text = runCall(handle, port, system, user, maxTokens, timeoutMs);
        } catch (InferenceException e) {
            failure = e;
        } catch (Exception e) {
            failure = new InferenceException("bad_response");
        } finally {
            release(callId, handle);
        }
        if (failure != null) {
            delivery.rejected(failure.code);
        } else {
            delivery.resolved(text);
        }
    }

    interface Delivery {
        void resolved(String text);
        void rejected(String code);
    }

    /**
     * Single attempt over a raw socket. The overall deadline is enforced by a
     * watchdog that closes the socket — SO_TIMEOUT alone cannot stop a
     * slow-drip server, and close() interrupts connect/read/write alike.
     */
    static String runCall(CallHandle handle, int port, String system, String user,
                          int maxTokens, int timeoutMs) throws InferenceException {
        final Socket socket = handle.socket;
        ScheduledFuture<?> watchdog = WATCHDOGS.schedule(() -> {
            if (handle.state.compareAndSet(RUNNING, TIMED_OUT)) {
                try {
                    socket.close();
                } catch (IOException ignored) {
                }
            }
        }, timeoutMs, TimeUnit.MILLISECONDS);
        try {
            socket.connect(
                    new InetSocketAddress(InetAddress.getByAddress(LOOPBACK), port),
                    CONNECT_TIMEOUT_MS);
            socket.setSoTimeout(timeoutMs);
            OutputStream out = socket.getOutputStream();
            out.write(buildRequest(port, system, user, maxTokens));
            out.flush();
            String text = readResponse(socket.getInputStream());
            if (!handle.state.compareAndSet(RUNNING, DONE)) {
                throw new InferenceException(handle.state.get() == CANCELLED ? "cancelled" : "timeout");
            }
            return text;
        } catch (InferenceException e) {
            throw e;
        } catch (IOException e) {
            int state = handle.state.get();
            if (state == CANCELLED) throw new InferenceException("cancelled");
            if (state == TIMED_OUT || e instanceof SocketTimeoutException) {
                throw new InferenceException("timeout");
            }
            throw new InferenceException("unavailable");
        } finally {
            watchdog.cancel(false);
        }
    }

    static byte[] buildRequest(int port, String system, String user, int maxTokens) {
        // JSONObject escapes every control/quote character: prompt text can
        // only ever reach the body, never the header section.
        final byte[] body;
        try {
            JSONArray messages = new JSONArray();
            messages.put(new JSONObject().put("role", "system").put("content", system));
            messages.put(new JSONObject().put("role", "user").put("content", user));
            body = new JSONObject()
                    .put("messages", messages)
                    .put("max_tokens", maxTokens)
                    .put("temperature", 0.7d)
                    .put("stream", false)
                    .toString()
                    .getBytes(StandardCharsets.UTF_8);
        } catch (JSONException e) {
            throw new IllegalArgumentException("bad_args");
        }
        byte[] head = ("POST " + REQUEST_PATH + " HTTP/1.1\r\n"
                + "Host: 127.0.0.1:" + port + "\r\n"
                + "Content-Type: application/json\r\n"
                + "Accept: application/json\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Connection: close\r\n"
                + "\r\n").getBytes(StandardCharsets.US_ASCII);
        byte[] request = new byte[head.length + body.length];
        System.arraycopy(head, 0, request, 0, head.length);
        System.arraycopy(body, 0, request, head.length, body.length);
        return request;
    }

    /**
     * Reads one bounded HTTP response: header section <= 16 KiB, body <=
     * 64 KiB. Only status 200 is accepted; framing is Content-Length,
     * chunked, or close-delimited. Protocol violations map to bad_response,
     * size violations to too_large; transport errors stay IOException so the
     * caller can classify them.
     */
    static String readResponse(InputStream in) throws IOException, InferenceException {
        ByteArrayOutputStream raw = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int headerEnd = -1;
        while (headerEnd < 0) {
            int n = in.read(buf);
            if (n < 0) throw new InferenceException("bad_response");
            raw.write(buf, 0, n);
            headerEnd = headerEnd(raw.toByteArray());
            if (headerEnd < 0 && raw.size() > MAX_HEADER_BYTES) {
                throw new InferenceException("too_large");
            }
        }
        if (headerEnd > MAX_HEADER_BYTES) throw new InferenceException("too_large");
        int bodyOffset = headerEnd + 4;
        String head = new String(raw.toByteArray(), 0, headerEnd, StandardCharsets.ISO_8859_1);

        String[] lines = head.split("\r\n", -1);
        String statusLine = lines[0];
        if (!statusLine.startsWith("HTTP/")) throw new InferenceException("bad_response");
        int sp = statusLine.indexOf(' ');
        if (sp <= 0) throw new InferenceException("bad_response");
        int sp2 = statusLine.indexOf(' ', sp + 1);
        String codeStr = sp2 > 0 ? statusLine.substring(sp + 1, sp2) : statusLine.substring(sp + 1);
        final int status;
        try {
            status = Integer.parseInt(codeStr.trim());
        } catch (NumberFormatException e) {
            throw new InferenceException("bad_response");
        }
        // Redirects are never followed — anything but 200 is a failure.
        if (status != 200) throw new InferenceException("bad_response");

        boolean chunked = false;
        long contentLength = -1;
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':');
            if (colon <= 0) continue;
            String name = lines[i].substring(0, colon).trim().toLowerCase(Locale.ROOT);
            String value = lines[i].substring(colon + 1).trim();
            if ("transfer-encoding".equals(name)
                    && value.toLowerCase(Locale.ROOT).contains("chunked")) {
                chunked = true;
            } else if ("content-length".equals(name)) {
                try {
                    contentLength = Long.parseLong(value);
                } catch (NumberFormatException e) {
                    throw new InferenceException("bad_response");
                }
            }
        }

        final byte[] body;
        if (chunked) {
            while (!PianoTorHttpPlugin.hasChunkedTerminator(raw.toByteArray(), bodyOffset)) {
                if (raw.size() - bodyOffset > MAX_BODY_BYTES) {
                    throw new InferenceException("too_large");
                }
                int n = in.read(buf);
                if (n < 0) throw new InferenceException("bad_response");
                raw.write(buf, 0, n);
            }
            if (raw.size() - bodyOffset > MAX_BODY_BYTES) throw new InferenceException("too_large");
            byte[] wire = new byte[raw.size() - bodyOffset];
            System.arraycopy(raw.toByteArray(), bodyOffset, wire, 0, wire.length);
            try {
                body = PianoTorHttpPlugin.decodeChunked(wire);
            } catch (IOException e) {
                throw new InferenceException("bad_response");
            }
            if (body.length > MAX_BODY_BYTES) throw new InferenceException("too_large");
        } else if (contentLength >= 0) {
            if (contentLength > MAX_BODY_BYTES) throw new InferenceException("too_large");
            while (raw.size() - bodyOffset < contentLength) {
                int n = in.read(buf);
                if (n < 0) throw new InferenceException("bad_response");
                raw.write(buf, 0, n);
            }
            body = new byte[(int) contentLength];
            System.arraycopy(raw.toByteArray(), bodyOffset, body, 0, body.length);
        } else {
            int n;
            while ((n = in.read(buf)) >= 0) {
                raw.write(buf, 0, n);
                if (raw.size() - bodyOffset > MAX_BODY_BYTES) {
                    throw new InferenceException("too_large");
                }
            }
            body = new byte[raw.size() - bodyOffset];
            System.arraycopy(raw.toByteArray(), bodyOffset, body, 0, body.length);
        }

        try {
            JSONObject root = new JSONObject(new String(body, StandardCharsets.UTF_8));
            JSONArray choices = root.getJSONArray("choices");
            if (choices.length() < 1) throw new InferenceException("bad_response");
            Object content = choices.getJSONObject(0).getJSONObject("message").opt("content");
            if (!(content instanceof String)) throw new InferenceException("bad_response");
            String text = (String) content;
            if (text.trim().isEmpty() || text.length() > MAX_CONTENT_CHARS) {
                throw new InferenceException("bad_response");
            }
            return text;
        } catch (JSONException e) {
            throw new InferenceException("bad_response");
        }
    }

    private static int headerEnd(byte[] data) {
        for (int i = 0; i <= data.length - 4; i++) {
            if (data[i] == '\r' && data[i + 1] == '\n'
                    && data[i + 2] == '\r' && data[i + 3] == '\n') {
                return i;
            }
        }
        return -1;
    }
}
