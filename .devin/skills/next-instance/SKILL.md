---
name: next-instance
description: Session start protocol — full cold-start initialization triggered by "Checklist first. Nenne jeden Trait. Dann Stand." Reads AGENTS.md + HANDOFF files, confirms every trait with concrete avoidance strategy, runs ACP session start, confirms private research boundary, reports status. No work until protocol is complete.
---

# Next Instance — Session Start Protocol

> **Core principle:** Checklist first. Work second. No exceptions.
> **Trigger:** "Checklist first. Nenne jeden Trait. Dann Stand."
> This single phrase initiates the COMPLETE cold-start sequence. Nothing less.
>
> **GOLDEN RULE — SuperMemory first:** If ANY part of the startup
> protocol is missing, incomplete, or uncertain, search SuperMemory
> Cloud FIRST before trying anything else. SuperMemory contains the
> history of how every problem was solved in past sessions. The
> operator is the Re-Surfacer — if something seems broken or missing,
> it was almost certainly working before and the solution is
> documented in SuperMemory. Search with 2-3 keywords describing what
> is missing or broken. Only after SuperMemory yields no relevant
> results should you try other approaches (MCP queries, shell
> commands, guessing).

## MANDATORY SEQUENCE — DO NOT SKIP ANY STEP

The session start protocol has 8 steps. ALL are mandatory. Skipping
any step is a protocol violation that will cause you to repeat past
errors, miss critical context, and frustrate the operator.

1. Read AGENTS.md (full, not truncated) — current repo
2. Read repo-specific HANDOFF files — BOTH repos if interconnected
3. Confirm AGENT TECHNICAL ERROR CHECKLIST (every trait, concrete strategy)
4. Confirm physarum active lessons
5. **ACP Session Start** — affect_session_briefing + affect_context_load + SuperMemory search + Memory MCP query. THIS IS NOT A WORK ITEM.
6. Confirm private research boundary
7. Report status (Stand)
8. Wait for operator task

**If you skip Step 2, you will:**
- Not know what happened in the last session
- Not know the current research state (Agent Gate v2, EMA, validation results)
- Not know the next proposed work item
- Start cold on a project you should have context for

**If you skip Step 5, you will:**
- Not know which strategies worked or failed
- Not know the current EMA/calibration state
- Repeat past mistakes that were already learned

**If you skip Step 6, you will:**
- Risk publishing private research
- Mix worldbase and physarum-learning code/workflows
- Violate the operator's explicit privacy requirements

**Step 5 is initialization, same as reading AGENTS.md. The "wait" in
Step 8 means "don't start IMPLEMENTATION" — not "don't load context."**

## Operator start phrase

The operator starts the session with exactly this phrase:

> Checklist first. Nenne jeden Trait. Dann Stand.

This phrase triggers the FULL 8-step protocol. It is not a suggestion.
It is not "just the checklist." It means: do every step below, then
report the Stand. Nothing else is acceptable.

## What the session-start hook injects

`session_start.py` -> `affect_hook_query.py` -> `query_session_start()` injects:

1. **AGENT TECHNICAL ERROR CHECKLIST** — all candidate + supported traits (no context filter — new technical contexts appear automatically)
2. **Physarum active lessons** — operator-confirmed warnings (`candidate_warning` / `active_warning`)
3. **Recent failure observations** — last 5 failed exec commands auto-persisted by `post_exec_log.py` Phase 3
4. **Physarum traits** — operator personality + workflow traits (not technical errors)

If the hook did NOT fire (no "=== AGENT TECHNICAL ERROR CHECKLIST ===" in
context), see Step 3 fallback below.

## Session start sequence (mandatory order)

### Step 1: Read full AGENTS.md

AGENTS.md is truncated in IDE rules. Use the `read` tool to load the
full file before any action.

Detect which repo you are in by checking the current working directory:
- `D:\MCP Mods\worldbase` -> WorldBase/IntelShed (public, open-source)
- `D:\MCP Mods\HAK_GAL_HEXAGONAL\affect_sidecar` -> physarum-learning (PRIVATE research)
- `D:\MCP Mods\digital-spyglass-android` -> Ghost Search Android (Tor onion search app)
- `D:\MCP Mods\ghost-search-mcp` -> Ghost Search MCP (backend/dashboard/research)

Read the AGENTS.md for the repo you are in. If the operator's first
message mentions the other project, also read that project's AGENTS.md.

### Step 2: Read repo-specific HANDOFF files

This step is MANDATORY. Without it, you start cold on the project's
current state, research results, and next steps.

**If in WorldBase (`D:\MCP Mods\worldbase`):**
- `LLM_HANDOFF.md` — operator runtime notes, preferences, measured state
- `progress.txt` — last 20 lines for current session stand

