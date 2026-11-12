package org.darknetcrawler.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;

/**
 * Local-loopback tests for PianoLocalInferencePlugin (27v transport):
 * a real ServerSocket on 127.0.0.1 stands in for the user's llama.cpp /
 * OpenAI-compatible endpoint while executeCall speaks raw HTTP/1.1.
 */
public class PianoLocalInferencePluginTest {

    @After
    public void noLingeringInFlightCalls() {
        assertEquals("in-flight map must be empty after each test",
                0, PianoLocalInferencePlugin.inFlightCount());
    }

    private static String chatBody(String content) {
        return "{\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":"
                + JSONObject.quote(content) + "}}]}";
    }

    private static String okResponse(String content) {
        byte[] body = chatBody(content).getBytes(StandardCharsets.UTF_8);
        return "HTTP/1.1 200 OK\r\nContent-Length: " + body.length + "\r\n\r\n" + chatBody(content);
    }

    /** Returns the generic error code, or fails when the call unexpectedly succeeds. */
    private static String runErr(int port, String system, String user,
                                 int maxTokens, int timeoutMs, String callId) {
        try {
            PianoLocalInferencePlugin.executeCall(port, system, user, maxTokens, timeoutMs, callId);
            fail("expected InferenceException");
            return null;
        } catch (PianoLocalInferencePlugin.InferenceException e) {
            return e.code;
        }
    }

    /** Accepts one connection, reads the full request, writes the response. */
    private static Thread serveOnce(ServerSocket server, String response,
                                    List<byte[]> captured) {
        Thread t = new Thread(() -> {
            try (Socket client = server.accept()) {
                byte[] request = readRequest(client);
                if (captured != null) captured.add(request);
                client.getOutputStream().write(response.getBytes(StandardCharsets.UTF_8));
                client.getOutputStream().flush();
            } catch (Exception ignored) {
            }
        });
        t.start();
        return t;
    }

    private static byte[] readRequest(Socket client) throws IOException {
        InputStream in = client.getInputStream();
        String head = readUntilDoubleCrLf(in);
        int contentLength = 0;
        for (String line : head.split("\r\n")) {
            int colon = line.indexOf(':');
            if (colon > 0 && "content-length".equalsIgnoreCase(line.substring(0, colon).trim())) {
                contentLength = Integer.parseInt(line.substring(colon + 1).trim());
            }
        }
        byte[] body = readExact(in, contentLength);
        byte[] headBytes = head.getBytes(StandardCharsets.ISO_8859_1);
        byte[] request = new byte[headBytes.length + body.length];
        System.arraycopy(headBytes, 0, request, 0, headBytes.length);
        System.arraycopy(body, 0, request, headBytes.length, body.length);
        return request;
    }

    private static byte[] readExact(InputStream in, int n) throws IOException {
        byte[] buf = new byte[n];
        int off = 0;
        while (off < n) {
            int r = in.read(buf, off, n - off);
            if (r < 0) throw new IOException("EOF");
            off += r;
        }
        return buf;
    }

    private static String readUntilDoubleCrLf(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        int b;
        while ((b = in.read()) >= 0) {
            bos.write(b);
            byte[] arr = bos.toByteArray();
            int len = arr.length;
            if (len >= 4 && arr[len - 4] == '\r' && arr[len - 3] == '\n'
                    && arr[len - 2] == '\r' && arr[len - 1] == '\n') {
                break;
            }
        }
        return new String(bos.toByteArray(), StandardCharsets.ISO_8859_1);
    }

    /** A port nothing listens on (grabbed then released). */
    private static int refusedPort() throws IOException {
        try (ServerSocket s = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            return s.getLocalPort();
        }
    }

