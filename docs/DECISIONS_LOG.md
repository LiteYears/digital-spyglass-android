# Ghost Family — Decisions Log

What is NOT built, and why. The doctrine carries the load-bearing rules
for what exists; this log carries the evaluated-and-rejected items so a
future review doesn't re-derive them — or re-litigate them without new
evidence. Each entry states the proposal, the verdict, and the decisive
reason. An entry may be revisited only if its stated reason stops being
true.

Format: `YYYY-MM-DD — proposal — verdict — decisive reason`.

Vocabulary discipline (learned 2026-10-30, after seven items were
reclassified in one day): **"accepted" is a risk decision — the
item stays open by choice, with a named cost. "Deferred" is a
time decision — the item is buildable and not yet built, with a
named priority.** Writing "accepted" where "deferred" is meant is
a category error that lets unfinished work pose as judgment.
Every open item below states which of the two it is.

---

## 2026-10-30 — Pi-hole (DNS sinkhole) as a suite component — REJECTED, structural

**Proposal:** integrate a Pi-hole-style DNS blocker into the Ghost app
family (operator idea, explicitly exploratory).

**Verdict:** rejected as a suite component. A DNS sinkhole inside the
family would observe and block literally nothing, for structural reasons:

1. **`.onion` has no DNS at all.** Onion addresses are not DNS names;
   the Tor client resolves them via HSDir descriptors entirely inside
   the Tor network. No DNS query exists to intercept.
2. **Tor bypasses local DNS — but only via the unresolved-socket path.**
   The claim "Tor bypasses local DNS by design" holds only when remote
   addresses are constructed with `InetSocketAddress.createUnresolved(host,
   port)` — the proxy receives the hostname and resolves remotely.
   **Correction (same day):** the first version of this entry called
   `new InetSocketAddress(String, int)` "the unresolved form". That was
   a false positive: per JavaDoc that constructor *attempts* resolution
   internally (implicit `getByName`) and only flags the address
   unresolved on failure. Consequences found in `TorChecker`:
   `.onion` hosts emitted a doomed local DNS query on every connect
   (failed resolution still leaks the hostname); `www.torproject.org`
   resolved *successfully* on every circuit probe — a real, working
   DNS leak of a Tor-related lookup. A grep for `getByName` could never
   find this; the leak lived inside the constructor. Fixed by switching
   all remote-target addresses to `createUnresolved` (proxy-side
   `127.0.0.1` literals unchanged — numeric literals never query DNS,
   and a direct connect requires a resolved address anyway).
   Hardware-verified 2026-10-30: fake onion → `UNREACHABLE_CIRCUIT`
   (probe path exercised), Ahmia onion → `UP`/200 (remote resolution
   intact). Remaining paths audited same day: the entire network
   surface is five `InetSocketAddress` sites in one file — HTTP is
   spoken manually over the raw SOCKS socket (`GET … HTTP/1.1` write,
   hand-parsed status line), so the OkHttp `Dns.SYSTEM` leak class
   cannot exist; the header parser reads only `content-length` and
   `code != 200` returns `DOWN_HTTP`, so redirect-following is
   structurally absent, not disabled. **Method lesson, generalized:**
   source-level grep audits are insufficient for implicit calls inside
   constructors; DNS-silence verification must be runtime — packet
   capture or a DNS log. Status: code-level verified, packet-level
   pending an AdGuard Home deployment on the edge node (the trigger
   that converts this from contract semantics to observed silence).
3. **Per-component network surface differs.** Vault is a Capacitor
   WebView loading only bundled `dist/` assets — zero remote requests
   from the UI layer. Watch is native with exactly one network path:
   SOCKS5 to `127.0.0.1:9050`, everything else excluded by manifest and
   code invariant. Neither layer emits DNS a sinkhole could see.

**The suite's functional equivalent already exists:** the seizure
signature list. Pi-hole flags bad domains at the DNS layer; the list
flags seized services at the content layer — the only layer that
reaches `.onion` at all. (Analogy, not equivalence: a sinkhole blocks
before connect; the signature check recognizes after fetch.)

