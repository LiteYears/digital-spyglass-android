package org.darknetcrawler.mobile;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.junit.Before;
import org.junit.Test;

/**
 * Unit and local-loopback SOCKS5 protocol tests for PianoTorHttpPlugin
 * (DeepSeek Audit Items 1–9, 36, 62 + Level-3 Iteration 1 SOCKS5 ServerSocket harness).
 */
public class PianoTorHttpPluginTest {

    private static final String AHMIA_HOST =
            "juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion";
    private static final String TORCH_HOST =
            "xmh57jrknzkhv6y3ls3ubitzfqnkrwxhopf5aygthi7d6rplyvk3noyd.onion";
    private static final String AHMIA_ONION = "http://" + AHMIA_HOST;
    private static final String TORCH_ONION = "http://" + TORCH_HOST;
    private static final String UA =
            "Mozilla/5.0 (Android 10; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0";

    @Before
    public void setUp() {
        PianoTorHttpPlugin.clearCookieJarStatic();
    }

    @Test
    public void testIsValidOnionUrlEnforcesV3AndSubdomainBounds() throws Exception {
        assertTrue(PianoTorHttpPlugin.isValidOnionUrl(new URL(AHMIA_ONION + "/search?q=tor")));
        assertTrue(
                PianoTorHttpPlugin.isValidOnionUrl(
                        new URL("http://sub-1." + AHMIA_HOST + "/")));
        assertFalse(
                PianoTorHttpPlugin.isValidOnionUrl(
                        new URL("https://" + AHMIA_HOST + "/")));
        assertFalse(PianoTorHttpPlugin.isValidOnionUrl(new URL("http://example.com/leak")));
        assertFalse(PianoTorHttpPlugin.isValidOnionUrl(new URL("http://3g2upl4pq6kufc4m.onion/")));
        String longSub = new String(new char[64]).replace('\0', 'a');
        assertFalse(
                PianoTorHttpPlugin.isValidOnionUrl(
                        new URL("http://" + longSub + "." + AHMIA_HOST + "/")));
    }

    @Test
    public void testToAsciiRequestTargetPercentEncodesUnicodeAndRejectsCrlf() throws Exception {
        URL unicodeUrl = new URL(AHMIA_ONION + "/search?q=café&lang=ü");
        String target = PianoTorHttpPlugin.toAsciiRequestTarget(unicodeUrl);
        assertEquals("/search?q=caf%C3%A9&lang=%C3%BC", target);
    }

    @Test
    public void testHasChunkedTerminatorSupportsTrailers() {
        byte[] standard = "HTTP/1.1 200 OK\r\n\r\n4\r\ntest\r\n0\r\n\r\n".getBytes(StandardCharsets.US_ASCII);
        int bodyStart = 19;
        assertTrue(PianoTorHttpPlugin.hasChunkedTerminator(standard, bodyStart));

        byte[] withTrailer =
                "HTTP/1.1 200 OK\r\n\r\n4\r\ntest\r\n0\r\nServer-Timing: dur=12\r\n\r\n"
                        .getBytes(StandardCharsets.US_ASCII);
        assertTrue(PianoTorHttpPlugin.hasChunkedTerminator(withTrailer, bodyStart));

        byte[] incomplete = "HTTP/1.1 200 OK\r\n\r\n4\r\ntest\r\n".getBytes(StandardCharsets.US_ASCII);
        assertFalse(PianoTorHttpPlugin.hasChunkedTerminator(incomplete, bodyStart));
    }