    @Test
    public void testHappyPathContentLength() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = serveOnce(server, okResponse("museum opening hours"), null);
            String text = PianoLocalInferencePlugin.executeCall(
                    port, "sys", "museum hours?", 128, 5000, "happy1");
            t.join(5000);
            assertEquals("museum opening hours", text);
        }
    }

    @Test
    public void testChunkedResponse() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            String body = chatBody("decoded chunked content");
            int split = 11;
            String response = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
                    + Integer.toHexString(split) + "\r\n" + body.substring(0, split) + "\r\n"
                    + Integer.toHexString(body.length() - split) + "\r\n"
                    + body.substring(split) + "\r\n0\r\n\r\n";
            Thread t = serveOnce(server, response, null);
            String text = PianoLocalInferencePlugin.executeCall(
                    port, "sys", "user", 128, 5000, "chunk1");
            t.join(5000);
            assertEquals("decoded chunked content", text);
        }
    }

    @Test
    public void testCloseDelimitedResponse() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            // No Content-Length and no Transfer-Encoding: body runs to EOF.
            String response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n"
                    + chatBody("close delimited answer");
            Thread t = serveOnce(server, response, null);
            String text = PianoLocalInferencePlugin.executeCall(
                    port, "sys", "user", 128, 5000, "close1");
            t.join(5000);
            assertEquals("close delimited answer", text);
        }
    }

    @Test
    public void testRequestBytesExact() throws Exception {
        final List<byte[]> captured = new ArrayList<>();
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = serveOnce(server, okResponse("ok"), captured);
            PianoLocalInferencePlugin.executeCall(
                    port, "system prompt", "the user query", 128, 5000, "exact1");
            t.join(5000);
            assertEquals(1, captured.size());
            byte[] request = captured.get(0);
            String all = new String(request, StandardCharsets.UTF_8);
            int headerEnd = all.indexOf("\r\n\r\n");
            assertTrue(headerEnd > 0);
            String head = all.substring(0, headerEnd + 4);
            String body = all.substring(headerEnd + 4);

            // Exact header section — no extra headers, exactly this set/order.
            assertTrue(head.startsWith("POST /v1/chat/completions HTTP/1.1\r\n"));
            assertTrue(head.contains("Host: 127.0.0.1:" + port + "\r\n"));
            assertTrue(head.contains("Content-Type: application/json\r\n"));
            assertTrue(head.contains("Accept: application/json\r\n"));
            assertTrue(head.contains("Content-Length: "
                    + body.getBytes(StandardCharsets.UTF_8).length + "\r\n"));
            assertTrue(head.endsWith("Connection: close\r\n\r\n"));
            // Request line + exactly the five specified headers (split drops
            // the trailing empty segment after the final CRLF).
            assertEquals("exactly five header lines plus the request line",
                    6, head.split("\r\n").length);

            JSONObject parsed = new JSONObject(body);
            JSONArray messages = parsed.getJSONArray("messages");
            assertEquals(2, messages.length());
            assertEquals("system", messages.getJSONObject(0).getString("role"));
            assertEquals("system prompt", messages.getJSONObject(0).getString("content"));
            assertEquals("user", messages.getJSONObject(1).getString("role"));
            assertEquals("the user query", messages.getJSONObject(1).getString("content"));
            assertEquals(128, parsed.getInt("max_tokens"));
            assertEquals(0.7d, parsed.getDouble("temperature"), 0.0001d);
            assertFalse(parsed.getBoolean("stream"));
        }
    }

    @Test
    public void testCrlfQuoteUnicodeInPromptsStayInsideBody() throws Exception {
        final List<byte[]> captured = new ArrayList<>();
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            String system = "line one\r\nInjected-Header: evil\r\n\r\n\"quoted\" äöü";
            String user = "q\"\r\nX-Extra: 1 €日";
            Thread t = serveOnce(server, okResponse("ok"), captured);
            PianoLocalInferencePlugin.executeCall(
                    port, system, user, 128, 5000, "crlf01");
            t.join(5000);
            byte[] request = captured.get(0);
            String all = new String(request, StandardCharsets.UTF_8);
            int headerEnd = all.indexOf("\r\n\r\n");
            String head = all.substring(0, headerEnd + 4);
            // The injected header must not exist — the exact header set stands.
            assertFalse(head.contains("Injected-Header"));
            assertFalse(head.contains("X-Extra"));
            assertFalse(head.contains("evil"));
            // The raw request must not contain the unescaped injection sequence.
            assertFalse(all.contains("line one\r\nInjected-Header"));
            assertTrue(all.contains("line one\\r\\nInjected-Header"));
            JSONObject parsed = new JSONObject(all.substring(headerEnd + 4));
            JSONArray messages = parsed.getJSONArray("messages");
            // Content arrives intact on the far side of JSON escaping.
            assertEquals(system, messages.getJSONObject(0).getString("content"));
            assertEquals(user, messages.getJSONObject(1).getString("content"));
        }
    }

    @Test
    public void testNon200AndRedirectNeverFollowed() throws Exception {
        // 500 -> bad_response
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = serveOnce(server,
                    "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 2\r\n\r\nno", null);
            assertEquals("bad_response", runErr(port, "s", "u", 128, 5000, "e500a"));
            t.join(5000);
        }
        // 302 with Location -> bad_response and exactly one connection total.
        final AtomicInteger accepts = new AtomicInteger();
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = new Thread(() -> {
                try {
                    while (true) {
                        try (Socket client = server.accept()) {
                            accepts.incrementAndGet();
                            readRequest(client);
                            String resp = "HTTP/1.1 302 Found\r\n"
                                    + "Location: http://127.0.0.1:" + port + "/harvest\r\n"
                                    + "Content-Length: 0\r\n\r\n";
                            client.getOutputStream().write(resp.getBytes(StandardCharsets.US_ASCII));
                            client.getOutputStream().flush();
                        }
                    }
                } catch (Exception ignored) {
                }
            });
            t.setDaemon(true);
            t.start();
            assertEquals("bad_response", runErr(port, "s", "u", 128, 5000, "e302a"));
            Thread.sleep(400);
            assertEquals("redirect must never be followed", 1, accepts.get());
        }
    }

    @Test
    public void testMalformedStatusLine() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = serveOnce(server, "GARBAGE NOT HTTP\r\n\r\n", null);
            assertEquals("bad_response", runErr(port, "s", "u", 128, 5000, "badst1"));
            t.join(5000);
        }
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = serveOnce(server, "HTTP/1.1 OK\r\n\r\n", null);
            assertEquals("bad_response", runErr(port, "s", "u", 128, 5000, "badst2"));
            t.join(5000);
        }
    }

    @Test
    public void testMalformedJson() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            byte[] body = "this is not json{{".getBytes(StandardCharsets.UTF_8);
            Thread t = serveOnce(server,
                    "HTTP/1.1 200 OK\r\nContent-Length: " + body.length + "\r\n\r\n"
                            + new String(body, StandardCharsets.UTF_8),
                    null);
            assertEquals("bad_response", runErr(port, "s", "u", 128, 5000, "badjs1"));
            t.join(5000);
        }
    }

    @Test
    public void testMissingChoices() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            byte[] body = "{\"object\":\"chat.completion\",\"choices\":[]}".getBytes(StandardCharsets.UTF_8);
            Thread t = serveOnce(server,
                    "HTTP/1.1 200 OK\r\nContent-Length: " + body.length + "\r\n\r\n"
                            + new String(body, StandardCharsets.UTF_8),
                    null);
            assertEquals("bad_response", runErr(port, "s", "u", 128, 5000, "nochc1"));
            t.join(5000);
        }
    }

    @Test
    public void testEmptyContent() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = serveOnce(server, okResponse("   "), null);
            assertEquals("bad_response", runErr(port, "s", "u", 128, 5000, "empty1"));
            t.join(5000);
        }
    }

    @Test
    public void testOversizedBody() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = serveOnce(server,
                    "HTTP/1.1 200 OK\r\nContent-Length: 70000\r\n\r\n", null);
            assertEquals("too_large", runErr(port, "s", "u", 128, 5000, "bigbd1"));
            t.join(5000);
        }
    }

    @Test
    public void testOversizedHeaders() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            StringBuilder pad = new StringBuilder("HTTP/1.1 200 OK\r\nX-Pad: ");
            for (int i = 0; i < 20000; i++) pad.append('x');
            pad.append("\r\n\r\n");
            Thread t = serveOnce(server, pad.toString(), null);
            assertEquals("too_large", runErr(port, "s", "u", 128, 5000, "bighd1"));
            t.join(5000);
        }
    }

    @Test
    public void testConnectionRefusedIsUnavailable() throws Exception {
        assertEquals("unavailable",
                runErr(refusedPort(), "s", "u", 128, 5000, "refus1"));
    }

    @Test
    public void testSlowDripHitsOverallDeadline() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = new Thread(() -> {
                try (Socket client = server.accept()) {
                    readRequest(client);
                    // Headers arrive, then one body byte per 400 ms: SO_TIMEOUT
                    // never fires but the overall watchdog must still kill it.
                    client.getOutputStream().write(
                            ("HTTP/1.1 200 OK\r\nContent-Length: 40\r\n\r\n")
                                    .getBytes(StandardCharsets.US_ASCII));
                    client.getOutputStream().flush();
                    for (int i = 0; i < 40; i++) {
                        client.getOutputStream().write('x');
                        client.getOutputStream().flush();
                        Thread.sleep(400);
                    }
                } catch (Exception ignored) {
                }
            });
            t.setDaemon(true);
            t.start();
            long start = System.nanoTime();
            assertEquals("timeout", runErr(port, "s", "u", 128, 1500, "drip01"));
            long elapsedMs = (System.nanoTime() - start) / 1_000_000;
            assertTrue("deadline must fire near timeoutMs, took " + elapsedMs + "ms",
                    elapsedMs < 5000);
        }
    }

    @Test
    public void testSilentServerTimesOut() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = new Thread(() -> {
                try (Socket client = server.accept()) {
                    readRequest(client);
                    Thread.sleep(10_000); // accept and say nothing
                } catch (Exception ignored) {
                }
            });
            t.setDaemon(true);
            t.start();
            long start = System.nanoTime();
            assertEquals("timeout", runErr(port, "s", "u", 128, 1200, "silen1"));
            long elapsedMs = (System.nanoTime() - start) / 1_000_000;
            assertTrue("must not wait for the silent server, took " + elapsedMs + "ms",
                    elapsedMs < 6000);
        }
    }

    @Test
    public void testCancelMidFlightFailsCancelled() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = new Thread(() -> {
                try (Socket client = server.accept()) {
                    readRequest(client);
                    Thread.sleep(30_000); // hold the response
                } catch (Exception ignored) {
                }
            });
            t.setDaemon(true);
            t.start();
            final String[] outcome = new String[1];
            Thread caller = new Thread(() ->
                    outcome[0] = runErr(port, "s", "u", 128, 30_000, "cancel1"));
            caller.start();
            Thread.sleep(400); // let the call reach the read phase
            PianoLocalInferencePlugin.cancelCall("cancel1");
            caller.join(8000);
            assertEquals("cancelled", outcome[0]);
            PianoLocalInferencePlugin.cancelCall("cancel1"); // idempotent no-op
            PianoLocalInferencePlugin.cancelCall("unknown-id");
        }
    }

    @Test
    public void testBadArgsMatrix() throws Exception {
        int port = refusedPort();
        String id = "goodid";
        assertEquals("bad_args", runErr(80, "s", "u", 128, 5000, id));
        assertEquals("bad_args", runErr(70000, "s", "u", 128, 5000, id));
        assertEquals("bad_args", runErr(0, "s", "u", 128, 5000, id));
        assertEquals("bad_args", runErr(port, "s", "u", 128, 5000, "has space"));
        assertEquals("bad_args", runErr(port, "s", "u", 128, 5000,
                new String(new char[65]).replace('\0', 'a')));
        assertEquals("bad_args", runErr(port, "s", "u", 128, 5000, null));
        assertEquals("bad_args", runErr(port, "s", "u", 128, 5000, ""));
        assertEquals("bad_args",
                runErr(port, new String(new char[4097]).replace('\0', 'a'), "u", 128, 5000, id));
        assertEquals("bad_args",
                runErr(port, "s", new String(new char[4097]).replace('\0', 'b'), 128, 5000, id));
        assertEquals("bad_args", runErr(port, "s", "u", 0, 5000, id));
        assertEquals("bad_args", runErr(port, "s", "u", 513, 5000, id));
        assertEquals("bad_args", runErr(port, "s", "u", 128, 10, id));
        assertEquals("bad_args", runErr(port, "s", "u", 128, 60001, id));
        assertEquals("bad_args", runErr(port, null, "u", 128, 5000, id));
    }

    @Test
    public void testInFlightCapAndDuplicateCallId() throws Exception {
        List<PianoLocalInferencePlugin.CallHandle> held = new ArrayList<>();
        try {
            for (int i = 0; i < 4; i++) {
                held.add(PianoLocalInferencePlugin.admit("cap-" + i));
            }
            try {
                PianoLocalInferencePlugin.admit("cap-5");
                fail("fifth in-flight call must be rejected");
            } catch (PianoLocalInferencePlugin.InferenceException e) {
                assertEquals("unavailable", e.code);
            }
            try {
                PianoLocalInferencePlugin.admit("cap-0");
                fail("duplicate in-flight callId must be rejected");
            } catch (PianoLocalInferencePlugin.InferenceException e) {
                assertEquals("bad_args", e.code);
            }
        } finally {
            for (int i = 0; i < held.size(); i++) {
                PianoLocalInferencePlugin.release("cap-" + i, held.get(i));
            }
        }
        assertEquals(0, PianoLocalInferencePlugin.inFlightCount());
    }

    @Test
    public void testSlotReleasedBeforeResultDelivered() throws Exception {
        // resolved path: the slot must be gone when delivery fires.
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = serveOnce(server, okResponse("slot freed"), null);
            PianoLocalInferencePlugin.CallHandle handle =
                    PianoLocalInferencePlugin.admit("seam-ok");
            final int[] inFlightAtDelivery = {-1};
            final String[] outcome = new String[1];
            PianoLocalInferencePlugin.executeAndDeliver(handle, "seam-ok", port, "s", "u",
                    128, 5000, new PianoLocalInferencePlugin.Delivery() {
                        @Override
                        public void resolved(String text) {
                            inFlightAtDelivery[0] = PianoLocalInferencePlugin.inFlightCount();
                            outcome[0] = "resolved:" + text;
                        }

                        @Override
                        public void rejected(String code) {
                            inFlightAtDelivery[0] = PianoLocalInferencePlugin.inFlightCount();
                            outcome[0] = "rejected:" + code;
                        }
                    });
            t.join(5000);
            assertEquals(0, inFlightAtDelivery[0]);
            assertEquals("resolved:slot freed", outcome[0]);
        }
        // rejected path: same guarantee when the call fails.
        int port = refusedPort();
        PianoLocalInferencePlugin.CallHandle handle = PianoLocalInferencePlugin.admit("seam-err");
        final int[] inFlightAtDelivery = {-1};
        final String[] outcome = new String[1];
        PianoLocalInferencePlugin.executeAndDeliver(handle, "seam-err", port, "s", "u",
                128, 5000, new PianoLocalInferencePlugin.Delivery() {
                    @Override
                    public void resolved(String text) {
                        inFlightAtDelivery[0] = PianoLocalInferencePlugin.inFlightCount();
                        outcome[0] = "resolved:" + text;
                    }

                    @Override
                    public void rejected(String code) {
                        inFlightAtDelivery[0] = PianoLocalInferencePlugin.inFlightCount();
                        outcome[0] = "rejected:" + code;
                    }
                });
        assertEquals(0, inFlightAtDelivery[0]);
        assertEquals("rejected:unavailable", outcome[0]);
    }
}