**The viable variant lives one floor down — home infrastructure, not
suite.** The operator already runs a Pi edge node in the IntelShed mesh
(192.168.1.121). AdGuard Home there (preferred over Pi-hole: DoH/DoT
support, actively maintained, single binary) protects home clearnet for
all LAN devices — a separate trust boundary and a separate (IntelShed)
project. Framing: the suite guards the darknet path; a sinkhole guards
the home path.

**And the inversion worth keeping:** a home sinkhole cannot protect the
suite, but it *can detect suite bugs* — if Watch ever regresses to a
resolved-socket path, an `.onion` hostname would appear in the sinkhole's
DNS log. Not hypothetical: the regression existed today (see correction
above) and a deployed sinkhole would have caught it before review did.
That is an argument for the AdGuard deployment, not for integrating one
into the suite.

**Revisit only if:** a future component emits DNS-resolvable traffic
(e.g., a clearnet companion outside Tor-only invariants).

---

## 2026-10-30 — HTTP client library for TorChecker — REJECTED, hand-rolled parser accepted with explicit bounds

**Proposal:** use a real HTTP client (OkHttp / `HttpURLConnection`) for
Watch's per-item GET over the SOCKS socket.

**Verdict:** rejected. A client library re-opens exactly the surfaces
the Tor-only rule exists to close: OkHttp resolves via `Dns.SYSTEM`
before the `SocketFactory` is invoked (DNS leak outside `TorChecker`,
invisible to a `getByName` grep), and `HttpURLConnection` follows
redirects — potentially to clearnet hosts — by default. The raw
`Socket` + manual `GET … HTTP/1.1` makes both classes structurally
absent, not merely disabled. The entire network surface is five
`InetSocketAddress` sites in one file.

**The trade, stated:** a library carries its own bounds; the
hand-rolled parser must define its own. Current bounds in `TorChecker`
(verified 2026-10-30, `CONNECT_TIMEOUT_MS=15s`, `READ_TIMEOUT_MS=30s`,
`MAX_BODY_BYTES=256 KiB`):

| Case | Behavior |
|---|---|
| `content-length` 100 MB | body capped at 256 KiB — no OOM |
| header missing / chunked | request speaks **HTTP/1.0** — chunked does not exist in 1.0, so the class is eliminated at the protocol level (device-verified: Ahmia `UP`/200 over 1.0). A spec-violating chunked reply still arrives as raw framing; a needle split across a chunk boundary can be missed — named residual |
| `Content-Encoding` (gzip/br/deflate) | request advertises **no `Accept-Encoding`** — a compliant server cannot legally send compressed content; a violating one yields opaque bytes → signature FN. No decompressor by design: a capped gunzip would reintroduce a decompression-bomb surface that must itself be bounded |
| UTF-16/other charsets | no `Accept-Charset` sent; non-ASCII-compatible bodies need an unusual explicit server config — named FN residual |
| `content-length` semantics | **ignored entirely** — the parser stops trusting the declared length: body is read to `Connection: close` EOF or the 256 KiB cap, so a lying-small header can no longer hide a signature. The under-read FN was eliminated, not accepted (same-day fix, device-verified) |
| header lies big (10 MB claimed, closes at 100 B) | reads to EOF — bounded |
| malformed status line | `parseCode` fails soft → `code=0` → `DOWN_HTTP(0)` — fail-closed, no exception escape |
| signature matcher | byte-level case-folded substring scan (`A-Z→a-z`), no regex — **no ReDoS**; substring FP (e.g. `fbi` inside a longer token) is a recall-favored design choice |
| cumulative wall-clock | **45 s per-item deadline, now exact** — the connect call itself is bounded by the remaining budget (`connect(addr, min(15 s, remaining))`), so per-item worst case is the deadline, not deadline + connect overrun. At `PARALLELISM=8`, eight hostile slow-drip peers block all slots for at most ≈6 min, vs. the previous 90-minute `awaitTermination` cap. Closes a concept-implementation gap — the spec already said "per-item deadline 45 s" — and a real vector |
| meta-refresh / JS redirects | semantic blindness, accepted: the parser returns `UP` on a 200 whose body is only a `<meta http-equiv="refresh">` — the seized destination is never fetched. The alternative (HTML execution) is a larger attack surface than the blindness |