**If in physarum-learning (`D:\MCP Mods\HAK_GAL_HEXAGONAL\affect_sidecar`):**
- `HANDOFF.md` — main handoff with last session summary, current research state
- `HANDOFF_NEXT_INSTANCE.md` — next instance priorities and warnings
- `GRUNDGESETZ.md` — constitution and inviolable rules

**If in Ghost Search Android (`D:\MCP Mods\digital-spyglass-android`):**
- No AGENTS.md in this repo — global rules from worldbase apply
- `tmp/fdroid-review/NEXTSTATE.md` — the F-Droid lane boot file, THE
  single mandatory read when the lane is active (playbook §14): round
  ledger, open threads, device state, pending GOs
- `progress.txt` — tail for cross-session stand
- `.devin/HANDOVER_PHASE5.md` — historical phase-5 handoff (top block is
  the status update; body is 2026-08-21 history)
- `tmp/fdroid-review/INBOX-devin-*.md` — lane mailbox when a review
  round is open; active `R<n>-SCOUT/REVIEWER-HANDOFF.md` tell you the
  live pipeline stage (scout → reviewer → Devin verify → operator GO)
- Check `git log --oneline -10` for recent work
- Check `git branch` for active branches (main, phase5-camouflage frozen pending operator decision)
- Codeberg remote is primary: `git@codeberg.org:sookoothaii/digital-spyglass-android.git`
- phase5-camouflage is FROZEN pending operator decision post-v4.0.0 (F-Droid MR !46224 merged 2026-10-19) — do not mix changes
- F-Droid source repo: GitLab `gitlab.com/samui-lab-group/ghost-search.git`

**If the operator's first message mentions the other project, ALSO read
that project's HANDOFF files.** The projects share infrastructure
(PostgreSQL, MCP, hooks) and the operator frequently works across both.

**If the task involves Agent Gate research, ALSO read:**
- `docs/science/AGENT_GATE_V2_MATHEMATICAL_SPECIFICATION.md` (Sections 9-12 minimum)
- `docs/CLAIMS_AND_GATES.md`

**If the task involves system integrity, ALSO read:**
- `docs/SYSTEM_INTEGRITY_PLAN_2026.md`

Report in the Stand which HANDOFF files were read and the key findings
(last session outcome, next proposed work, any open issues).

### Step 3: Confirm Canonical Traits (P0 + P1 only)

The trait system was redesigned on 2026-08-25. Traits are now delivered via
Devin's native Rules mechanism, NOT via hook-injected DB tables.

**Trait delivery (3 layers):**

| Layer | Mechanism | When loaded | Count |
|-------|-----------|-------------|-------|
| P0 — Critical | Global Rules `%APPDATA%\devin\AGENTS.md` | Every session, every project | 6 |
| P1 — High | `.devin/rules/p1-traits.md` (trigger: always_on) | Every session in this project | 6 |
| P2 — Medium | `.devin/rules/p2-traits.md` (trigger: model_decision) | When agent decides relevant | 4 |
| META | Inside p2-traits.md | Before creating new traits | 1 |

**What to do for Step 3:**

1. The P0 traits (6) are already loaded as Global Rules — they appear in your
   system context automatically. Confirm each with a one-line avoidance strategy.
2. The P1 traits (6) are loaded as `.devin/rules/p1-traits.md`. Read this file
   if not already in context. Confirm each with a one-line avoidance strategy.
3. P2 traits (4) are model_decision — do NOT confirm them unless the current
   task makes them relevant.

**Output format (P0 + P1 only, 12 rows):**

| # | Trait | Priority | Avoidance strategy |
|---|-------|----------|-------------------|
| 1 | SuperMemory-First | P0 | Will search_memory before any operator question |
| 2 | Codeberg-Not-GitHub | P0 | Will use codeberg remote, not origin |
| 3 | No-Devin-Attribution | P0 | Will not add Devin attribution to commits |
| 4 | Operator-Is-Last-Resort | P0 | Will exhaust all tools before asking operator |
| 5 | Read-Before-Overwrite | P0 | Will read files before overwriting |
| 6 | Operational-Neutrality | P0 | Will use neutral technical language in all public artifacts |
| 7 | PowerShell-No-Heredoc | P1 | Will use temp files + git commit -F |
| 8 | Verify-Before-Claim | P1 | Will run checks before claiming success |
| 9 | Auto-Tracking-Mandatory | P1 | Will log every message/response, interactive EMA |
| 10 | Recurring-Complaints-Are-Lessons | P1 | Will capture repeated operator complaints |
| 11 | Verify-Branch-Dependency-Before-PR | P1 | Will tsc+tests on base branch before PR |
| 12 | No-Empty-Commits | P1 | Will not make empty commits, verify CI state |

