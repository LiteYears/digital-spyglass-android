#!/usr/bin/env node
/**
 * Weekly engine health check (CI cron).
 *
 * Probes every enabled engine through Tor using the SAME URL path the app
 * takes — the engine's `prepare` descriptor is replayed here (hidden-input
 * token prefetch, form introspection, math-captcha POST), so the probe
 * measures what the app actually does, not a naive template render.
 *
 * Updates health fields in src/lib/ghost/engines.json on --write:
 *   lastVerified          ISO date of this run
 *   status                ok | captcha | degraded (2xx, no onion links) | down
 *   consecutiveFailures   reset on ok/captcha, incremented otherwise
 *
 * `enabled` is NEVER touched — the pipeline reports, the operator decides.
 * Audit trail is the git diff, not a silent flag flip.
 *
 * Usage:  node scripts/engine-healthcheck.mjs [--write] [--proxy 127.0.0.1:9050]
 * Exit:   0 = run completed; 2 = >=50% of probed engines down (infra/Tor broken).
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { extractOnionLocation } from "./lib/onion-location.mjs";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, "..", "src", "lib", "ghost", "engines.json");

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const proxyIdx = args.indexOf("--proxy");
const PROXY = proxyIdx >= 0 ? args[proxyIdx + 1] : (process.env.TOR_PROXY ?? "127.0.0.1:9050");

const ONION_LINK_RE = /https?:\/\/[a-z2-7]{16,56}\.onion/i;
const CAPTCHA_RE = /captcha|challenge|verify you are|are you human|ddos-guard/i;
const UA = "Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0";

function render(template, baseUrl, q, page) {
  return template
    .replaceAll("{base}", baseUrl)
    .replaceAll("{q}", encodeURIComponent(q))
    .replaceAll("{page}", String(page))
    .replaceAll("{start}", String((page - 1) * 10));
}

function searchUrl(e, q, page) {
  return render(page > 1 && e.pagedUrl ? e.pagedUrl : e.searchUrl, e.baseUrl, q, page);
}

async function curl(url, timeoutMs, post = null, withHeaders = false) {
  const argv = [
    "--socks5-hostname",
    PROXY,
    "-sS",
    "-L",
    "--max-redirs",
    "3",
    // Match app semantics: cap the CONNECT, then let the transfer stream —
    // onion search pages are heavy (ahmia ~1.7MB) and legitimately slow.
    "--connect-timeout",
    String(Math.ceil(timeoutMs / 1000)),
    "-m",
    String(Math.ceil((timeoutMs + 90000) / 1000)),
    "-w",
    "\n%{http_code}",
    "-o",
    "-",
    "-A",
    UA,
  ];
  if (withHeaders) argv.push("-i");
  if (post) argv.push("-d", post.body);
  argv.push(post ? post.url : url);
  try {
    const { stdout } = await run("curl", argv);
    const lastNl = stdout.lastIndexOf("\n");
    const code = parseInt(stdout.slice(lastNl + 1), 10) || 0;
    let body = stdout.slice(0, lastNl);
    let headers = null;
    if (withHeaders) {
      const sep = body.indexOf("\r\n\r\n");
      if (sep >= 0) {
        headers = {};
        for (const line of body.slice(0, sep).split("\r\n").slice(1)) {
          const c = line.indexOf(":");
          if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
        }
        body = body.slice(sep + 4);
      }
    }
    return { code, body, headers };
  } catch {
    return { code: 0, body: "", headers: null };
  }
}

/* Replays the app's prepareSearchUrl flows against the live service. */
async function resolveProbeUrl(e, q, page, timeout) {
  const prep = e.prepare;
  if (!prep) return { url: searchUrl(e, q, page), notes: "direct" };
  const pageUrl =
    prep.page === "{searchUrl}"
      ? searchUrl(e, q, page)
      : render(prep.page ?? "{base}/", e.baseUrl, q, page);
  const fallback = e.fallbackUrl
    ? render(e.fallbackUrl, e.baseUrl, q, page)
    : searchUrl(e, q, page);

  if (prep.type === "hidden_input") {
    const { code, body } = await curl(pageUrl, timeout);
    if (code === 200) {
      const m = body.match(/<input\s+type="hidden"\s+name="([a-f0-9]+)"\s+value="([a-f0-9]+)"/i);
      if (m) return { url: `${searchUrl(e, q, page)}&${m[1]}=${m[2]}`, notes: "token" };
    }
    return { url: fallback, notes: `prefetch-failed(http=${code})` };
  }

  if (prep.type === "form_introspect") {
    const { code, body } = await curl(pageUrl, timeout);
    if (code === 200) {
      for (const m of body.matchAll(/<form[^>]*>/gi)) {
        const formTag = m[0];
        const formEnd = body.indexOf("</form>", m.index);
        const formHtml = body.slice(m.index, formEnd > 0 ? formEnd + 7 : m.index + 2000);
        const action = (formTag.match(/action=["']([^"']*)["']/i) ?? [])[1] ?? "/";
        const params = new URLSearchParams();
        for (const input of formHtml.matchAll(/<input[^>]*name=["']([^"']*)["'][^>]*>/gi)) {
          const name = input[1];
          if (!name) continue;
          const value = (input[0].match(/value=["']([^"']*)["']/i) ?? [])[1] ?? "";
          if (/^(q|query|search|term|s)$/i.test(name)) params.set(name, q);
          else if (value) params.set(name, value);
        }
        let target = action;
        if (target.startsWith("/")) target = `${e.baseUrl}${target}`;
        else if (!target.startsWith("http")) target = `${e.baseUrl}/${target}`;
        return {
          url: `${target}${target.includes("?") ? "&" : "?"}${params}`,
          notes: "introspected",
        };
      }
    }
    return { url: fallback, notes: `introspect-failed(http=${code})` };
  }

  if (prep.type === "math_captcha") {
    const { code, body } = await curl(pageUrl, timeout);
    const re = new RegExp(prep.mathRe ?? "(\\d+)\\s*\\+\\s*(\\d+)", "i");
    const m = code === 200 ? body.match(re) : null;
    if (m) {
      const answer = parseInt(m[1], 10) + parseInt(m[2], 10);
      const postBody = (prep.body ?? "captcha_answer={answer}").replace("{answer}", String(answer));
      const postTarget =
        !prep.postUrl || prep.postUrl === "{searchUrl}"
          ? searchUrl(e, q, page)
          : render(prep.postUrl, e.baseUrl, q, page);
      const postResp = await curl(null, timeout, { url: postTarget, body: postBody });
      return { url: searchUrl(e, q, page), notes: `captcha-solved(http=${postResp.code})` };
    }
    return { url: searchUrl(e, q, page), notes: `captcha-unsolved(http=${code})` };
  }

  return { url: searchUrl(e, q, page), notes: "direct" };
}

