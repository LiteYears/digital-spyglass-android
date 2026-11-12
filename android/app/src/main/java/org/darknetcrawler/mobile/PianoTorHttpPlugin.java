package org.darknetcrawler.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;
import java.util.zip.InflaterInputStream;

/**
 * Tor SOCKS5 HTTP plugin.
 *
 * CapacitorHttp uses Android's native HTTP stack, which resolves DNS locally.
 * That fails for .onion addresses — no system DNS resolver (Pi-hole, Google,
 * Cloudflare, ISP) can resolve them. Only Tor can.
 *
 * This plugin bypasses system DNS entirely by connecting to Orbot's SOCKS5
 * proxy (localhost:9050) and sending the hostname in the SOCKS5 request as
 * ATYP=DOMAINNAME (0x03). Tor resolves the hostname internally via the Tor
 * network — no DNS leak, no local resolution needed.
 *
 * Works regardless of the user's DNS setup (Pi-hole, 8.8.8.8, 1.1.1.1, ISP).
 *
 * Supports GET and POST. Maintains a per-host cookie jar so captcha-solving
 * flows (OSS) work: GET captcha page → POST answer → GET search with cookie.
 * The cookie jar is purged after each search via purgeCookies() to prevent
 * cross-search cookie correlation by onion sites.
 *
 * Runs on a background thread — SOCKS connection + HTTP read must not block UI.
 *
 * --- TLS / JA3 Design Decision ---
 *
 * This plugin uses raw java.net.Socket and sends plain HTTP over the SOCKS5
 * tunnel — no TLS at all. This is intentional and correct for .onion traffic:
 * Tor provides end-to-end encryption at the protocol layer, so HTTPS is not
 * required. The Tor Project confirms: "All traffic between Tor users and onion
 * services is end-to-end encrypted, so you do not need to worry about
 * connecting over HTTPS."
 *
 * Because there is no TLS handshake, there is no TLS ClientHello and therefore
 * no JA3 fingerprint. This is a significant anonymity advantage — Java's TLS
 * stack (if used) would produce a ClientHello measurably different from
 * Firefox's NSS stack, creating a fingerprint even with perfect HTTP headers.
 *
 * If HTTPS support is ever needed (e.g. for .onion sites that redirect to
 * HTTPS), the TLS implementation must use a ClientHello that matches
 * Firefox/NSS, not Java's default SSLSocket. Consider uTLS or BoringSSL with
 * a Firefox profile. This is a future concern, not a current problem.
 */
@CapacitorPlugin(name = "PianoTorHttp")
public class PianoTorHttpPlugin extends Plugin {

    private static final String SOCKS_HOST = "127.0.0.1";
    private static final int SOCKS_PORT = 9050;
    private static final int CONNECT_TIMEOUT_MS = 20000;
    private static final int READ_TIMEOUT_MS = 40000;
    private static final int MAX_BODY = 2_000_000;
    private static final int MAX_BROWSER_BODY = 25_000_000;
    private static final Pattern V3_ONION_HOST =
            Pattern.compile("^(?:[a-z0-9-]{1,63}\\.)?[a-z2-7]{56}\\.onion$");

    // Per-host cookie jar: host -> (cookieName -> cookieValue)
    private static final Map<String, Map<String, String>> cookieJar = new ConcurrentHashMap<>();

    public static void clearCookieJarStatic() {
        for (Map<String, String> hostCookies : cookieJar.values()) {
            hostCookies.clear();
        }
        cookieJar.clear();
    }

    public static boolean isValidOnionUrl(URL url) {
        if (url == null) return false;
        String proto = url.getProtocol();
        if (!"http".equalsIgnoreCase(proto)) return false;
        String host = url.getHost();
        if (host == null) return false;
        String lower = host.toLowerCase(Locale.ROOT);
        return V3_ONION_HOST.matcher(lower).matches();
    }

