import { createFileRoute } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/app/app-shell";
import {
  ActionButton,
  Chip,
  ConsoleInput,
  EmptyState,
  MicroLabel,
  Panel,
} from "@/components/app/primitives";
import {
  buildCaseFile,
  caseEntityKey,
  mergeCaseFiles,
  parseCaseFile,
  type CaseEntity,
  type CaseFileV1,
  type MergeResult,
} from "@/lib/ghost/case-file";

/** Entity badges as case-file sees them (structural supertype of EntityBadge). */
type CaseBadge = { type: string; value: string; detail?: string };
import { encryptExportBundle } from "@/lib/ghost/crypto-export";
import { openExternal } from "@/lib/ghost/external";
import { stripTrackingParams } from "@/lib/ghost/tracking";
import { isOnion } from "@/lib/ghost/parse";
import { shareFile } from "@/lib/platform/native";
import {
  buildEntityGraph,
  computeForceLayout,
  entityTypeColor,
  hitTest,
  typeCounts,
  type NodeLayout,
} from "@/lib/ghost/graph";
import { entityLabel } from "@/lib/ghost/entities";
import type { EntityType } from "@/lib/ghost/types";
import { useGhost } from "@/lib/store/ghost-context";

/** Entity label for graph nodes (string-typed) with a raw-type fallback. */
function typeLabel(type: string): string {
  return entityLabel(type as EntityType) ?? type;
}

export const Route = createFileRoute("/graph")({
  head: () => ({
    meta: [
      { title: "Graph — Ghost entity explorer" },
      {
        name: "description",
        content:
          "Force-directed map of entities found in this session's results, plus a chronological query timeline. Session RAM only — nothing is stored.",
      },
      { property: "og:title", content: "Graph — Ghost entity explorer" },
      {
        property: "og:description",
        content: "Correlation graph and session timeline, wiped with the session.",
      },
    ],
  }),
  component: GraphScreen,
});