function classify(code, body, probeNotes) {
  if (code >= 200 && code < 300) {
    if (ONION_LINK_RE.test(body)) return "ok";
    if (CAPTCHA_RE.test(body.slice(0, 6000))) return "captcha";
    return "degraded";
  }
  if (code >= 300 && code < 400) return "redirect"; // -L should have followed; still = alive
  /* Prefetch answered (token/introspection/captcha solved) but the search
     fetch failed: the onion is provably reachable — that is degraded, not
     down. "down" means nothing responded at all. */
  if (/^(token|introspected|captcha-solved)/.test(probeNotes)) return "degraded";
  return "down";
}

const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));

/* Warm-up: build circuits + rendezvous state before probing. A cold Tor
   daemon systematically over-reports "down" on slow onions (fresh 6-hop
   paths vs. the warm Orbot circuits real users have). One throwaway fetch
   primes the daemon; results are discarded on purpose. */
await curl("https://check.torproject.org/", 30000);
const firstBase = registry.engines.find((e) => e.enabled !== false)?.baseUrl;
if (firstBase) await curl(`${firstBase}/`, 30000);

const today = new Date().toISOString().slice(0, 10);
const QUERY = args.indexOf("--query") >= 0 ? args[args.indexOf("--query") + 1] : "test";
let probed = 0;
let down = 0;

/* All engines in parallel — Tor multiplexes streams over shared circuits,
   the same way the app queries 13 engines concurrently. Run time is then
   bounded by the slowest engine, not the sum. */
async function probeOne(e) {
  probed++;
  const timeout = (e.connectTimeoutMs ?? 20000) + 5000;
  const probe = await resolveProbeUrl(e, QUERY, 1, timeout);
  let { code, body } = await curl(probe.url, timeout);
  // Onion services flap: one retry on transport failure before counting a miss.
  if (code === 0) {
    await new Promise((r) => setTimeout(r, 5000));
    ({ code, body } = await curl(probe.url, timeout));
  }
  const status = classify(code, body, probe.notes);

  /* Onion-location discovery (report-only): engines that rotate often keep an
     announcement on the old page. Meta tag from the probe body is free; only
     for non-ok engines do we spend one extra header fetch on the homepage. */
  let onionLocation = code > 0 ? extractOnionLocation({ body, baseUrl: e.baseUrl }) : null;
  if (!onionLocation && status !== "ok" && code > 0) {
    const home = await curl(`${e.baseUrl}/`, timeout, null, true);
    if (home.code >= 200 && home.code < 400) {
      onionLocation = extractOnionLocation({
        headers: home.headers,
        body: home.body,
        baseUrl: e.baseUrl,
      });
    }
  }
  if (onionLocation) {
    console.log(
      `onion-location candidate ${e.id}: ${onionLocation.url} (${onionLocation.source}) — promote manually via MR if verified`,
    );
  }

  const h = (e.health ??= {});
  h.lastVerified = today;
  h.status = status;
  if (status === "ok" || status === "captcha" || status === "redirect") {
    h.consecutiveFailures = 0;
    h.consecutiveDegraded = 0;
  } else if (status === "degraded") {
    // Reachable but impaired (e.g. prefetch OK, search path dead/heavy).
    // Tracked separately — it must not feed the outage alarm.
    h.consecutiveDegraded = (h.consecutiveDegraded ?? 0) + 1;
  } else {
    h.consecutiveFailures = (h.consecutiveFailures ?? 0) + 1;
    h.consecutiveDegraded = 0;
    down++;
  }
  console.log(
    `${status.padEnd(9)} ${e.id.padEnd(14)} http=${String(code).padEnd(3)} ` +
      `failures=${h.consecutiveFailures} degraded=${h.consecutiveDegraded ?? 0} via=${probe.notes}`,
  );
  return {
    id: e.id,
    status,
    http: code,
    failures: h.consecutiveFailures,
    degraded: h.consecutiveDegraded ?? 0,
    via: probe.notes,
    ...(onionLocation ? { onionLocation } : {}),
  };
}

const byId = new Map(
  await Promise.all(registry.engines.filter((e) => e.enabled !== false).map(probeOne)).then((rs) =>
    rs.map((r) => [r.id, r]),
  ),
);
const report = registry.engines.map(
  (e) => byId.get(e.id) ?? { id: e.id, status: "disabled", note: "skipped" },
);

console.log(JSON.stringify({ date: today, proxy: PROXY, probed, down, report }, null, 2));
if (WRITE) {
  writeFileSync(REGISTRY, JSON.stringify(registry, null, 2) + "\n");
  console.log("engines.json updated");
}
process.exit(probed === 0 || down >= probed / 2 ? 2 : 0);