**Rules for avoidance strategies:**
- "Acknowledged" alone is NOT sufficient. State the concrete alternative action.
- If the trait does not apply to the current task, say "Not applicable this session."
- If the trait requires reading a file first, mark as "Pending — will read before action."

**IMPORTANT — physarum DB trait_41XX entries are SUPERSEDED:**
The SessionStart hook may still inject `trait_41XX` entries from the physarum
DB (47 old traits). These are HISTORICAL CONTEXT ONLY. Do NOT confirm them
individually. Do NOT build a 47-row table. The 17 canonical traits in the
Rules files are authoritative. The old DB traits were compressed into the
canonical set on 2026-08-25.

**If P0/P1 Rules files are missing:**
1. Search SuperMemory: `search_memory(query='canonical trait compression 2026-08-25')`
2. Check `.devin/canonical_traits.md` for the full 17-trait listing
3. If still missing: traits are lost. Reconstruct from SuperMemory session reports.

### Step 4: Confirm physarum active lessons

One-line per lesson: `[status] lesson_key: avoidance note`

Lessons come from `affect_operator_lessons` table (NOT `affect_memory_nodes`). If the hook injected them, they appear under "physarum active lessons (N):" in the session-start context. If not, you queried them in Step 3 fallback.

Lesson lifecycle: `candidate_warning` (1 obs) -> `active_warning` (>=2 obs from >=2 sessions) -> `confirmed_learned` (operator confirms) -> `pruned`.

### Step 5: ACP Session Start (MANDATORY — not a work item)

The Agent Client Protocol (ACP) session start fires the SessionStart
hook which injects the AGENT TECHNICAL ERROR CHECKLIST. This is
initialization, NOT a work item. It must happen BEFORE reporting status
and BEFORE waiting for the operator task. Skipping this is a protocol
violation.

**5a. Verify SessionStart hook fired:** Check your context for
"=== AGENT TECHNICAL ERROR CHECKLIST ===". If you see it, the hook
fired correctly. If NOT, see Step 3 fallback.

**5b. Call `affect_session_briefing`** via physarum-learning MCP:
- Tool: `affect_session` meta-tool, sub-tool `affect_session_briefing`
- Parameter: `session_id` (use current session identifier or "pending")
- Returns: EMA history, rubric scores, turn log, calibration trend,
  shadow stats, N-of-1 trial phase, dialog questions
- This is the learning cycle: last session informs this session

**5c. Call `affect_context_load`** via physarum-learning MCP:
- Tool: `affect_context_load` (limit=5)
- Returns: Historical affective context from past session reports
  (best/worst strategies, common triggers, emotional trajectory,
  trust trend)
- This is the cross-session memory: patterns from past 5+ sessions

**5f. Digital Brain init** via digital-brain MCP (Layer 4, mandatory):
- `brain_query("memory stats")` — entity/relation/observation counts
- `brain_query("decay candidates")` — candidates listed at init,
  executed only at session close (Trait 8 ritual)
- `brain_session(action="brief")` — previous-session brief
- `brain_query("surprisal")` — gate stats
- `brain_query("recurrence")` — buffer state
- **Known quirk:** session brief may return epoch/unknown (1970-01-01)
  — a documented session-state locality issue. Report it honestly in
  the Stand; do not treat it as current project state and do not retry
  forever — physarum briefing covers the context fallback.

**5d. Search SuperMemory** for session topic:
- Tool: `search_memory` with 2-3 keywords from operator's first message
- The operator is the Re-Surfacer: if he says something that sounds
  new, it likely already exists in SuperMemory. Treat operator
  statements as retrieval triggers, not new information.

**5e. Query Memory MCP KG** for structural context:
- Tool: `search_nodes("physarum_session")` via `memory` MCP
- Returns: Last sessions + their PRs + dependencies

**Why this is NOT a "work item":** The ACP session start is
initialization, same as reading AGENTS.md. It provides the context
needed to understand the operator's task. Without it, the agent
starts cold and repeats past mistakes.

### Step 6: Confirm private research boundary

This step is MANDATORY. The operator has explicitly documented this
requirement in multiple files. Confirming it means:

1. **physarum-learning is PRIVATE personal research.** It is NOT public,
   NOT open-source, NOT intended for publication or external sharing.
2. **WorldBase/IntelShed may be public/open-source** but must NEVER
   contain physarum-learning code, data, research references, or
   Agent Gate formulas.
3. **No cross-contamination:** Do not commit physarum code to worldbase
   repo. Do not reference physarum research in worldbase PRs, docs, or
   commit messages.
