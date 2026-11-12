import { createFileRoute } from "@tanstack/react-router";
import { RotateCcw, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/app/app-shell";
import {
  ActionButton,
  Chip,
  Dot,
  EmptyState,
  MicroLabel,
  Panel,
  type Signal,
} from "@/components/app/primitives";
import {
  getHealthTrend,
  isDeprecated,
  isOpen,
  lastError,
  openUntil,
  resetBreaker,
  undeprecate,
} from "@/lib/ghost/breaker";
import {
  activeRegistry,
  applyImportedRegistry,
  bundledRegistry,
  ENGINES,
  enginesForFastMode,
  engineTier,
  isImportedRegistryActive,
  resetToBundledRegistry,
} from "@/lib/ghost/engines";
import { openExternal } from "@/lib/ghost/external";
import { refreshRegistryChainStatus } from "@/lib/ghost/registry-chain";
import {
  base64ToSpkiBytes,
  clearImportedRegistry,
  diffRegistries,
  loadImportedRegistry,
  loadTrustedKeys,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_SIG_BYTES,
  pemToSpkiBytes,
  registrySequence,
  saveImportedRegistry,
  saveTrustedKey,
  sequenceFloorViolation,
  spkiFingerprint,
  spkiToBase64,
  validateEngineRegistry,
  verifyRegistryImport,
  type RegistryDiff,
} from "@/lib/ghost/registry-import";
import { resetRegistryVerification } from "@/lib/ghost/registry-signature";
import { readRegistryAnchor } from "@/lib/platform/native";
import { useGhost } from "@/lib/store/ghost-context";

export const Route = createFileRoute("/engines")({
  head: () => ({
    meta: [
      { title: "Engines — Ghost onion search" },
      {
        name: "description",
        content:
          "Choose which onion search engines Ghost queries, inspect circuit-breaker state, and open an engine directly in Tor Browser.",
      },
      { property: "og:title", content: "Engines — Ghost onion search" },
      {
        property: "og:description",
        content: "Per-engine selection, trust weight and live circuit state.",
      },
    ],
  }),
  component: EnginesScreen,
});

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function EnginesScreen() {
  const { settings, updateSettings } = useGhost();
  const [tick, setTick] = useState(0);
  const [filterQuery, setFilterQuery] = useState("");

  const fastSet = new Set(enginesForFastMode());
  const allOn = settings.engines.length === 0 && !settings.fastMode;
  const active = (id: string) => {
    if (settings.engines.length > 0) return settings.engines.includes(id);
    if (settings.fastMode) return fastSet.has(id);
    return true;
  };

  const toggle = (id: string) => {
    const current =
      settings.engines.length === 0
        ? settings.fastMode
          ? enginesForFastMode()
          : ENGINES.map((engine) => engine.id)
        : settings.engines;
    const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
    void updateSettings({
      engines: next.length === ENGINES.length ? [] : next,
      fastMode: false,
    });
  };

  const selectAll = () => {
    void updateSettings({ engines: [], fastMode: false });
    toast.success("Selected all 13 engines");
  };

  const selectFast5 = () => {
    void updateSettings({ engines: [], fastMode: true });
    toast.success("Selected Fast 5 core engines");
  };

  const selectHighTrust = () => {
    const high = ENGINES.filter((e) => e.trust >= 2).map((e) => e.id);
    void updateSettings({ engines: high, fastMode: false });
    toast.success(`Selected ${high.length} high-trust engines (trust ≥ 2)`);
  };

  const displayedEngines = ENGINES.filter((engine) => {
    if (!filterQuery.trim()) return true;
    const q = filterQuery.toLowerCase().trim();
    return (
      engine.name.toLowerCase().includes(q) ||
      engine.id.toLowerCase().includes(q) ||
      engine.note.toLowerCase().includes(q)
    );
  });

  return (
    <AppShell heading="Onion search engines and circuit state">
      <Panel
        title={`${allOn ? ENGINES.length : settings.engines.length} of ${ENGINES.length} selected`}
        action={
          <button
            type="button"
            aria-label="Reset circuit breakers"
            onClick={() => {
              resetBreaker();
              setTick((value) => value + 1);
              toast.info("Circuit breakers reset");
            }}
            className="tap min-h-11 px-1 text-dim hover:text-amber"
          >
            <RotateCcw className="size-4" />
          </button>
        }
      >
        <div className="space-y-2 border-b border-border-subtle p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={selectAll}
              className={`tap rounded-md px-2.5 py-1 text-xs font-mono transition-colors ${
                allOn ? "bg-amber/30 text-amber font-semibold" : "bg-panel text-dim hover:text-foreground"
              }`}
            >
              all 13
            </button>
            <button
              type="button"
              onClick={selectFast5}
              className={`tap rounded-md px-2.5 py-1 text-xs font-mono transition-colors ${
                settings.fastMode ? "bg-amber/30 text-amber font-semibold" : "bg-panel text-dim hover:text-foreground"
              }`}
            >
              fast 5 core
            </button>
            <button
              type="button"
              onClick={selectHighTrust}
              className="tap rounded-md bg-panel px-2.5 py-1 text-xs font-mono text-dim transition-colors hover:text-foreground"
            >
              trust ≥ 2
            </button>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-dim" />
            <input
              type="search"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="filter engines by name or id…"
              className="w-full rounded-md border border-border-subtle bg-elevated/70 py-1.5 pl-8 pr-8 font-mono text-xs text-foreground placeholder:text-dim focus:border-amber/60 focus:outline-none"
            />
            {filterQuery.length > 0 && (
              <button
                type="button"
                onClick={() => setFilterQuery("")}
                className="tap absolute right-2.5 top-1/2 -translate-y-1/2 text-dim hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>
        <ul className="divide-y divide-border-subtle" key={tick}>
          {displayedEngines.map((engine) => {
            const open = isOpen(engine.id);
            const deprecated = isDeprecated(engine.id);
            const tier = engineTier(engine.id);
            const trend = getHealthTrend(engine.id);
            const signal: Signal = open || deprecated ? "red" : active(engine.id) ? "green" : "dim";
            const cooldown = open
              ? `${Math.max(0, Math.ceil((openUntil(engine.id) - Date.now()) / 1000))}s cooldown`
              : undefined;
            return (
              <li key={engine.id} className="space-y-1.5 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Dot signal={signal} pulse={!open && !deprecated} />
                  <button
                    type="button"
                    onClick={() => toggle(engine.id)}
                    className="tap min-h-11 flex-1 text-left"
                    aria-pressed={active(engine.id)}
                  >
                    <span className="text-sm text-foreground">{engine.name}</span>
                    <span className="ml-2 font-mono text-[10px] uppercase tracking-widest text-dim">
                      trust {engine.trust} · {tier}
                    </span>
                  </button>
                  {deprecated && (
                    <Chip
                      signal="amber"
                      onClick={() => {
                        undeprecate(engine.id);
                        setTick((value) => value + 1);
                      }}
                    >
                      undeprecate
                    </Chip>
                  )}
                  <Chip active={active(engine.id)} onClick={() => toggle(engine.id)}>
                    {active(engine.id) ? "on" : "off"}
                  </Chip>
                </div>
                <p className="break-all font-mono text-[11px] text-amber/70">
                  {originOf(engine.searchUrl("probe", 1))}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <MicroLabel>{engine.clearnet ? "clearnet + tor" : "onion only"}</MicroLabel>
                  {engine.queryContract?.maxQueryLength && (
                    <MicroLabel className="text-dim">
                      max {engine.queryContract.maxQueryLength}c/
                      {engine.queryContract.maxTerms ?? "∞"}w
                    </MicroLabel>
                  )}
                  {trend.eventCount > 0 && (
                    <MicroLabel className="text-amber/80">
                      {Math.round(trend.okRate * 100)}% ok ({trend.eventCount})
                    </MicroLabel>
                  )}
                  <MicroLabel className="text-dim">{engine.note}</MicroLabel>
                  {cooldown && <MicroLabel className="text-signal-red">{cooldown}</MicroLabel>}
                  {deprecated && (
                    <MicroLabel className="text-signal-red">deprecated (3x timeout)</MicroLabel>
                  )}
                  {lastError(engine.id) && (
                    <MicroLabel className="text-dim">{lastError(engine.id)}</MicroLabel>
                  )}
                  <Chip
                    onClick={() => void openExternal(originOf(engine.searchUrl("probe", 1)))}
                    className="ml-auto"
                  >
                    open in tor
                  </Chip>
                </div>
              </li>
            );
          })}
          {displayedEngines.length === 0 && (
            <li className="px-3 py-6 text-center">
              <p className="font-mono text-xs text-dim">No engines match "{filterQuery}"</p>
              <button
                type="button"
                onClick={() => setFilterQuery("")}
                className="tap mt-2 rounded bg-panel px-2.5 py-1 font-mono text-xs text-amber"
              >
                clear filter
              </button>
            </li>
          )}
        </ul>
      </Panel>

      <Panel title="how v3 ranking works">
        <div className="space-y-2 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
          <p>
            Every selected engine is queried in parallel with per-engine SOCKS5 stream isolation and
            query-contract adaptation. Results are fused via trust-weighted Reciprocal Rank Fusion
            (RRF k=10) and refined by SimHash near-duplicate and mirror demotion.
          </p>
          <p>
            Three consecutive failures open a five-minute cooldown; three consecutive timeouts mark
            an engine as deprecated for the session until manually re-enabled.
          </p>
        </div>
      </Panel>

      {ENGINES.length === 0 && <EmptyState title="No engines registered" />}

      <RegistryImportPanel onChanged={() => setTick((t) => t + 1)} />
    </AppShell>
  );
}

type ImportAnalysis = {
  registry: unknown;
  /** Inputs captured at analyze time — apply() must NOT re-read textareas,
   *  otherwise edits between analyze and apply would change what gets signed. */
  sigText: string;
  candidatePem: string | null;
  verify:
    | { ok: true; verifiedBy: string; fingerprint: string | null }
    | { ok: false; reason: string; needsFingerprintConfirm: boolean };
  diff: RegistryDiff;
};

/**
 * B16 — bring your own signed registry. Fail-closed: an import applies only
 * when its detached signature verifies under the APK anchor or an
 * operator-confirmed key (fingerprint confirm, SSH-known_hosts style). The
 * import persists in preferences, separate from the bundled asset; deleting
 * it falls back to the bundled registry.
 */
function RegistryImportPanel({ onChanged }: { onChanged: () => void }) {
  const [registryText, setRegistryText] = useState("");
  const [sigText, setSigText] = useState("");
  const [keyPem, setKeyPem] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeImport, setActiveImport] = useState<{
    importedAt: number;
    fingerprint: string | null;
  } | null>(null);
  const [tick, setLocalTick] = useState(0);

  useEffect(() => {
    void loadImportedRegistry().then((stored) => {
      setActiveImport(
        stored
          ? { importedAt: stored.importedAt, fingerprint: stored.verifiedByFingerprint }
          : null,
      );
    });
  }, [tick]);

  const analyze = async () => {
    setError(null);
    setAnalysis(null);
    try {
      // Size caps before parsing — `health` and unknown extra keys are
      // otherwise unbounded and would persist + re-verify every boot (R6).
      if (registryText.length > MAX_IMPORT_BYTES)
        throw new Error(`registry exceeds ${MAX_IMPORT_BYTES} bytes`);
      if (sigText.length > MAX_IMPORT_SIG_BYTES)
        throw new Error(`signature file exceeds ${MAX_IMPORT_SIG_BYTES} bytes`);
      let registry: unknown;
      try {
        registry = JSON.parse(registryText);
      } catch {
        throw new Error("registry is not valid JSON");
      }
      validateEngineRegistry(registry);
      const anchor = await readRegistryAnchor().catch(() => null);
      const trusted = (await loadTrustedKeys()).map((key) => base64ToSpkiBytes(key.spkiBase64));
      const candidate = keyPem.trim().length > 0 ? keyPem.trim() : undefined;
      const verify = await verifyRegistryImport({
        registry,
        sigText,
        trustedSpkis: trusted,
        anchorSpki: anchor?.spkiBase64 ? base64ToSpkiBytes(anchor.spkiBase64) : null,
        anchorCertSha256: anchor?.certSha256,
        candidatePem: candidate,
        confirmCandidateKey: confirmed,
      });
      const diff = diffRegistries(activeRegistry(), registry);
      setAnalysis({
        registry,
        sigText,
        candidatePem: candidate ?? null,
        verify: verify.ok
          ? { ok: true, verifiedBy: verify.verifiedBy, fingerprint: verify.fingerprint }
          : {
              ok: false,
              reason: verify.reason,
              needsFingerprintConfirm: Boolean(candidate) && !confirmed,
            },
        diff,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "analysis failed");
    }
  };

  const apply = async () => {
    if (!analysis?.verify.ok) return;
    // The sequence gate ran at analyze time — re-check it now: another import
    // applied in between could have raised the floor since (R7).
    const staleFloor = sequenceFloorViolation(analysis.registry);
    if (staleFloor) {
      toast.error(staleFloor);
      return;
    }
    // Trust can change between analyze and apply — a revoked key leaves a
    // stale "verified" in analysis. Re-verify the pinned content under the
    // live key set before applying (F2).
    const anchor = await readRegistryAnchor().catch(() => null);
    const trusted = (await loadTrustedKeys()).map((key) => base64ToSpkiBytes(key.spkiBase64));
    const recheck = await verifyRegistryImport({
      registry: analysis.registry,
      sigText: analysis.sigText,
      trustedSpkis: trusted,
      anchorSpki: anchor?.spkiBase64 ? base64ToSpkiBytes(anchor.spkiBase64) : null,
      anchorCertSha256: anchor?.certSha256,
      candidatePem: analysis.candidatePem ?? undefined,
      confirmCandidateKey: analysis.verify.verifiedBy === "candidate",
    });
    if (!recheck.ok) {
      toast.error(`trust changed since analysis — ${recheck.reason}`);
      return;
    }
    setBusy(true);
    const previousRegistry = isImportedRegistryActive() ? activeRegistry() : null;
    let applied = false;
    try {
      // Apply first — persist only what actually activated (a build failure
      // inside applyImportedRegistry must not leave a stored "active" import).
      applyImportedRegistry(analysis.registry);
      applied = true;
      // A provided key is trusted ONLY when verification succeeded under that
      // exact candidate — never when the anchor (or another key) happened to
      // verify. Otherwise a foreign key could ride on an anchor-signed import.
      if (analysis.verify.verifiedBy === "candidate" && analysis.candidatePem) {
        const spki = pemToSpkiBytes(analysis.candidatePem);
        await saveTrustedKey({
          fingerprint: await spkiFingerprint(spki),
          spkiBase64: spkiToBase64(spki),
          confirmedAt: Date.now(),
        });
      }
      await saveImportedRegistry({
        registry: analysis.registry,
        sigText: analysis.sigText,
        verifiedByFingerprint: recheck.fingerprint,
        importedAt: Date.now(),
      });
      resetRegistryVerification();
      toast.success("Imported registry active — verified signature");
      setAnalysis(null);
      setRegistryText("");
      setSigText("");
      setKeyPem("");
      setConfirmed(false);
      setLocalTick((t) => t + 1);
      onChanged();
    } catch (err) {
      // Persist failed after a successful runtime apply — roll the runtime
      // back to whatever was active before, so "active" and "stored" cannot
      // disagree (audit F6 note).
      if (applied) {
        try {
          if (previousRegistry !== null) applyImportedRegistry(previousRegistry);
          else resetToBundledRegistry();
        } catch {
          resetToBundledRegistry();
        }
        resetRegistryVerification();
      }
      toast.error(err instanceof Error ? err.message : "apply failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    await clearImportedRegistry();
    resetToBundledRegistry();
    resetRegistryVerification();
    // The chain-status singleton can still carry the import era's verdict —
    // recompute it against the bundled lineage now (F6).
    void refreshRegistryChainStatus(bundledRegistry()).catch(() => {});
    toast.info("Import removed — bundled registry active");
    setLocalTick((t) => t + 1);
    onChanged();
  };

  return (
    <Panel
      title={
        activeImport
          ? `registry import · IMPORT ACTIVE (since ${new Date(activeImport.importedAt).toLocaleString()})`
          : "registry import · bundled registry active"
      }
    >
      <div className="space-y-2 p-3">
        {activeImport && (
          <div className="flex items-center justify-between gap-2 rounded border border-amber/40 bg-amber/5 px-2 py-1.5">
            <span className="break-all font-mono text-[10px] text-amber">
              signer {activeImport.fingerprint ? `${activeImport.fingerprint.slice(0, 16)}…` : "?"}
            </span>
            <ActionButton variant="danger" onClick={() => void remove()} className="text-[10px]">
              remove import
            </ActionButton>
          </div>
        )}

        <textarea
          value={registryText}
          onChange={(e) => setRegistryText(e.target.value)}
          rows={3}
          placeholder="paste engines.json (the registry to import)"
          className="w-full rounded-md border border-border-subtle bg-elevated/70 px-2 py-1.5 font-mono text-[10px] text-foreground placeholder:text-dim focus:border-amber/60 focus:outline-none"
        />
        <textarea
          value={sigText}
          onChange={(e) => setSigText(e.target.value)}
          rows={2}
          placeholder="paste engines.sig.json (detached signature)"
          className="w-full rounded-md border border-border-subtle bg-elevated/70 px-2 py-1.5 font-mono text-[10px] text-foreground placeholder:text-dim focus:border-amber/60 focus:outline-none"
        />
        <textarea
          value={keyPem}
          onChange={(e) => setKeyPem(e.target.value)}
          rows={2}
          placeholder="optional: signer public key (SPKI PEM) for a NEW trusted signer"
          className="w-full rounded-md border border-border-subtle bg-elevated/70 px-2 py-1.5 font-mono text-[10px] text-foreground placeholder:text-dim focus:border-amber/60 focus:outline-none"
        />

        {keyPem.trim().length > 0 && (
          <label className="flex items-start gap-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5"
            />
            I verified this key's fingerprint out-of-band (SECURITY.md / release notes) — trust it
            like a known_hosts entry. Unverified keys never apply.
          </label>
        )}

        <ActionButton onClick={() => void analyze()} className="w-full text-[11px]">
          analyze import
        </ActionButton>

        {error && (
          <p className="rounded border border-signal-red/50 bg-signal-red/5 px-2 py-1.5 font-mono text-[10px] text-signal-red">
            {error}
          </p>
        )}

        {analysis && (
          <div className="space-y-1.5 rounded border border-border-subtle bg-elevated/40 p-2">
            {analysis.verify.ok ? (
              <p className="font-mono text-[10px] text-signal-green">
                signature ✓ under {analysis.verify.verifiedBy} · signer{" "}
                {analysis.verify.fingerprint ? `${analysis.verify.fingerprint.slice(0, 16)}…` : "?"}{" "}
                · seq {registrySequence(analysis.registry) ?? "—"}
              </p>
            ) : (
              <p className="font-mono text-[10px] text-signal-red">{analysis.verify.reason}</p>
            )}
            {analysis.verify.ok &&
              analysis.candidatePem &&
              analysis.verify.verifiedBy !== "candidate" && (
                <p className="font-mono text-[10px] text-amber">
                  provided key was not needed for verification — it will NOT be added to trusted
                  keys
                </p>
              )}
            {analysis.verify.ok && analysis.verify.verifiedBy === "candidate" && (
              <p className="font-mono text-[10px] text-amber">
                verified under the NEW signer — its fingerprint will be added to trusted keys on
                apply
              </p>
            )}
            <div className="font-mono text-[10px] text-dim">
              diff vs active registry — added {analysis.diff.added.length} · removed{" "}
              {analysis.diff.removed.length} · changed {analysis.diff.changed.length}
            </div>
            {analysis.diff.added.length > 0 && (
              <ul className="space-y-0.5">
                {analysis.diff.added.map((e) => (
                  <li key={e.id} className="font-mono text-[9px] text-signal-green">
                    + {e.id} ({e.name})
                  </li>
                ))}
              </ul>
            )}
            {analysis.diff.removed.length > 0 && (
              <ul className="space-y-0.5">
                {analysis.diff.removed.map((e) => (
                  <li key={e.id} className="font-mono text-[9px] text-signal-red">
                    − {e.id} ({e.name})
                  </li>
                ))}
              </ul>
            )}
            {analysis.diff.changed.length > 0 && (
              <ul className="space-y-0.5">
                {analysis.diff.changed.map((e) => (
                  <li key={e.id} className="font-mono text-[9px] text-amber">
                    ~ {e.id}: {e.fields.join(", ")}
                  </li>
                ))}
              </ul>
            )}
            {analysis.verify.ok && (
              <ActionButton
                variant="primary"
                pending={busy}
                onClick={() => void apply()}
                className="w-full text-[11px]"
              >
                apply imported registry
              </ActionButton>
            )}
          </div>
        )}

        <MicroLabel className="block text-dim">
          fail-closed: applies only with a valid signature under the APK anchor or a confirmed key ·
          import persists in preferences, separate from the bundled asset · deleting it restores the
          bundled registry
        </MicroLabel>
      </div>
    </Panel>
  );
}