    /**
     * Converts a URL's path and query to a strict RFC 3986 US-ASCII request-target.
     * The JS layer owns URL encoding (encodeURIComponent): existing %XX escapes are
     * preserved verbatim, raw non-ASCII characters are UTF-8 percent-encoded as a
     * defensive fallback, and control/whitespace characters fail closed.
     */
    static String toAsciiRequestTarget(URL url) throws IOException {
        StringBuilder raw = new StringBuilder();
        String path = url.getPath();
        raw.append(path == null || path.isEmpty() ? "/" : path);
        if (url.getQuery() != null) {
            raw.append('?').append(url.getQuery());
        }
        StringBuilder ascii = new StringBuilder();
        for (int i = 0; i < raw.length();) {
            int cp = raw.codePointAt(i);
            i += Character.charCount(cp);
            if (cp <= 0x20 || cp == 0x7f) {
                throw new IOException("Illegal character in ASCII request target");
            }
            if (cp < 0x80) {
                ascii.append((char) cp);
            } else {
                for (byte b : new String(Character.toChars(cp)).getBytes(StandardCharsets.UTF_8)) {
                    ascii.append('%')
                         .append(Character.toUpperCase(Character.forDigit((b >> 4) & 0xF, 16)))
                         .append(Character.toUpperCase(Character.forDigit(b & 0xF, 16)));
                }
            }
        }
        return ascii.toString();
    }

    @PluginMethod
    public void fetch(final PluginCall call) {
        // MUST run on background thread — Socket operations block the UI thread.
        new Thread(() -> doFetch(call), "PianoTorHttp-fetch").start();
    }

    /**
     * Purge the per-host cookie jar. Called after each search completes to
     * prevent cross-search cookie correlation by onion sites. The OSS captcha
     * flow works within a single search because the cookie is set and used
     * within the same prepareSearchUrl → fetchText sequence.
     */
    @PluginMethod
    public void purgeCookies(final PluginCall call) {
        clearCookieJarStatic();
        call.resolve();
    }

    private void doFetch(PluginCall call) {
        String urlStr = call.getString("url");
        if (urlStr == null || urlStr.isEmpty()) {
            call.reject("url is required");
            return;
        }

        String ua = call.getString("userAgent",
                "Mozilla/5.0 (Android 10; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0");
        String method = call.getString("method", "GET").toUpperCase(Locale.ROOT);
        String postBody = call.getString("body", null);
        String socksUser = call.getString("socksUser", null);
        String socksPass = call.getString("socksPass", null);
        String socksHost = call.getString("socksHost", SOCKS_HOST);
        if (socksHost == null || socksHost.isEmpty()) socksHost = SOCKS_HOST;
        Integer socksPortObj = call.getInt("socksPort");
        int socksPort = (socksPortObj != null && socksPortObj >= 1 && socksPortObj <= 65535)
                ? socksPortObj : SOCKS_PORT;

        try {
            HttpResult result = executeFetchWithRedirects(
                    urlStr, ua, method, postBody, socksUser, socksPass, socksHost, socksPort);
            JSObject jsResult = new JSObject();
            jsResult.put("status", result.status);
            jsResult.put("body", result.body);
            call.resolve(jsResult);
        } catch (IOException e) {
            call.reject("Tor fetch failed: " + e.getMessage());
        } catch (Exception e) {
            call.reject("Tor fetch error: " + e.getMessage());
        }
    }

    static class HttpResult {
        int status;
        String body;
        String location;
    }

    static HttpResult executeFetchWithRedirects(
            String urlStr, String ua, String method, String postBody,
            String socksUser, String socksPass,
            String socksHost, int socksPort) throws IOException {
        String currentUrl = urlStr;
        String curMethod = method;
        String curBody = postBody;
        String secFetchSite = "none";
        for (int hop = 0; hop < 5; hop++) {
            URL validated = new URL(currentUrl);
            if (!isValidOnionUrl(validated)) {
                throw new IOException("Blocked non-v3-.onion or non-HTTP target on hop " + hop);
            }
            HttpResult result = fetchOnce(
                    currentUrl, ua, curMethod, curBody,
                    socksUser, socksPass, socksHost, socksPort, secFetchSite);

            if (result.status >= 300 && result.status < 400 && result.location != null) {
                URL next = new URL(validated, result.location);
                if (!isValidOnionUrl(next)) {
                    throw new IOException("Blocked redirect outside v3 .onion domain");
                }
                boolean sameOrigin = validated.getHost().equalsIgnoreCase(next.getHost())
                        && validated.getPort() == next.getPort();
                secFetchSite = sameOrigin ? "same-origin" : "cross-site";
                currentUrl = next.toString();
                if (result.status == 307 || result.status == 308) {
                    // Method-preserving redirects: keep POST only same-origin;
                    // never forward a request body to a different host.
                    if (!sameOrigin && curBody != null) {
                        throw new IOException("Blocked cross-host redirect carrying request body");
                    }
                } else {
                    curMethod = "GET";
                    curBody = null;
                }
                continue;
            }
            return result;
        }
        throw new IOException("Too many redirects");
    }