    @Test
    public void testDecodeChunkedDecodesValidAndThrowsOnTruncatedChunk() throws Exception {
        byte[] valid = "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n".getBytes(StandardCharsets.US_ASCII);
        byte[] decoded = PianoTorHttpPlugin.decodeChunked(valid);
        assertArrayEquals("hello world".getBytes(StandardCharsets.US_ASCII), decoded);

        byte[] truncated = "a\r\nshort".getBytes(StandardCharsets.US_ASCII);
        try {
            PianoTorHttpPlugin.decodeChunked(truncated);
            fail("Expected IOException on truncated chunk body");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("Truncated"));
        }
    }

    @Test
    public void testParseSetCookieValidatesNameAndValueBounds() {
        PianoTorHttpPlugin.parseSetCookie("=malformed; Path=/", AHMIA_HOST);
        assertEquals("", PianoTorHttpPlugin.buildCookieHeader(AHMIA_HOST));

        PianoTorHttpPlugin.parseSetCookie("session=abc\r\nInjected: 1; Path=/", AHMIA_HOST);
        assertEquals("", PianoTorHttpPlugin.buildCookieHeader(AHMIA_HOST));

        PianoTorHttpPlugin.parseSetCookie("oss_captcha=token123; Path=/; HttpOnly", AHMIA_HOST);
        assertEquals("oss_captcha=token123", PianoTorHttpPlugin.buildCookieHeader(AHMIA_HOST));
    }

    @Test
    public void testSocks5ProtocolHandshakeRfc1929HeadersAndChunkedTrailer() throws Exception {
        final List<String> capturedRequests = Collections.synchronizedList(new ArrayList<>());
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = new Thread(() -> {
                try (Socket client = server.accept()) {
                    InputStream in = client.getInputStream();
                    OutputStream out = client.getOutputStream();
                    // 1. Greeting: expect 0x05, 0x01, 0x02 (strict RFC 1929 auth only)
                    byte[] greet = readExact(in, 3);
                    assertEquals(0x05, greet[0]);
                    assertEquals(0x01, greet[1]);
                    assertEquals(0x02, greet[2]);
                    out.write(new byte[]{0x05, 0x02});
                    out.flush();

                    // 2. RFC 1929 sub-negotiation
                    int ver = in.read();
                    assertEquals(0x01, ver);
                    int ulen = in.read();
                    String user = new String(readExact(in, ulen), StandardCharsets.US_ASCII);
                    int plen = in.read();
                    String pass = new String(readExact(in, plen), StandardCharsets.US_ASCII);
                    assertEquals("ghost", user);
                    assertEquals("nonce-ahmia", pass);
                    out.write(new byte[]{0x01, 0x00});
                    out.flush();

                    // 3. SOCKS5 CONNECT with ATYP=0x03 (DOMAINNAME)
                    byte[] connHdr = readExact(in, 4);
                    assertEquals(0x05, connHdr[0]);
                    assertEquals(0x01, connHdr[1]);
                    assertEquals(0x03, connHdr[3]);
                    int dlen = in.read();
                    String domain = new String(readExact(in, dlen), StandardCharsets.US_ASCII);
                    readExact(in, 2); // port
                    assertEquals(AHMIA_HOST, domain);
                    out.write(new byte[]{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 80});
                    out.flush();

                    // 4. Read HTTP request headers
                    String reqHeaders = readUntilDoubleCrLf(in);
                    capturedRequests.add(reqHeaders);

                    // 5. Respond with Set-Cookie + chunked body with trailer
                    String resp = "HTTP/1.1 200 OK\r\n"
                            + "Transfer-Encoding: chunked\r\n"
                            + "Set-Cookie: sid=live777; Path=/\r\n"
                            + "\r\n"
                            + "b\r\n"
                            + "hello onion\r\n"
                            + "0\r\n"
                            + "X-Tor-Trailer: ok\r\n"
                            + "\r\n";
                    out.write(resp.getBytes(StandardCharsets.US_ASCII));
                    out.flush();
                } catch (Exception ignored) {
                }
            });
            t.start();

            PianoTorHttpPlugin.HttpResult res = PianoTorHttpPlugin.executeFetchWithRedirects(
                    AHMIA_ONION + "/search?q=café",
                    UA,
                    "GET",
                    null,
                    "ghost",
                    "nonce-ahmia",
                    "127.0.0.1",
                    port
            );
            t.join(5000);

            assertEquals(200, res.status);
            assertEquals("hello onion", res.body);
            assertEquals("sid=live777", PianoTorHttpPlugin.buildCookieHeader(AHMIA_HOST));
            assertEquals(1, capturedRequests.size());
            String req = capturedRequests.get(0);
            assertTrue(req.startsWith("GET /search?q=caf%C3%A9 HTTP/1.1\r\n"));
            assertTrue(req.contains("Sec-Fetch-Site: none\r\n"));
            assertTrue(req.contains("Sec-Fetch-User: ?1\r\n"));
            assertTrue(req.contains("Priority: u=0, i\r\n"));
        }
    }

    @Test
    public void testSocks5FailsClosedWhenProxySelectsNoAuth0x00() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = new Thread(() -> {
                try (Socket client = server.accept()) {
                    InputStream in = client.getInputStream();
                    OutputStream out = client.getOutputStream();
                    readExact(in, 3);
                    // Proxy tries to downgrade to NO-AUTH (0x00)
                    out.write(new byte[]{0x05, 0x00});
                    out.flush();
                } catch (Exception ignored) {
                }
            });
            t.start();

            try {
                PianoTorHttpPlugin.executeFetchWithRedirects(
                        AHMIA_ONION + "/",
                        UA,
                        "GET",
                        null,
                        "ghost",
                        "nonce-1",
                        "127.0.0.1",
                        port
                );
                fail("Expected IOException when proxy refuses 0x02 auth");
            } catch (IOException expected) {
                assertTrue(expected.getMessage().contains("circuit isolation unavailable"));
            }
            t.join(5000);
        }
    }

    @Test
    public void testRedirectLoopUpdatesSecFetchSiteAndBlocksClearnetDowngrade() throws Exception {
        final List<String> capturedRequests = Collections.synchronizedList(new ArrayList<>());
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = new Thread(() -> {
                try {
                    // Hop 0: redirect from AHMIA_ONION to TORCH_ONION (cross-site v3 .onion)
                    try (Socket c1 = server.accept()) {
                        InputStream in = c1.getInputStream();
                        OutputStream out = c1.getOutputStream();
                        completeSocksHandshakeNoAuth(in, out);
                        capturedRequests.add(readUntilDoubleCrLf(in));
                        String r1 = "HTTP/1.1 302 Found\r\n"
                                + "Location:" + TORCH_ONION + "/hop1\r\n"
                                + "Content-Length: 0\r\n\r\n";
                        out.write(r1.getBytes(StandardCharsets.US_ASCII));
                        out.flush();
                    }
                    // Hop 1: redirect from TORCH_ONION to clearnet (must be blocked!)
                    try (Socket c2 = server.accept()) {
                        InputStream in = c2.getInputStream();
                        OutputStream out = c2.getOutputStream();
                        completeSocksHandshakeNoAuth(in, out);
                        capturedRequests.add(readUntilDoubleCrLf(in));
                        String r2 = "HTTP/1.1 302 Found\r\n"
                                + "Location: http://evil-clearnet-honeypot.com/leak?q=secret\r\n"
                                + "Content-Length: 0\r\n\r\n";
                        out.write(r2.getBytes(StandardCharsets.US_ASCII));
                        out.flush();
                    }
                } catch (Exception ignored) {
                }
            });
            t.start();

            try {
                PianoTorHttpPlugin.executeFetchWithRedirects(
                        AHMIA_ONION + "/start",
                        UA,
                        "GET",
                        null,
                        null,
                        null,
                        "127.0.0.1",
                        port
                );
                fail("Expected IOException on redirect to clearnet");
            } catch (IOException expected) {
                assertTrue(expected.getMessage().contains("Blocked redirect outside v3 .onion domain"));
            }
            t.join(5000);

            assertEquals(2, capturedRequests.size());
            assertTrue(capturedRequests.get(0).contains("Sec-Fetch-Site: none\r\n"));
            assertTrue(capturedRequests.get(0).contains("Sec-Fetch-User: ?1\r\n"));
            // Hop 1 must have transitioned to Sec-Fetch-Site: cross-site while keeping Sec-Fetch-User: ?1
            assertTrue(capturedRequests.get(1).contains("Sec-Fetch-Site: cross-site\r\n"));
            assertTrue(capturedRequests.get(1).contains("Sec-Fetch-User: ?1\r\n"));
        }
    }

    @Test
    public void testFetchOnceErrorsWhenBodyExceedsCapBeforeEof() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = new Thread(() -> {
                try (Socket client = server.accept()) {
                    InputStream in = client.getInputStream();
                    OutputStream out = client.getOutputStream();
                    completeSocksHandshakeNoAuth(in, out);
                    readUntilDoubleCrLf(in);
                    String hdr = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n";
                    out.write(hdr.getBytes(StandardCharsets.US_ASCII));
                    byte[] chunk = new byte[65536];
                    java.util.Arrays.fill(chunk, (byte) 'A');
                    for (int i = 0; i < 35; i++) { // ~2.29 MB total
                        out.write(chunk);
                    }
                    out.flush();
                } catch (Exception ignored) {
                }
            });
            t.start();

            try {
                PianoTorHttpPlugin.executeFetchWithRedirects(
                        AHMIA_ONION + "/large",
                        UA,
                        "GET",
                        null,
                        null,
                        null,
                        "127.0.0.1",
                        port
                );
                fail("Expected IOException when body exceeds cap before end of stream");
            } catch (IOException expected) {
                assertTrue(expected.getMessage().contains("cap"));
            }
            t.join(5000);
        }
    }

    @Test
    public void testRequestTargetPreservesPreEncodedQueryFromJs() throws Exception {
        // External review finding (HF 190805/#2): JS owns URL encoding via
        // encodeURIComponent; the transport must not re-escape %.
        final List<String> capturedRequests = Collections.synchronizedList(new ArrayList<>());
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = new Thread(() -> {
                try {
                    for (int i = 0; i < 2; i++) {
                        try (Socket client = server.accept()) {
                            InputStream in = client.getInputStream();
                            OutputStream out = client.getOutputStream();
                            completeSocksHandshakeNoAuth(in, out);
                            capturedRequests.add(readUntilDoubleCrLf(in));
                            String resp = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
                            out.write(resp.getBytes(StandardCharsets.US_ASCII));
                            out.flush();
                        }
                    }
                } catch (Exception ignored) {
                }
            });
            t.start();
            String[] urls = {"/search?q=a%20b", "/search?q=%E6%97%A5"};
            for (String u : urls) {
                PianoTorHttpPlugin.HttpResult res = PianoTorHttpPlugin.executeFetchWithRedirects(
                        AHMIA_ONION + u, UA, "GET", null, null, null, "127.0.0.1", port);
                assertEquals(200, res.status);
            }
            t.join(5000);
            assertEquals(2, capturedRequests.size());
            assertTrue(capturedRequests.get(0).startsWith("GET /search?q=a%20b HTTP/1.1\r\n"));
            assertTrue(capturedRequests.get(1).startsWith("GET /search?q=%E6%97%A5 HTTP/1.1\r\n"));
        }
    }

    @Test
    public void testRejectsPrematureEofWithDeclaredContentLength() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = new Thread(() -> {
                try (Socket client = server.accept()) {
                    InputStream in = client.getInputStream();
                    OutputStream out = client.getOutputStream();
                    completeSocksHandshakeNoAuth(in, out);
                    readUntilDoubleCrLf(in);
                    String resp = "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort";
                    out.write(resp.getBytes(StandardCharsets.US_ASCII));
                    out.flush();
                } catch (Exception ignored) {
                }
            });
            t.start();
            try {
                PianoTorHttpPlugin.executeFetchWithRedirects(
                        AHMIA_ONION + "/", UA, "GET", null, null, null, "127.0.0.1", port);
                fail("Expected IOException on premature EOF with declared Content-Length");
            } catch (IOException expected) {
                assertTrue(expected.getMessage().contains("Incomplete"));
            }
            t.join(5000);
        }
    }

    @Test
    public void testRejectsChunkedBodyMissingTerminalChunk() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = new Thread(() -> {
                try (Socket client = server.accept()) {
                    InputStream in = client.getInputStream();
                    OutputStream out = client.getOutputStream();
                    completeSocksHandshakeNoAuth(in, out);
                    readUntilDoubleCrLf(in);
                    // Complete first chunk but EOF before the 0\r\n\r\n terminator.
                    String resp = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello";
                    out.write(resp.getBytes(StandardCharsets.US_ASCII));
                    out.flush();
                } catch (Exception ignored) {
                }
            });
            t.start();
            try {
                PianoTorHttpPlugin.executeFetchWithRedirects(
                        AHMIA_ONION + "/", UA, "GET", null, null, null, "127.0.0.1", port);
                fail("Expected IOException on missing chunk terminator");
            } catch (IOException expected) {
                assertTrue(expected.getMessage().contains("Incomplete"));
            }
            t.join(5000);
        }
    }

    @Test
    public void testRedirect307SameOriginPreservesPostAnd308CrossHostRejected() throws Exception {
        final List<String> capturedRequests = Collections.synchronizedList(new ArrayList<>());
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = new Thread(() -> {
                try {
                    // Hop 0: POST /submit -> 307 same-origin /follow
                    try (Socket c1 = server.accept()) {
                        InputStream in = c1.getInputStream();
                        OutputStream out = c1.getOutputStream();
                        completeSocksHandshakeNoAuth(in, out);
                        readUntilDoubleCrLf(in);
                        readExact(in, "answer=42".length());
                        String r1 = "HTTP/1.1 307 Temporary Redirect\r\n"
                                + "Location: " + AHMIA_ONION + "/follow\r\n"
                                + "Content-Length: 0\r\n\r\n";
                        out.write(r1.getBytes(StandardCharsets.US_ASCII));
                        out.flush();
                    }
                    // Hop 1: must still be POST with body
                    try (Socket c2 = server.accept()) {
                        InputStream in = c2.getInputStream();
                        OutputStream out = c2.getOutputStream();
                        completeSocksHandshakeNoAuth(in, out);
                        String hdr = readUntilDoubleCrLf(in);
                        byte[] b = readExact(in, "answer=42".length());
                        capturedRequests.add(hdr + new String(b, StandardCharsets.UTF_8));
                        String r2 = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
                        out.write(r2.getBytes(StandardCharsets.US_ASCII));
                        out.flush();
                    }
                } catch (Exception ignored) {
                }
            });
            t.start();
            PianoTorHttpPlugin.HttpResult res = PianoTorHttpPlugin.executeFetchWithRedirects(
                    AHMIA_ONION + "/submit", UA, "POST", "answer=42", null, null, "127.0.0.1", port);
            t.join(5000);
            assertEquals(200, res.status);
            assertEquals(1, capturedRequests.size());
            assertTrue(capturedRequests.get(0).startsWith("POST /follow HTTP/1.1\r\n"));
            assertTrue(capturedRequests.get(0).contains("answer=42"));
        }
    }

    @Test
    public void testRedirect308CrossHostWithBodyIsRejected() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = new Thread(() -> {
                try (Socket c1 = server.accept()) {
                    InputStream in = c1.getInputStream();
                    OutputStream out = c1.getOutputStream();
                    completeSocksHandshakeNoAuth(in, out);
                    readUntilDoubleCrLf(in);
                    readExact(in, "answer=42".length());
                    String r1 = "HTTP/1.1 308 Permanent Redirect\r\n"
                            + "Location: " + TORCH_ONION + "/harvest\r\n"
                            + "Content-Length: 0\r\n\r\n";
                    out.write(r1.getBytes(StandardCharsets.US_ASCII));
                    out.flush();
                } catch (Exception ignored) {
                }
            });
            t.start();
            try {
                PianoTorHttpPlugin.executeFetchWithRedirects(
                        AHMIA_ONION + "/submit", UA, "POST", "answer=42", null, null, "127.0.0.1", port);
                fail("Expected IOException on cross-host 308 carrying POST body");
            } catch (IOException expected) {
                assertTrue(expected.getMessage().contains("cross-host redirect"));
            }
            t.join(5000);
        }
    }

    @Test
    public void testRedirect303PostRewritesToGet() throws Exception {
        final List<String> capturedRequests = Collections.synchronizedList(new ArrayList<>());
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = new Thread(() -> {
                try {
                    try (Socket c1 = server.accept()) {
                        InputStream in = c1.getInputStream();
                        OutputStream out = c1.getOutputStream();
                        completeSocksHandshakeNoAuth(in, out);
                        readUntilDoubleCrLf(in);
                        readExact(in, "answer=42".length());
                        String r1 = "HTTP/1.1 303 See Other\r\n"
                                + "Location: " + AHMIA_ONION + "/done\r\n"
                                + "Content-Length: 0\r\n\r\n";
                        out.write(r1.getBytes(StandardCharsets.US_ASCII));
                        out.flush();
                    }
                    try (Socket c2 = server.accept()) {
                        InputStream in = c2.getInputStream();
                        OutputStream out = c2.getOutputStream();
                        completeSocksHandshakeNoAuth(in, out);
                        capturedRequests.add(readUntilDoubleCrLf(in));
                        String r2 = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
                        out.write(r2.getBytes(StandardCharsets.US_ASCII));
                        out.flush();
                    }
                } catch (Exception ignored) {
                }
            });
            t.start();
            PianoTorHttpPlugin.HttpResult res = PianoTorHttpPlugin.executeFetchWithRedirects(
                    AHMIA_ONION + "/submit", UA, "POST", "answer=42", null, null, "127.0.0.1", port);
            t.join(5000);
            assertEquals(200, res.status);
            assertEquals(1, capturedRequests.size());
            assertTrue(capturedRequests.get(0).startsWith("GET /done HTTP/1.1\r\n"));
        }
    }

    @Test
    public void testSendsAcceptEncodingAndDecodesGzipBody() throws Exception {
        final List<String> capturedRequests = Collections.synchronizedList(new ArrayList<>());
        try (ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread t = new Thread(() -> {
                try (Socket client = server.accept()) {
                    InputStream in = client.getInputStream();
                    OutputStream out = client.getOutputStream();
                    completeSocksHandshakeNoAuth(in, out);
                    capturedRequests.add(readUntilDoubleCrLf(in));
                    String payload = "gzip encoded onion result";
                    ByteArrayOutputStream gz = new ByteArrayOutputStream();
                    try (java.util.zip.GZIPOutputStream g = new java.util.zip.GZIPOutputStream(gz)) {
                        g.write(payload.getBytes(StandardCharsets.UTF_8));
                    }
                    byte[] gzBytes = gz.toByteArray();
                    String hdr = "HTTP/1.1 200 OK\r\n"
                            + "Content-Encoding: gzip\r\n"
                            + "Content-Length: " + gzBytes.length + "\r\n\r\n";
                    out.write(hdr.getBytes(StandardCharsets.US_ASCII));
                    out.write(gzBytes);
                    out.flush();
                } catch (Exception ignored) {
                }
            });
            t.start();
            PianoTorHttpPlugin.HttpResult res = PianoTorHttpPlugin.executeFetchWithRedirects(
                    AHMIA_ONION + "/search?q=gz", UA, "GET", null, null, null, "127.0.0.1", port);
            t.join(5000);
            assertEquals(200, res.status);
            assertEquals("gzip encoded onion result", res.body);
            assertEquals(1, capturedRequests.size());
            assertTrue(capturedRequests.get(0).contains("Accept-Encoding: gzip, deflate\r\n"));
            assertTrue(capturedRequests.get(0).contains("Connection: keep-alive\r\n"));
        }
    }

    @Test
    public void testDecodeContentEncodingRejectsUnsupportedEncoding() throws Exception {
        try {
            PianoTorHttpPlugin.decodeContentEncoding("x".getBytes(StandardCharsets.US_ASCII), "br");
            fail("Expected IOException on unsupported Content-Encoding");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("Unsupported Content-Encoding"));
        }
        byte[] plain = "deflate me".getBytes(StandardCharsets.UTF_8);
        java.util.zip.Deflater d = new java.util.zip.Deflater();
        d.setInput(plain);
        d.finish();
        byte[] buf = new byte[256];
        int n = d.deflate(buf);
        d.end();
        byte[] compressed = java.util.Arrays.copyOf(buf, n);
        byte[] back = PianoTorHttpPlugin.decodeContentEncoding(compressed, "deflate");
        assertArrayEquals(plain, back);
    }

    private static void completeSocksHandshakeNoAuth(InputStream in, OutputStream out) throws IOException {
        readExact(in, 3);
        out.write(new byte[]{0x05, 0x00});
        out.flush();
        readExact(in, 4);
        int dlen = in.read();
        readExact(in, dlen + 2);
        out.write(new byte[]{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 80});
        out.flush();
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
}