function formatTs(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function GraphScreen() {
  const { searchOutcome, sessionLog, caseEntities, setCaseEntities, registerPurge } = useGhost();
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [pivot, setPivot] = useState<NodeLayout | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 320, height: 340 });
  const layoutRef = useRef<ReturnType<typeof computeForceLayout> | null>(null);

  const graph = useMemo(
    () =>
      buildEntityGraph(
        (searchOutcome?.rows ?? []).map((r) => ({
          url: r.url,
          entities: r.entities ?? [],
        })),
      ),
    [searchOutcome],
  );

  const visibleGraph = useMemo(() => {
    if (hiddenTypes.size === 0) return graph;
    return {
      nodes: graph.nodes.filter((n) => !hiddenTypes.has(n.type)),
      edges: graph.edges.filter(
        (e) =>
          !hiddenTypes.has(graph.nodes.find((n) => n.id === e.a)?.type ?? "") &&
          !hiddenTypes.has(graph.nodes.find((n) => n.id === e.b)?.type ?? ""),
      ),
    };
  }, [graph, hiddenTypes]);

  const layout = useMemo(
    () => computeForceLayout(visibleGraph, { ...canvasSize, seed: 7 }),
    [visibleGraph, canvasSize],
  );
  layoutRef.current = layout;

  /* Purge: clear pivot selection (entity values + URLs live in it) and the
     type-filter labels when the session memory is wiped — the graph
     re-derives empty from the outcome. */
  useEffect(
    () =>
      registerPurge(() => {
        setPivot(null);
        setHiddenTypes(new Set());
      }),
    [registerPurge],
  );

  /* Size the canvas to its container (square-ish) with devicePixelRatio. */
  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const w = Math.max(200, Math.min(560, element.clientWidth));
      setCanvasSize({ width: w, height: Math.round(w * 1.05) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /* Draw the layout — plain 2D canvas, no animation loop (static session map). */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvasSize.width * dpr);
    canvas.height = Math.round(canvasSize.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvasSize.width, canvasSize.height);

    for (const edge of layout.edges) {
      ctx.strokeStyle = `rgba(240, 180, 41, ${Math.min(0.55, 0.12 + edge.weight * 0.14)})`;
      ctx.lineWidth = Math.min(3, 0.6 + edge.weight * 0.5);
      ctx.beginPath();
      ctx.moveTo(edge.a.x, edge.a.y);
      ctx.lineTo(edge.b.x, edge.b.y);
      ctx.stroke();
    }
    for (const node of layout.nodes) {
      const isPivot = pivot?.id === node.id;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
      ctx.fillStyle = entityTypeColor(node.type);
      ctx.globalAlpha = isPivot ? 1 : 0.8;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (isPivot) {
        ctx.strokeStyle = "#f0b429";
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
      // Label hubs only (freq >= 3) so the map stays readable.
      if (node.freq >= 3 || isPivot) {
        ctx.fillStyle = "rgba(226, 232, 240, 0.85)";
        ctx.font = "10px monospace";
        const label = node.value.length > 18 ? `${node.value.slice(0, 15)}…` : node.value;
        ctx.fillText(label, node.x + node.r + 3, node.y + 3);
      }
    }
  }, [layout, pivot, canvasSize]);

  const onTap = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const current = layoutRef.current;
    if (!canvas || !current) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = hitTest(current, x, y);
    setPivot(hit ?? null);
  };

  const open = async (rawUrl: string) => {
    const { url } = stripTrackingParams(rawUrl);
    if (!isOnion(url)) {
      const proceed = window.confirm(
        "This link is NOT an onion address.\n\nIt will open outside Tor in your default browser and expose your real IP address to that site.\n\nOpen anyway?",
      );
      if (!proceed) return;
    }
    const ok = await openExternal(url);
    if (!ok) toast.error("No external handler. Install Tor Browser.");
  };

  const toggleType = (type: string) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
    setPivot(null);
  };

  const hasEntities = graph.nodes.length > 0;

  return (
    <AppShell heading="Ghost — entity graph and session timeline">
      <Panel
        title={`entity graph · ${graph.nodes.length} nodes / ${graph.edges.length} edges`}
        action={
          <MicroLabel className="text-dim">
            {hiddenTypes.size > 0 ? `${hiddenTypes.size} type(s) hidden` : "tap a node to pivot"}
          </MicroLabel>
        }
      >
        <div ref={wrapRef} className="p-2">
          {hasEntities ? (
            <>
              <div className="mb-2 flex flex-wrap gap-1">
                {typeCounts(graph).map(({ type, count }) => (
                  <Chip
                    key={type}
                    active={!hiddenTypes.has(type)}
                    onClick={() => toggleType(type)}
                    className="px-2 py-0.5 text-[10px]"
                  >
                    {typeLabel(type)} · {count}
                  </Chip>
                ))}
              </div>
              <canvas
                ref={canvasRef}
                onPointerDown={onTap}
                style={{
                  width: canvasSize.width,
                  height: canvasSize.height,
                  borderRadius: "var(--radius)",
                }}
                className="touch-none border border-border-subtle bg-elevated/40"
                aria-label="Entity correlation graph — tap nodes to pivot"
                role="img"
              />
              <p className="mt-1 px-1 font-mono text-[9px] leading-relaxed text-dim">
                node size = result frequency · lines = co-occurrence in the same result · session
                RAM only
              </p>
            </>
          ) : (
            <EmptyState
              title="No entity graph yet"
              hint="Run a search first. Entities found in snippets (wallets, PGP, mails, onions) are mapped here for the current outcome — wiped with the session."
            />
          )}
        </div>
      </Panel>

      {pivot && (
        <Panel
          title={`pivot · ${typeLabel(pivot.type)}`}
          action={
            <button
              type="button"
              onClick={() => setPivot(null)}
              aria-label="Dismiss pivot"
              className="tap min-h-11 px-1 text-dim hover:text-signal-red"
            >
              ×
            </button>
          }
        >
          <div className="space-y-1.5 p-3">
            <p className="break-all font-mono text-[11px] text-foreground">{pivot.value}</p>
            {pivot.detail && <MicroLabel className="text-amber">{pivot.detail}</MicroLabel>}
            <MicroLabel>
              in {pivot.freq} result{pivot.freq > 1 ? "s" : ""} this session
            </MicroLabel>
            <ul className="divide-y divide-border-subtle">
              {pivot.urls.map((url) => (
                <li key={url} className="flex items-center gap-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-amber/80">
                    {hostOf(url)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void open(url)}
                    aria-label="Open in Tor Browser"
                    className="tap size-5 shrink-0 text-dim hover:text-foreground"
                  >
                    <ExternalLink className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      )}

      <Panel
        title={`session timeline · ${sessionLog.length} quer${sessionLog.length === 1 ? "y" : "ies"}`}
      >
        {sessionLog.length === 0 ? (
          <div className="p-3">
            <MicroLabel className="text-dim">
              queries this session appear here — RAM only, cleared on purge or screen lock
            </MicroLabel>
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {[...sessionLog]
              .slice()
              .reverse()
              .map((event, i) => (
                <li key={`${event.ts}-${i}`} className="px-3 py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="shrink-0 font-mono text-[10px] text-dim">
                      {formatTs(event.ts)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                      {event.query}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[9px] text-dim">
                    <span>{event.resultCount} results</span>
                    <span>{event.entityCount} entities</span>
                    <span>
                      {event.engines.length > 0 ? event.engines.join("·") : "no engine ok"}
                    </span>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </Panel>

      <CaseFilePanel
        rows={searchOutcome?.rows ?? []}
        caseEntities={caseEntities}
        onMerged={setCaseEntities}
      />

      <div className="px-1">
        <ActionButton
          onClick={() => {
            setPivot(null);
            setHiddenTypes(new Set());
          }}
          className="w-full"
        >
          reset graph filters
        </ActionButton>
      </div>
    </AppShell>
  );
}

/**
 * Case file sneakernet panel — export the session as a `ghost-case-v1`
 * (optionally in the existing encrypted envelope), import an untrusted file,
 * preview the last-write-wins merge, then apply. RAM-only: everything here
 * dies with the session purge, and the import widens the session surface —
 * the panel says both out loud.
 */
function CaseFilePanel({
  rows,
  caseEntities,
  onMerged,
}: {
  rows: Array<{ url: string; entities?: CaseBadge[] | undefined }>;
  caseEntities: CaseEntity[];
  onMerged: (entities: CaseEntity[]) => void;
}) {
  const { registerPurge, getSessionEpoch } = useGhost();
  const [caseName, setCaseName] = useState("session case");
  const [passphrase, setPassphrase] = useState("");
  const [importText, setImportText] = useState("");
  const [preview, setPreview] = useState<{ file: CaseFileV1; merge: MergeResult } | null>(null);
  const [previewEpoch, setPreviewEpoch] = useState<number | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /* Purge: raw case text, passphrase, and a preview holding pre-purge entities
     must not survive the session wipe. */
  useEffect(
    () =>
      registerPurge(() => {
        setCaseName("session case");
        setPassphrase("");
        setImportText("");
        setPreview(null);
        setPreviewEpoch(null);
        setImportError(null);
      }),
    [registerPurge],
  );

  const exportCase = async () => {
    const epoch = getSessionEpoch();
    try {
      const file = buildCaseFile(rows, caseEntities, caseName.trim() || "session case");
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const filename = `ghost-case-${stamp}.json`;
      const json = JSON.stringify(file, null, 2);
      if (passphrase.trim().length >= 8) {
        const encrypted = await encryptExportBundle(json, passphrase);
        // Purged while the KDF ran — a wiped session must not hand its case
        // file to the share sheet (C4).
        if (getSessionEpoch() !== epoch) return;
        await shareFile(
          filename.endsWith(".enc.json") ? filename : `${filename}.enc.json`,
          encrypted,
          `Ghost case — ${file.caseName}`,
        );
        toast.success(`Case exported (${file.entities.length} entities, encrypted)`);
      } else {
        await shareFile(filename, json, `Ghost case — ${file.caseName}`);
        toast.success(`Case exported (${file.entities.length} entities)`);
      }
      // The passphrase has done its job — do not keep it in state (C5).
      setPassphrase("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "export failed");
    }
  };

  const analyze = async () => {
    setImportError(null);
    setPreview(null);
    const epoch = getSessionEpoch();
    try {
      const file = await parseCaseFile(importText, passphrase.trim() || undefined);
      // Purge during the await (PBKDF2 takes noticeable time) — drop the
      // pre-purge work instead of resurrecting wiped entities.
      if (getSessionEpoch() !== epoch) return;
      const merge = mergeCaseFiles(caseEntities, file.entities);
      setPreview({ file, merge });
      setPreviewEpoch(epoch);
    } catch (error) {
      if (getSessionEpoch() !== epoch) return;
      setImportError(error instanceof Error ? error.message : "import failed");
    }
  };

  const applyMerge = () => {
    // Epoch check: a preview built before a purge holds pre-purge entities —
    // applying it would silently resurrect them into the wiped session.
    if (!preview || getSessionEpoch() !== previewEpoch) {
      setPreview(null);
      return;
    }
    onMerged(preview.merge.entities);
    toast.success(
      `Merged: ${preview.merge.report.added} added · ${preview.merge.report.updated} updated · ` +
        `${preview.merge.report.keptLocal} kept local · ${preview.merge.report.conflicts.length} conflict(s)`,
    );
    setPreview(null);
    setImportText("");
  };

  const readFile = async (file: File) => {
    const epoch = getSessionEpoch();
    try {
      const text = await file.text();
      // Purged mid-read — do not refill the wiped field.
      if (getSessionEpoch() !== epoch) return;
      setImportText(text);
    } catch {
      toast.error("could not read file");
    }
  };

  // The entities the merge would ADD — the operator must see the actual
  // values, not just a count, before approving untrusted input (C3).
  const existingKeys = new Set(caseEntities.map(caseEntityKey));
  const addedEntities = preview
    ? preview.merge.entities.filter((entity) => !existingKeys.has(caseEntityKey(entity)))
    : [];

  return (
    <Panel title={`case file · sneakernet merge (${caseEntities.length} entities in RAM)`}>
      <div className="space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <ConsoleInput
            value={caseName}
            onChange={(event) => setCaseName(event.target.value)}
            placeholder="case name"
            className="min-h-9 flex-1 text-xs"
            aria-label="Case name"
          />
          <ConsoleInput
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            placeholder="passphrase (optional)"
            type="password"
            className="min-h-9 flex-1 text-xs"
            aria-label="Passphrase for encrypted export/import"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <ActionButton onClick={() => void exportCase()} className="flex-1 text-[11px]">
            export session case
          </ActionButton>
          <ActionButton
            onClick={() => fileInputRef.current?.click()}
            className="flex-1 text-[11px]"
          >
            pick import file
          </ActionButton>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json,.txt"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) readFile(file);
              event.target.value = "";
            }}
          />
        </div>
        <textarea
          value={importText}
          onChange={(event) => setImportText(event.target.value)}
          placeholder="…or paste a ghost-case JSON / encrypted envelope here"
          rows={3}
          className="w-full rounded-md border border-border-subtle bg-elevated/70 px-2 py-1.5 font-mono text-[10px] text-foreground placeholder:text-dim focus:border-amber/60 focus:outline-none"
          style={{ borderRadius: "var(--radius)" }}
        />
        <div className="flex flex-wrap gap-2">
          <ActionButton onClick={() => void analyze()} className="flex-1 text-[11px]">
            analyze import
          </ActionButton>
          {preview && (
            <ActionButton variant="primary" onClick={applyMerge} className="flex-1 text-[11px]">
              merge now
            </ActionButton>
          )}
        </div>

        {importError && (
          <p className="rounded border border-signal-red/50 bg-signal-red/5 px-2 py-1.5 font-mono text-[10px] text-signal-red">
            {importError}
          </p>
        )}

        {preview && (
          <div className="rounded border border-border-subtle bg-elevated/40 p-2">
            <MicroLabel>
              “{preview.file.caseName}” · exported {formatTs(preview.file.exportedAt)} ·{" "}
              {preview.merge.report.totalIn} entities in file
            </MicroLabel>
            <div className="mt-1 grid grid-cols-2 gap-x-3 font-mono text-[10px] text-dim sm:grid-cols-4">
              <span className="text-signal-green">+{preview.merge.report.added} new</span>
              <span className="text-amber">~{preview.merge.report.updated} updated</span>
              <span className="text-signal-red">= {preview.merge.report.keptLocal} kept local</span>
              <span>{preview.merge.report.unchanged} unchanged</span>
            </div>
            {addedEntities.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 border-t border-border-subtle pt-1.5">
                {addedEntities.slice(0, 10).map((entity) => (
                  <li
                    key={caseEntityKey(entity)}
                    className="break-all font-mono text-[9px] text-signal-green"
                  >
                    + {entity.type}:{entity.value}
                  </li>
                ))}
                {addedEntities.length > 10 && (
                  <li className="font-mono text-[9px] text-dim">
                    … {addedEntities.length - 10} more new entities
                  </li>
                )}
              </ul>
            )}
            {preview.merge.report.conflicts.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 border-t border-border-subtle pt-1.5">
                {preview.merge.report.conflicts.slice(0, 10).map((conflict) => (
                  <li key={conflict.key} className="break-all font-mono text-[9px] text-dim">
                    ⚠ {conflict.key} — winner: {conflict.winner} (local{" "}
                    {formatTs(conflict.localUpdatedAt)} vs import{" "}
                    {formatTs(conflict.importedUpdatedAt)})
                  </li>
                ))}
                {preview.merge.report.conflicts.length > 10 && (
                  <li className="font-mono text-[9px] text-dim">
                    … {preview.merge.report.conflicts.length - 10} more conflicts
                  </li>
                )}
              </ul>
            )}
            <MicroLabel className="mt-1.5 block text-dim">
              last-write-wins on entity timestamps · result: {preview.merge.report.totalOut}{" "}
              entities after merge
            </MicroLabel>
          </div>
        )}

        {caseEntities.length > 0 && (
          <ul className="divide-y divide-border-subtle border-t border-border-subtle">
            {caseEntities.slice(0, 30).map((entity) => (
              <li key={caseEntityKey(entity)} className="flex items-baseline gap-2 py-1">
                <span className="shrink-0 font-mono text-[9px] uppercase text-amber/80">
                  {entity.type}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground">
                  {entity.value}
                </span>
                <span className="shrink-0 font-mono text-[9px] text-dim">
                  {entity.urls.length} url{entity.urls.length === 1 ? "" : "s"}
                </span>
              </li>
            ))}
            {caseEntities.length > 30 && (
              <li className="py-1 font-mono text-[9px] text-dim">
                … {caseEntities.length - 30} more
              </li>
            )}
          </ul>
        )}

        <MicroLabel className="block text-dim">
          import widens this session's RAM surface — everything here dies on purge or screen lock;
          there is no on-device case storage
        </MicroLabel>
      </div>
    </Panel>
  );
}