    static HttpResult fetchOnce(String urlStr, String ua, String method, String postBody,
                                  String socksUser, String socksPass,
                                  String socksHost, int socksPort,
                                  String secFetchSite) throws IOException {
        URL url = new URL(urlStr);
        if (!isValidOnionUrl(url)) {
            throw new IOException("Refusing non-v3-.onion target");
        }
        String host = url.getHost().toLowerCase(Locale.ROOT);
        int port = url.getPort() > 0 ? url.getPort() : url.getDefaultPort();
        String path = toAsciiRequestTarget(url);

        Socket socket = new Socket();
        try {
            try {
                socket.connect(new InetSocketAddress(socksHost, socksPort), CONNECT_TIMEOUT_MS);
            } catch (IOException e) {
                if (socksPort == 9050 && "127.0.0.1".equals(socksHost)) {
                    // Try 9150 (alternative Orbot / Tor Browser SOCKS port on Android)
                    socket = new Socket();
                    socket.connect(new InetSocketAddress(socksHost, 9150), CONNECT_TIMEOUT_MS);
                    socksPort = 9150;
                } else {
                    throw e;
                }
            }
            socket.setSoTimeout(READ_TIMEOUT_MS);

            OutputStream out = socket.getOutputStream();
            InputStream in = socket.getInputStream();

            // SOCKS5 greeting
            boolean wantAuth = socksUser != null && socksPass != null;
            if (wantAuth) {
                out.write(new byte[]{0x05, 0x01, 0x02});
            } else {
                out.write(new byte[]{0x05, 0x01, 0x00});
            }
            out.flush();
            byte[] greeting = readN(in, 2);
            if (greeting[0] != 0x05) {
                throw new IOException("SOCKS5 auth negotiation failed — is Orbot running?");
            }

            byte selectedMethod = greeting[1];
            if (selectedMethod == (byte) 0xFF) {
                throw new IOException("SOCKS5 proxy rejected authentication methods");
            }
            if (selectedMethod == 0x02 && wantAuth) {
                // RFC 1929: username/password sub-negotiation for circuit isolation
                byte[] userBytes = socksUser.getBytes(StandardCharsets.US_ASCII);
                byte[] passBytes = socksPass.getBytes(StandardCharsets.US_ASCII);
                ByteArrayOutputStream authReq = new ByteArrayOutputStream();
                authReq.write(0x01); // sub-negotiation version
                authReq.write(userBytes.length & 0xFF);
                authReq.write(userBytes);
                authReq.write(passBytes.length & 0xFF);
                authReq.write(passBytes);
                out.write(authReq.toByteArray());
                out.flush();

                byte[] authResp = readN(in, 2);
                if (authResp[1] != 0x00) {
                    throw new IOException("SOCKS5 username/password auth rejected");
                }
            } else if (selectedMethod == 0x00 && !wantAuth) {
                // No authentication requested or required
            } else if (selectedMethod == 0x00 && wantAuth) {
                throw new IOException("SOCKS5 proxy selected NO-AUTH when credentials were provided — circuit isolation unavailable");
            } else {
                throw new IOException("SOCKS5 auth negotiation failed — unsupported method: 0x" +
                        Integer.toHexString(selectedMethod & 0xFF));
            }

            // SOCKS5 CONNECT with DOMAINNAME (remote DNS via Tor)
            ByteArrayOutputStream req = new ByteArrayOutputStream();
            req.write(0x05);
            req.write(0x01);
            req.write(0x00);
            req.write(0x03);
            byte[] hostBytes = host.getBytes(StandardCharsets.US_ASCII);
            req.write(hostBytes.length & 0xFF);
            req.write(hostBytes);
            req.write((port >> 8) & 0xFF);
            req.write(port & 0xFF);
            out.write(req.toByteArray());
            out.flush();

            byte[] resp = readN(in, 4);
            if (resp[0] != 0x05) throw new IOException("SOCKS5 protocol error");
            if (resp[1] != 0x00) throw new IOException("SOCKS5 connect failed: " + socksError(resp[1]));

            int atyp = resp[3] & 0xFF;
            int addrLen;
            switch (atyp) {
                case 0x01: addrLen = 4; break;
                case 0x03: addrLen = in.read() & 0xFF; break;
                case 0x04: addrLen = 16; break;
                default: addrLen = 0; break;
            }
            if (addrLen > 0) readN(in, addrLen);
            readN(in, 2);

            // Build cookie header from jar
            String cookieHeader = buildCookieHeader(host);

            // Build HTTP request in canonical Firefox navigation header order:
            // Host, User-Agent, Accept, Accept-Language, Accept-Encoding,
            // Connection, Cookie, Upgrade-Insecure-Requests, Sec-Fetch-*,
            // Priority — matching Tor Browser (Firefox ESR) on Android.
            StringBuilder httpReq = new StringBuilder();
            httpReq.append(method).append(" ").append(path).append(" HTTP/1.1\r\n");
            httpReq.append("Host: ").append(host).append("\r\n");
            httpReq.append("User-Agent: ").append(ua).append("\r\n");
            httpReq.append("Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\n");
            httpReq.append("Accept-Language: en-US,en;q=0.5\r\n");
            httpReq.append("Accept-Encoding: gzip, deflate\r\n");
            httpReq.append("Connection: keep-alive\r\n");
            if (!cookieHeader.isEmpty()) {
                httpReq.append("Cookie: ").append(cookieHeader).append("\r\n");
            }
            httpReq.append("Upgrade-Insecure-Requests: 1\r\n");
            httpReq.append("Sec-Fetch-Dest: document\r\n");
            httpReq.append("Sec-Fetch-Mode: navigate\r\n");
            httpReq.append("Sec-Fetch-Site: ").append(secFetchSite).append("\r\n");
            httpReq.append("Sec-Fetch-User: ?1\r\n");
            httpReq.append("Priority: u=0, i\r\n");
            if ("POST".equals(method) && postBody != null) {
                byte[] bodyBytes = postBody.getBytes(StandardCharsets.UTF_8);
                httpReq.append("Content-Type: application/x-www-form-urlencoded\r\n");
                httpReq.append("Content-Length: ").append(bodyBytes.length).append("\r\n");
            }
            httpReq.append("\r\n");

            out.write(httpReq.toString().getBytes(StandardCharsets.US_ASCII));

            if ("POST".equals(method) && postBody != null) {
                byte[] bodyBytes = postBody.getBytes(StandardCharsets.UTF_8);
                out.write(bodyBytes);
            }
            out.flush();

            ByteArrayOutputStream body = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int headerEndByteIdx = -1;
            boolean isChunked = false;
            int contentLength = -1;
            String contentEncoding = null;
            int effectiveCap = allowAnyHttp ? MAX_BROWSER_BODY : MAX_BODY;
            try {
                int n;
                while ((n = in.read(buf)) > 0) {
                    int remainingCap = effectiveCap - body.size();
                    if (remainingCap > 0) {
                        body.write(buf, 0, Math.min(n, remainingCap));
                    }
                    if (body.size() >= effectiveCap) break;

                    byte[] cur = body.toByteArray();
                    if (headerEndByteIdx < 0) {
                        headerEndByteIdx = findHeaderEnd(cur);
                        if (headerEndByteIdx >= 0) {
                            String hdrStr = new String(cur, 0, headerEndByteIdx, StandardCharsets.ISO_8859_1);
                            for (String hLine : hdrStr.split("\r\n")) {
                                int colon = hLine.indexOf(':');
                                if (colon <= 0) continue;
                                String hName = hLine.substring(0, colon).trim().toLowerCase(Locale.ROOT);
                                String hVal = hLine.substring(colon + 1).trim();
                                if ("transfer-encoding".equals(hName) && hVal.toLowerCase(Locale.ROOT).contains("chunked")) {
                                    isChunked = true;
                                } else if ("content-length".equals(hName)) {
                                    try {
                                        contentLength = Integer.parseInt(hVal);
                                    } catch (NumberFormatException ignored) {}
                                }
                            }
                        }
                    }

                    if (headerEndByteIdx >= 0) {
                        int bodyReceived = cur.length - (headerEndByteIdx + 4);
                        if (contentLength >= 0 && bodyReceived >= contentLength) {
                            break;
                        }
                        if (isChunked && hasChunkedTerminator(cur, headerEndByteIdx + 4)) {
                            break;
                        }
                    }
                }
            } catch (java.net.SocketTimeoutException ste) {
                if (headerEndByteIdx < 0 || body.size() <= headerEndByteIdx + 4) {
                    throw ste;
                }
            }

            byte[] raw = body.toByteArray();

            HttpResult result = new HttpResult();
            if (headerEndByteIdx < 0) {
                headerEndByteIdx = findHeaderEnd(raw);
            }
            if (headerEndByteIdx < 0) {
                throw new IOException("Malformed HTTP response: missing header terminator");
            }
            String headers = new String(raw, 0, headerEndByteIdx, StandardCharsets.ISO_8859_1);
            int bodyOffset = headerEndByteIdx + 4;
            int bodyReceived = raw.length - bodyOffset;
            if (contentLength >= 0 && bodyReceived < contentLength) {
                throw new IOException("Incomplete HTTP response: received " + bodyReceived
                        + " of " + contentLength + " declared bytes");
            }
            if (isChunked && !hasChunkedTerminator(raw, bodyOffset)) {
                throw new IOException("Incomplete chunked response: missing terminal chunk");
            }
            if (contentLength < 0 && !isChunked && raw.length >= effectiveCap) {
                throw new IOException("Response exceeded " + effectiveCap + "-byte cap before end of stream");
            }
            int bodyLen = Math.max(0, raw.length - bodyOffset);
            byte[] bodyBytes = new byte[bodyLen];
            System.arraycopy(raw, bodyOffset, bodyBytes, 0, bodyLen);
            if (isChunked) {
                bodyBytes = decodeChunked(bodyBytes);
            }
            // Parse status line strictly (HTTP/1.x NNN ...)
            int firstCrLf = headers.indexOf("\r\n");
            String statusLine = firstCrLf >= 0 ? headers.substring(0, firstCrLf) : headers;
            int sp = statusLine.indexOf(' ');
            if (sp > 0) {
                int sp2 = statusLine.indexOf(' ', sp + 1);
                String codeStr = (sp2 > 0 ? statusLine.substring(sp + 1, sp2) : statusLine.substring(sp + 1)).trim();
                try {
                    result.status = Integer.parseInt(codeStr);
                } catch (NumberFormatException ignored) {}
            }
            if (result.status < 100 || result.status > 599) {
                throw new IOException("Malformed HTTP status line");
            }
            // Parse headers line by line using colon index
            for (String line : headers.split("\r\n")) {
                int colon = line.indexOf(':');
                if (colon <= 0) continue;
                String hName = line.substring(0, colon).trim().toLowerCase(Locale.ROOT);
                String hVal = line.substring(colon + 1).trim();
                if ("location".equals(hName)) {
                    result.location = hVal;
                } else if ("set-cookie".equals(hName)) {
                    parseSetCookie(hVal, host);
                } else if ("content-encoding".equals(hName)) {
                    contentEncoding = hVal.toLowerCase(Locale.ROOT);
                }
            }
            // Content-Encoding is decoded after the header pass: gzip/deflate
            // only (the advertised set). An engine answering with anything
            // else (br, zstd) gets a hard error, never a silent mojibake body.
            if (contentEncoding != null && !"identity".equals(contentEncoding)) {
                bodyBytes = decodeContentEncoding(bodyBytes, contentEncoding);
            }
            result.body = new String(bodyBytes, StandardCharsets.UTF_8);
            return result;
        } finally {
            try { socket.close(); } catch (IOException ignored) {}
        }
    }

