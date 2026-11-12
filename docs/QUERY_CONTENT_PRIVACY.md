# Query-Content Privacy Layer — Implementation Plan (27v)

Status (2026-10-28): design frozen (2026-10-27), on-device pipeline proven.
Guards and session core are implemented and tested but NOT wired into
search (see "Status" below). Local-model transport is unverified on device.
This is an engineering-integration task, not a research task.

## What this layer does

Ghost already ships a transport-layer defense (`src/lib/ghost/camouflage.ts`):
it shapes request timing and fires dummy requests to harmless .onion homepages,
which raises the cost of traffic-pattern fingerprinting.

This layer adds the complementary content layer:

1. **Semantic decoys** — a small on-device SLM generates plausible, diverse
   decoy queries during idle time (without seeing any real query) and stores
   them in a RAM-only pool. When a real search fires, decoy queries go out
   to real search endpoints alongside the real one. A passive observer at
   an engine cannot tell which query was the user's intent.
2. **Style neutralization** — the real query is rewritten by the SLM before
   it leaves the device, in the same language, by deleting/reordering its
   own words only (extractive; see "Rewrite guard"), removing author-style
   signal such as slang, fillers and sentence frame.
3. **Local truth** — the app alone knows which outgoing query is real. Only
   results for the real query are merged into the visible RRF result set.

## Hard honesty boundary (must appear in UI copy)

This layer does NOT protect against a global observer correlating circuit
timing, Tor entry/exit, or volume patterns. It addresses endpoint-level
content attribution only. Labels and docs must say so — never imply broader
coverage. See THREAT_MODEL.md.

## Model delivery: BYOM (decided)

The app does NOT bundle a model (~1 GB GGUF) and does NOT force an in-app
download. Same contract as Orbot: Ghost provides the interface and the
documentation; the user supplies the runtime. Concretely:

- The app connects to a user-provided local inference endpoint
  (e.g. llama.cpp `llama-server` on `127.0.0.1:PORT`), configurable in settings.
- If no endpoint is configured or reachable, the layer is simply inactive —
  fail-soft, never a gate. Tier 3 without a model = Tier 2 behavior + a
  clear status line.
- Reference implementation verified on-device (SM-G998B, Termux, Orbot):
  Bonsai-2-4B ternary GGUF, ~6 t/s generation, ~10 s cold call. Budget:
  the rewrite runs BEFORE the real query is sent, so it adds its full
  latency (cold ~10 s, hard cap 15 s) once per search; it cannot hide
  inside the fan-out window. Warm-call latency is not yet measured. Decoy
  generation is off this path (idle pool).

**Runtime compatibility — document explicitly, do not assume stock llama.cpp:**
Ternary Bonsai weights (`PTQ1_0`/`PQ2_0` formats) require the PrismML
llama.cpp fork (verified build: `prism-b10826-c9c34bc`) — stock upstream
`llama-server` and bundled runtimes (incl. current Ollama) reject or
mis-dequantize them, silently losing the speed advantage or failing
outright. The alternative `Q2_0` weight file runs on upstream llama.cpp
>= b11555. The BYOM docs must name the required fork/binary and the
exact model file — "just start llama-server" is a support trap.

## Reuse map — build ON phase5, do not rebuild it

| Existing (live in `camouflage.ts`) | Role for this layer |
|---|---|
| `startIdleDecoyScheduler(meanMs)` | Extend: besides transport dummies, periodically top up the SLM decoy pool (target size ~5–10) |
| `fireDecoys` / `SocksAuth` / `fetchBodyOnly` | Fire path for semantic decoy queries at real engine search URLs |
| `paranoidMode` flag + personas UI | Tier plumbing already exists — extend to 3 tiers instead of inventing new settings |
| `sampleRayleigh` / `assignSurgeDelays` / CSPRNG | Timing infra the decoy fan-out must keep using |
| `security.tsx` paranoid hint | Extend with the honest-label text for tier 3 |

New code needed: SLM endpoint client, decoy pool (RAM-only, purged like all
search state), style-neutralize call with ~15 s soft-fail timeout, per-engine
decoy query URLs (current `DECOY_TARGETS` only has 4 homepage endpoints),
and real-vs-decoy result filtering at merge time.

## Tier model (maps onto existing plumbing)

- **Tier 1 — standard:** existing `standardCamouflage` (timing shape, no decoys)
- **Tier 2 — enhanced transport:** existing `paranoidCamouflage` (transport
  decoys, shipped)
