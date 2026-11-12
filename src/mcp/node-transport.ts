import * as net from "node:net";
import * as tls from "node:tls";
import { URL } from "node:url";
import type { TransportLayer } from "./transport";

const DEFAULT_SOCKS_HOST = "127.0.0.1";
const DEFAULT_SOCKS_PORT = 9050;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";
const CONNECT_TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 30_000;

type NodeTransportOptions = {
  socksHost: string | undefined;
  socksPort: number | undefined;
  userAgent: string | undefined;
};

function generateSocksAuth(): { user: string; pass: string } {
  return {
    user: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
    pass: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${label} after ${ms}ms`)), ms),
    ),
  ]);
}

function buildSocks5Greeting(auth: { user: string; pass: string }): Buffer {
  return Buffer.from([0x05, 0x02, 0x00, 0x02]);
}

function buildSocks5Auth(auth: { user: string; pass: string }): Buffer {
  const u = Buffer.from(auth.user, "utf8");
  const p = Buffer.from(auth.pass, "utf8");
  return Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]);
}

function buildSocks5ConnectRequest(host: string, port: number): Buffer {
  const isOnion = host.endsWith(".onion");
  const hostBuf = Buffer.from(host, "utf8");
  if (isOnion || hostBuf.length > 0) {
    return Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03]),
      Buffer.from([hostBuf.length]),
      hostBuf,
      Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    ]);
  }
  return Buffer.from([0x05, 0x01, 0x00, 0x03, 0x00, (port >> 8) & 0xff, port & 0xff]);
}

async function socks5Connect(
  socksHost: string,
  socksPort: number,
  destHost: string,
  destPort: number,
  auth: { user: string; pass: string },
  timeoutMs: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socksPort, socksHost);
    const state = { step: 0 as 0 | 1 | 2 | 3, buffer: Buffer.alloc(0) };
    let settled = false;

    const cleanup = () => {
      socket.removeAllListeners();
      if (!settled) {
        settled = true;
        socket.destroy();
      }
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`SOCKS5 connect timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(buildSocks5Greeting(auth));
    });

    socket.on("data", (chunk: Buffer) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);

      if (state.step === 0) {
        if (state.buffer.length < 2) return;
        const ver = state.buffer[0];
        const method = state.buffer[1];
        if (ver !== 0x05) {
          cleanup();
          clearTimeout(timer);
          reject(new Error(`SOCKS5 bad version: ${ver}`));
          return;
        }
        if (method === 0x02) {
          socket.write(buildSocks5Auth(auth));
          state.step = 1;
          state.buffer = state.buffer.slice(2);
        } else if (method === 0x00) {
          socket.write(buildSocks5ConnectRequest(destHost, destPort));
          state.step = 2;
          state.buffer = state.buffer.slice(2);
        } else {
          cleanup();
          clearTimeout(timer);
          reject(new Error(`SOCKS5 no acceptable method: ${method}`));
          return;
        }
      } else if (state.step === 1) {
        if (state.buffer.length < 2) return;
        const ver = state.buffer[0];
        const status = state.buffer[1];
        if (ver !== 0x01 || status !== 0x00) {
          cleanup();
          clearTimeout(timer);
          reject(new Error(`SOCKS5 auth failed: status=${status}`));
          return;
        }
        socket.write(buildSocks5ConnectRequest(destHost, destPort));
        state.step = 2;
        state.buffer = state.buffer.slice(2);
      } else if (state.step === 2) {
        if (state.buffer.length < 4) return;
        const ver = state.buffer[0];
        const rep = state.buffer[1];
        if (ver !== 0x05) {
          cleanup();
          clearTimeout(timer);
          reject(new Error(`SOCKS5 bad version in reply: ${ver}`));
          return;
        }
        if (rep !== 0x00) {
          cleanup();
          clearTimeout(timer);
          reject(new Error(`SOCKS5 connect rejected: rep=${rep}`));
          return;
        }
        const atyp = state.buffer[3];
        let addrLen = 4;
        if (atyp === 0x01) addrLen = 4;
        else if (atyp === 0x03) addrLen = (state.buffer[4] ?? 0) + 1;
        else if (atyp === 0x04) addrLen = 16;
        const totalNeeded = 4 + addrLen + 2;
        if (state.buffer.length < totalNeeded) return;
        clearTimeout(timer);
        settled = true;
        socket.removeAllListeners();
        resolve(socket);
      }
    });

    socket.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`SOCKS5 socket error: ${err.message}`));
      }
    });
  });
}

export class NodeTorTransport implements TransportLayer {
  private userAgent: string;
  private socksAuth: { user: string; pass: string };
  private socksHost: string;
  private socksPort: number;