    static String buildCookieHeader(String host) {
        Map<String, String> cookies = cookieJar.get(host);
        if (cookies == null || cookies.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        boolean first = true;
        for (Map.Entry<String, String> entry : cookies.entrySet()) {
            if (!first) sb.append("; ");
            sb.append(entry.getKey()).append("=").append(entry.getValue());
            first = false;
        }
        return sb.toString();
    }

    static void parseSetCookie(String header, String host) {
        String[] parts = header.split(";");
        if (parts.length == 0) return;
        String nameValue = parts[0].trim();
        int eq = nameValue.indexOf('=');
        if (eq <= 0) return;
        String name = nameValue.substring(0, eq).trim();
        String value = nameValue.substring(eq + 1).trim();
        if (name.isEmpty() || name.length() > 256 || value.length() > 4096) return;
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (c <= 0x20 || c >= 0x7f || c == ';' || c == '=') return;
        }
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c < 0x20 || c >= 0x7f || c == ';') return;
        }
        Map<String, String> cookies = cookieJar.get(host);
        if (cookies == null) {
            cookies = new ConcurrentHashMap<>();
            cookieJar.put(host, cookies);
        }
        cookies.put(name, value);
    }

    private static int findHeaderEnd(byte[] data) {
        for (int i = 0; i <= data.length - 4; i++) {
            if (data[i] == '\r' && data[i + 1] == '\n' && data[i + 2] == '\r' && data[i + 3] == '\n') {
                return i;
            }
        }
        return -1;
    }

    /**
     * Detects the end of an HTTP chunked body, supporting both standard
     * `0\r\n\r\n` terminators and optional trailer sections (`0\r\nTrailer: x\r\n\r\n`).
     */
    static boolean hasChunkedTerminator(byte[] data, int bodyStart) {
        int len = data.length;
        if (len - bodyStart < 5) return false;
        if (data[len - 4] != '\r' || data[len - 3] != '\n'
                || data[len - 2] != '\r' || data[len - 1] != '\n') {
            return false;
        }
        int pos = bodyStart;
        while (pos < len) {
            int lineEnd = -1;
            for (int i = pos; i <= len - 2; i++) {
                if (data[i] == '\r' && data[i + 1] == '\n') {
                    lineEnd = i;
                    break;
                }
            }
            if (lineEnd < 0) return false;
            String sizeHex = new String(data, pos, lineEnd - pos, StandardCharsets.US_ASCII).trim();
            int semi = sizeHex.indexOf(';');
            if (semi >= 0) sizeHex = sizeHex.substring(0, semi).trim();
            int chunkSize;
            try {
                chunkSize = Integer.parseInt(sizeHex, 16);
            } catch (NumberFormatException e) {
                return false;
            }
            if (chunkSize < 0) return false;
            if (chunkSize == 0) {
                return lineEnd + 4 <= len;
            }
            pos = lineEnd + 2 + chunkSize + 2;
        }
        return false;
    }

    static byte[] decodeChunked(byte[] body) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int pos = 0;
        while (pos < body.length) {
            int lineEnd = -1;
            for (int i = pos; i <= body.length - 2; i++) {
                if (body[i] == '\r' && body[i + 1] == '\n') {
                    lineEnd = i;
                    break;
                }
            }
            if (lineEnd < 0) {
                throw new IOException("Truncated chunk header");
            }
            String sizeHex = new String(body, pos, lineEnd - pos, StandardCharsets.US_ASCII).trim();
            int semi = sizeHex.indexOf(';');
            if (semi >= 0) sizeHex = sizeHex.substring(0, semi).trim();
            int chunkSize;
            try {
                chunkSize = Integer.parseInt(sizeHex, 16);
            } catch (NumberFormatException e) {
                throw new IOException("Malformed chunk size", e);
            }
            if (chunkSize < 0) {
                throw new IOException("Negative chunk size");
            }
            if (chunkSize == 0) {
                return out.toByteArray();
            }
            pos = lineEnd + 2;
            if (body.length - pos < chunkSize) {
                throw new IOException("Truncated chunk body");
            }
            out.write(body, pos, chunkSize);
            pos += chunkSize + 2;
        }
        return out.toByteArray();
    }

    static byte[] decodeContentEncoding(byte[] body, String encoding) throws IOException {
        InputStream src;
        if ("gzip".equals(encoding)) {
            src = new GZIPInputStream(new ByteArrayInputStream(body));
        } else if ("deflate".equals(encoding)) {
            src = new InflaterInputStream(new ByteArrayInputStream(body));
        } else {
            throw new IOException("Unsupported Content-Encoding: " + encoding);
        }
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] tmp = new byte[8192];
            int n;
            int total = 0;
            while ((n = src.read(tmp)) > 0) {
                total += n;
                if (total > MAX_BODY) {
                    throw new IOException("Decompressed body exceeds " + MAX_BODY + "-byte cap");
                }
                out.write(tmp, 0, n);
            }
            return out.toByteArray();
        } finally {
            src.close();
        }
    }

    private static byte[] readN(InputStream in, int n) throws IOException {
        byte[] buf = new byte[n];
        int off = 0;
        while (off < n) {
            int r = in.read(buf, off, n - off);
            if (r < 0) throw new IOException("unexpected EOF");
            off += r;
        }
        return buf;
    }

    private static String socksError(byte code) {
        switch (code) {
            case 0x01: return "general failure";
            case 0x02: return "connection not allowed";
            case 0x03: return "network unreachable";
            case 0x04: return "host unreachable";
            case 0x05: return "connection refused";
            case 0x06: return "TTL expired";
            case 0x07: return "command not supported";
            case 0x08: return "address type not supported";
            default: return "unknown error 0x" + Integer.toHexString(code & 0xFF);
        }
    }
}