The response-content layer is now inventorized: compliant-server
encodings are eliminated by the request itself (HTTP/1.0, no
`Accept-Encoding`/`Accept-Charset`); spec-violating servers produce
named false-negatives, never leaks or crashes. All blindness-class
residuals are bounded by the next run.

**Revisit only if:** the threat model shifts to adversaries who craft
responses specifically to evade Watch (spec-violating encodings), or
the work
set may contain services controlled by a single adversary (slot-
exhaustion residual: the 45 s deadline bounds it, it does not remove
the parallelism cap).

**External validation (2026-10-30, post-implementation):**
- Tor Project's own leak oracle makes our pending packet-level test
  easier than planned: `TestSocks 1` in torrc logs a `warn` for every
  connection handed an IP instead of a hostname, and `SafeSocks 1`
  *rejects* such connects outright. Enabling `TestSocks` in Orbot's
  torrc turns "DNS silence" into a Tor-side log assertion — no
  tcpdump/root/AdGuard needed. The AdGuard deployment remains the
  stronger in-the-wild detector, but the controlled test is now
  unblocked.
- OkHttp's own history confirms the rejected-library analysis: issue
  square/okhttp#2795 documents `Dns.SYSTEM` resolving before the
  `SocketFactory` — exactly the leak class the raw socket avoids.
  `InetSocketAddress.createUnresolved` is the canonical "SOCKS5 with
  hostnames" flavor (same semantics as `curl --socks5-hostname`).
- Independent convergence: FBI_Watchdog monitors `.onion` seizure
  banners via Tor SOCKS with a content cap (5 MB vs our 256 KiB —
  banners live in the first KBs) and one retry on a fresh circuit;
  Onionprobe (Tor Project, v1.4.0) separates descriptor vs. service
  reachability the way our `UNREACHABLE_*` attribution does.
- Caveat found in the same search: `createUnresolved` threw on
  Apache-Harmony-era Android (pre-ART SOCKS4-only sockets). Verified
  working on API 34; `minSdk 22` is post-ART and expected fine, but
  only one API level is device-verified — second-device spot check
  before release if an older unit is available.
- **Tor-observed DNS silence — verified (2026-10-30, same day).**
  Orbot's custom-torrc field set to `TestSocks 1`; Tor then logged
  for both probe classes: `NOTICE: Your application (using socks5
  to port 80) instructed Tor to take care of the DNS resolution
  itself if necessary. This is good.` — once for the Ahmia `.onion`
  connect and once for the fake-onion/circuit-probe path; zero
  `warn` lines across the log. Tor itself testifies that Watch
  delegated resolution — stronger than the `createUnresolved`
  contract claim, and the first evidence class independent of our
  own code. **Precise scope:** TestSocks observes only connections
  that reach Tor — a hypothetical non-SOCKS stray query would never
  appear in its log. The five-site inventory makes strays
  unlikely but does not prove absence; the AdGuard/tcpdump
  deployment remains the only *full-packet* proof and stays tracked
  as the one residual this test cannot close.
- **Operational decision:** `TestSocks 1` stays enabled in Orbot's
  torrc as a standing canary — a future regression (e.g. a
  constructor change back to implicit resolution) produces a `warn`
  immediately, independent of anyone remembering to re-run the
  check. **Full cost accounting:** not just NOTICE volume and log
  growth — the canary persists *connection timestamps* in Orbot's
  log, i.e. exactly the check-timing pattern the app's jitter
  decision deliberately avoids persisting in-app. A device-access
  adversary could read that log and reconstruct when Watch ran.
  Accepted for the canary's value; the jitter still applies — the
  log merely records it. Remove via Debug → custom torrc if
  unwanted.

**Residual classification — leak vs. blindness.** The open items
left by this entry are not one class: the Level-4 residual
(non-SOCKS stray DNS) is the only **leak-class** item — if it
exists, an observer sees something they should not, persistently.
Everything else — meta-refresh blindness, spec-violating-encoding
FNs, circuit-rotation misclassification — is **blindness-class**: the
check misses something, nothing outside observes it, and the next
run bounds it. The distinction matters because only leaks
retroactively undermine protection; a blindness is merely
incomplete now. Reopen thresholds are set accordingly: the
leak-class residual carries the AdGuard trigger; blindness-class
items reopen only on the stated adversary shifts.