- **Tier 3 — content privacy:** Tier 2 + SLM rewrite + semantic decoys.
  Default-on *within* Tier 3; the SLM feature itself is opt-in for lower tiers.
  Open at wiring time: the frozen design makes it on within Tier 3, while
  repo policy defaults new flags OFF; decide explicitly and document it.
  Without a reachable model, Tier 3 behaves as Tier 2 plus a status line.

## Threat-honest scope notes

- Decoy quality is the critical success factor — formulaic or repetitive
  decoys are themselves a fingerprint. Research on chaff-based query
  obfuscation (GS-Chaff 2026; Pang et al. 2010) shows plausible decoys can
  push real-query identification toward chance (~22%), but only when they
  are diverse — NOT all semantically clustered on the real topic (tight
  clustering re-identifies the real one as the cluster's center). Pool
  entries must vary topic, specificity, length, and phrasing.
- **Variance enforcement is a test case, not a design wish:** pool admission
  runs an automatic similarity check — reject near-duplicates and reject
  candidates too similar to the pending real query. A small model has
  limited generative diversity; measure it, don't assume it.
- Semantic decoys fire real queries at real engines — bandwidth and engine
  load cost is real; pool size stays small.
- A decoy that fires no query (transport dummy to a homepage) looks different
  from a real search query. Optionally upgrade transport dummies to fire
  SLM decoys at search endpoints — merges both layers into one traffic shape.
- **Rewrite guard (implemented):** the neutralized query must preserve
  meaning, not just remove style. `isRewriteAcceptable` is a deterministic
  lexical check (extractive + must-keep, details under "Status"); on
  failure the raw query is sent — an over-neutralized query that loses
  intent is worse than no rewrite. It is not a semantic-equivalence proof.
- IME/keyboard sees typed queries regardless — OS limitation, documented.
- Real-vs-decoy state is RAM-only and participates in the existing purge
  paths (background purge, screen-off purge, panic wipe) — add the pool and
  the real-query marker to purge coverage tests.

## Implementation order (next instances)

Legend: [done] committed and unit-tested; [open] not started.

0. [done 2026-10-28] **Device test:** WebView `fetch` to
   `http://127.0.0.1:8080` FAILS with `net::ERR_CLEARTEXT_NOT_PERMITTED`
   (SM-G998B, debuggable probe build signed with the release key, origin
   `https://localhost`, `allowMixedContent: false`, cleartext-denying NSC;
   verified via CDP Network events; `mode: "no-cors"` blocked identically,
   so it is not CORS; the local server logged zero hits). Verdict per the
   frozen rule: no policy weakening — the transport must be a native
   Capacitor plugin. Because the NSC applies to HTTP stacks
   (HttpURLConnection/OkHttp) but not to raw sockets, the plugin uses a
   raw TCP socket to literal `127.0.0.1` only: cleartext never leaves the
   device, NSC and Tor policy stay untouched.
1. [done] Endpoint validation: `localInferenceEndpoint()` (literal
   loopback, explicit port, no credentials/query). [open] Settings field,
   reachability probe, status line, BYOM docs link.
2. [done 2026-10-28, not yet wired] Runtime client implementing
   `QueryPrivacyRuntime`: native Capacitor plugin `PianoLocalInference`
   (loopback-only raw socket HTTP client, see step 0) plus the thin TS
   wrapper `local-inference-runtime.ts`; temperature-pinned, abortable; two
   prompts: rewrite = delete/reorder own words only, same language, no
   additions; decoys = diverse, non-clustered, no real query in context.
   Verified on SM-G998B against a stub server (14 cases: success, chunked,
   malformed JSON, HTTP 500/302 without redirect following, oversized
   response, hard deadline against hanging and slow-drip servers, cancel,
   refused port, argument validation, in-flight cap); the raw loopback
   socket is not blocked by the NSC. The query text was not found in app
   data or logcat afterwards. Not yet measured: warm latency and output
   quality with a real model.
3. [done] Decoy pool core: bounded RAM-only pool (cap 10), `refill()`
   with near-duplicate admission, purge/abort. [open] Hook `refill()` into
   `startIdleDecoyScheduler`.
4. [done] Rewrite core: `prepare()` rewrites BEFORE any engine request;
   15 s soft-fail to the raw query; guard-checked. [open] Call it from
   `search.ts`, and show the actually-sent query in the results header
   ("sent as: ...") so an intent-losing rewrite is visible; the rewrite
   never replaces the raw query silently.
5. [open] Decoy fan-out: per-engine search-URL builders (current
   `DECOY_TARGETS` are homepages only; engine query contracts exist for
   only part of the registry), fired through the existing
   `fireDecoys`/`SocksAuth` path with camouflage timing; tag outgoing
   requests internally as real/decoy.
6. [open] Merge filter: only real-tagged results enter RRF, the visible
   set, case files, graph and summaries; decoy results are dropped.
7. [open] Tier wiring: T1/T2/T3 mapping, `security.tsx` labels with the
   honesty boundary, persona defaults, default of the T3 toggle.
8. Tests. [done] pool bounds, near-duplicate rejection, rewrite guard
   (accept/reject table), timeout fallback, purge/abort incl. a runtime
   that ignores abort. [open] tier gating, no-model fail-soft through the
   search path, decoy result exclusion, purge coverage for the real-query
   marker (background, screen-off, panic wipe), too-similar-to-real decoy
   rejection at fan-out time.
9. [open] USER_MANUAL.md: BYOM instructions naming the exact runtime
   build and model file. [done] THREAT_MODEL.md "Planned" section (move to
   a normal section when shipped).

## Status (2026-10-28)

Implemented, unwired, covered by unit tests (commit `e76b2c264a`):
`query-privacy-guards.ts` (decoy parsing, near-duplicate check, rewrite
guard, loopback endpoint validation) and `query-privacy.ts`
(`QueryPrivacySession`: bounded RAM-only pool, 15 s rewrite timeout,
purge/abort semantics, injected `QueryPrivacyRuntime`). Nothing calls
them from the search path yet; no decoy is sent anywhere.

### Rewrite scope (operator decision 2026-10-28): same language

The rewrite keeps the language of the query; it does not translate. The
language remains observable: it is a coarse, population-wide attribute,
while the removed style signal (function-word frequencies, syntax,
habitual phrasing, slang) is individual-specific. Hiding the language is a
separate problem this layer does not solve (documented in THREAT_MODEL.md).

### Rewrite guard (operator decision 2026-10-28): extractive + must-keep

A first guard version demanded that every non-filler word survive; it
accepted 0 of 6 realistic same-language rewrites and let additions through
(`cve-2024-3094` -> `cve-2024-3094 exploit code github`). Test rejecting
cases AND realistic accepting cases. `isRewriteAcceptable` now enforces:

1. No new vocabulary: the rewrite may only delete, reorder, or inflect
   original words (inflection = shared prefix >= max(5, shorter length - 2)
   and combined differing suffix <= 3 letters, e.g. findet/finden;
   install/instant and daten/datei are rejected).
2. Protected words (containing a digit or `._@:/+-`, e.g. versions, error
   codes, addresses, hostnames) verbatim and case-sensitive, both
   directions.
3. A closed negation set must match in both directions.
4. Queries with quotes/operators are never rewritten.

Known costs and limits, pinned by tests: synonym substitution is
impossible (dialect content words stay; slang, fillers, address forms and
sentence frame go); dropping a plain content word (`best nas for plex` ->
`best nas`) is NOT detected lexically, hence the "sent as" display. A
rewrite that changes language is rejected and falls back to the raw query.
The guard is lexical only, not a semantic-equivalence proof.

### Transport to the local endpoint (RESOLVED 2026-10-28 by device test)

WebView `fetch` to loopback HTTP is blocked by the cleartext policy
(`net::ERR_CLEARTEXT_NOT_PERMITTED`, measured — see step 0). The client
must therefore be a native Capacitor plugin, like the other native calls.
Design: loopback-only raw TCP socket (literal `127.0.0.1`, explicit port,
no DNS, no LAN ranges), HTTP/1.1 POST spoken by hand, abortable, timeout,
no cleartext beyond the device. NSC and Tor policy remain unchanged.
`localInferenceEndpoint()` validates the configured URL; reachability is
checked by the plugin at call time.

## Non-goals

- No bundled model, no forced download, no cloud inference for cover traffic.
- No claims against global traffic analysis — documented boundary only.
- No persistent decoy/result storage — RAM-only like all search state.
- No change to engine ranking, RRF, or registry verification.

## References

- `src/lib/ghost/camouflage.ts` — transport layer to extend
- `docs/THREAT_MODEL.md` — honesty boundary language
- `docs/GHOST_V2_PLAN.md` Phase 5 — transport-layer precedent
- On-device measurements (2026-10-27): Bonsai-4B 9.9 s cold call / 6.0 t/s;
  engine fan-out 5.3–15.5 s via forwarded Orbot. The rewrite precedes the
  fan-out, so its latency adds to it (it does not overlap).