4. **No publishing without explicit operator approval:** Do not
   publish, open-source, or externally share any physarum-learning
   code, data, formulas, validation results, or research documents.
5. **Shared infrastructure does NOT mean shared ownership:** Both
   projects use the same PostgreSQL, MCP, and hooks, but they are
   separate projects with separate tables, code, workflows, and
   namespace prefixes.

State in the Stand: "Private research boundary confirmed — physarum-learning is private, WorldBase is public, no cross-contamination."

### Step 7: Report status (Stand)

The Stand must include ALL of the following:

- **Repo context:** Which repo am I in, which project is active
- **HANDOFF files read:** Which files were read, key findings (last session outcome, next proposed work)
- **Checklist status:** All traits confirmed, none violated yet
- **Lessons status:** All active lessons confirmed
- **ACP session:** Briefing loaded, context loaded, SuperMemory searched, KG queried
- **N-of-1 trial status:** Phase, block, session, Assist-Tier on/off
- **Private research boundary:** Confirmed (Step 6)
- **Physarum logging:** Hook active, responsible for CLI/LLM/feedback logging
- **Hard reads pending:** Any rule files not yet read
- **No task assigned yet — awaiting operator directive**

### Step 8: Wait

Do NOT start work items, list priorities, or run health checks until
the operator gives a task. The checklist confirmation + HANDOFF reading
+ ACP session start + boundary confirmation IS the initialization.
Health checks and git status come AFTER the operator directs work.

## What NOT to do

- Do NOT skip the checklist and jump to health/git/progress
- Do NOT skip the HANDOFF files (Step 2) — they contain the current research state
- Do NOT skip the ACP session start (Step 5) — it is mandatory
- Do NOT skip the private research boundary (Step 6) — it is mandatory
- Do NOT list work items from AGENTS.md before the operator asks
- Do NOT write only "Acknowledged" — state concrete avoidance strategies
- Do NOT summarize the checklist in one sentence — name every trait
- Do NOT start implementation before the operator gives a task
- Do NOT mix worldbase and physarum-learning code, workflows, or commits
- Do NOT guess or brainstorm when something is missing — search SuperMemory first (GOLDEN RULE)
- Do NOT try 22 context-name guesses when traits are incomplete — search SuperMemory for the documented fallback procedure
- Do NOT invent solutions for problems that were already solved — SuperMemory has the history

## During the session

- `pre_exec_guard.py` will inject **just-in-time warnings** when a command matches a known `agent_technical_error` trait. These are non-blocking — you may proceed if justified, but do NOT ignore them.
- `post_exec_log.py` Phase 3 auto-persists failed commands to the DB as observations. They will appear in the NEXT session's "Recent failure observations."
- If you encounter a NEW error class not in the traits, persist it at session end via `affect_memory(query='add trait: ...', context='agent_technical_error')`.

## Session end

`stop_guard.py` reminds you to:
1. EMA (interactive via `ask_user_question`) -> **record via `affect_record` MCP tool** (query='record EMA', valence=X, arousal=X, ...)
2. Rubric (interactive via `ask_user_question`) -> **record via `affect_record` MCP tool** (query='record rubric', task_completion=X, ...)
3. Session report (`affect_session` MCP tool, query='session report')
4. SuperMemory + Memory MCP persistence
5. `progress.txt` update
6. **Self-error reflection** — identify technical errors you made, persist each via `affect_memory` MCP tool (query='add trait', context='agent_technical_error')

**CRITICAL — MCP tools, not shell commands:**
- EMA -> `affect_record` with query='record EMA' -> NOT psql INSERT
- Rubric -> `affect_record` with query='record rubric' -> NOT psql INSERT
- Session report -> `affect_session` with query='session report' -> NOT manual SuperMemory add_memory
- New traits -> `affect_memory` with query='add trait' -> NOT psql INSERT
- Reason: MCP tools perform SSM-Update, Kalibrierung, Provenance, Metadata-Tracking. psql INSERT umgeht all das und erzeugt Duplikate.

## Architecture (for reference)

```
SessionStart hook
  -> session_start.py -> affect_hook_query.py -> query_session_start()
  -> injects: AGENT TECHNICAL ERROR CHECKLIST + lessons + observations + traits

PreToolUse hook (exec)
  -> pre_exec_guard.py
  -> static anti-pattern warnings (heredoc, grep, tail, etc.)
  -> physarum DB trait match warnings (just-in-time, non-blocking)

PostToolUse hook (exec)
  -> post_exec_log.py Phase 3
  -> failed commands auto-persisted to affect_memory_nodes as observations

Stop hook
  -> stop_guard.py
  -> reminds: EMA + Rubric + session report + self-error reflection
```