  constructor(
    opts: NodeTransportOptions = {
      socksHost: undefined,
      socksPort: undefined,
      userAgent: undefined,
    },
  ) {
    this.socksHost = opts.socksHost ?? DEFAULT_SOCKS_HOST;
    this.socksPort = opts.socksPort ?? DEFAULT_SOCKS_PORT;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.socksAuth = generateSocksAuth();
  }

  async isNative(): Promise<boolean> {
    return false;
  }

  async torFetch(
    url: string,
    userAgent: string,
    opts?: {
      method?: "GET" | "POST";
      body?: string;
      socksAuth?: { user: string; pass: string };
    },
  ): Promise<{ status: number; body: string }> {
    const method = opts?.method ?? "GET";
    const auth = opts?.socksAuth ?? this.socksAuth;
    const ua = userAgent || this.userAgent;

    const parsed = new URL(url);
    const destHost = parsed.hostname;
    const destPort = parsed.port
      ? parseInt(parsed.port, 10)
      : parsed.protocol === "https:"
        ? 443
        : 80;
    const isHttps = parsed.protocol === "https:";

    let socket: net.Socket;
    try {
      socket = await withTimeout(
        socks5Connect(this.socksHost, this.socksPort, destHost, destPort, auth, CONNECT_TIMEOUT_MS),
        CONNECT_TIMEOUT_MS,
        `SOCKS5 ${url}`,
      );
    } catch (e) {
      throw new Error(`SOCKS connect failed for ${url}: ${(e as Error).message}`);
    }

    let conn: net.Socket | tls.TLSSocket = socket;
    if (isHttps) {
      try {
        conn = tls.connect({
          socket,
          servername: destHost,
          rejectUnauthorized: false,
        });
        await new Promise<void>((resolve, reject) => {
          conn.once("secureConnect", resolve);
          conn.once("error", reject);
          setTimeout(() => reject(new Error(`TLS timeout: ${url}`)), CONNECT_TIMEOUT_MS);
        });
      } catch (e) {
        socket.destroy();
        throw new Error(`TLS failed for ${url}: ${(e as Error).message}`);
      }
    }

    const path = parsed.pathname + parsed.search;
    const headers: string[] = [
      `${method} ${path} HTTP/1.1`,
      `Host: ${parsed.host}`,
      `User-Agent: ${ua}`,
      `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`,
      `Accept-Language: en-US,en;q=0.5`,
      `Connection: close`,
    ];

    if (method === "POST" && opts?.body) {
      headers.push(`Content-Type: application/x-www-form-urlencoded`);
      headers.push(`Content-Length: ${Buffer.byteLength(opts.body)}`);
    }
    headers.push("", "");

    const httpRequest = headers.join("\r\n") + (method === "POST" && opts?.body ? opts.body : "");

    const requestPromise = new Promise<{ status: number; body: string }>((resolve, reject) => {
      let rawData = Buffer.alloc(0);

      conn.on("data", (chunk: Buffer) => {
        rawData = Buffer.concat([rawData, chunk]);
      });

      conn.on("end", () => {
        const raw = rawData.toString("latin1");
        const headerEnd = raw.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          resolve({ status: 0, body: raw });
          return;
        }
        const statusLine = raw.slice(0, raw.indexOf("\r\n"));
        const statusMatch = statusLine.match(/HTTP\/\d\.\d (\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1] ?? "0", 10) : 0;
        let body = raw.slice(headerEnd + 4);

        const headerSection = raw.slice(0, headerEnd);
        const isChunked = /transfer-encoding:\s*chunked/i.test(headerSection);
        if (isChunked) {
          body = this.decodeChunked(body);
        }
        resolve({ status, body });
      });

      conn.on("error", reject);
      conn.setTimeout(READ_TIMEOUT_MS, () => {
        conn.destroy(new Error(`Read timeout: ${url}`));
      });

      conn.write(httpRequest, "latin1");
    });

    return withTimeout(requestPromise, CONNECT_TIMEOUT_MS + READ_TIMEOUT_MS, url);
  }

  private decodeChunked(body: string): string {
    let result = "";
    let pos = 0;
    while (pos < body.length) {
      const lineEnd = body.indexOf("\r\n", pos);
      if (lineEnd === -1) break;
      const sizeHex = body.slice(pos, lineEnd).trim();
      const size = parseInt(sizeHex, 16);
      if (isNaN(size) || size === 0) break;
      pos = lineEnd + 2;
      result += body.slice(pos, pos + size);
      pos += size + 2;
    }
    return result;
  }

  async purgeCookies(): Promise<void> {
    this.socksAuth = generateSocksAuth();
  }
}
