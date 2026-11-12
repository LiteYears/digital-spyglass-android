---
name: roadmap-session
description: WorldBase roadmap session strategy — how to load context and pick the next task
---

## WorldBase Roadmap Session Strategy

### Step 1: Load Context

Read `AGENTS.md` (root) first for endpoints, troubleshooting, and current conventions. For roadmap status counts, check `progress.txt` (last 20 lines) and `docs/WORLDBASE_ROADMAP_V4.md` (search by item heading).

**Legacy docs** (`WORLDBASE_ROADMAP_OPEN.md`, `WORLDBASE_SESSION_PLAN.md`) have drifted and are deprecated. `docs/MASTER_PLAN.md` no longer exists — do not reference it.

### Step 2: Look Up Item Spec

When implementing a specific item (e.g. V4-33):
1. Search `docs/WORLDBASE_ROADMAP_V4.md` for the item heading (e.g. `## V4-33`)
2. Read only that section — do not read the full 1815-line file
3. The spec contains: description, key files, LOC estimate, dependencies, implementation notes

### Step 3: Implement

Follow WorldBase conventions:
- Fail-soft: every feature degrades gracefully without GPU
- Feature flags default OFF (e.g. `WORLDBASE_WHISPER=0`)
- **Docker-First:** Stack runs via `docker compose up -d --build`, no venv backend
- Backend-Tests: `docker compose exec backend python -m pytest backend/tests/test_xxx.py -x`
- Frontend-Tests: `npx vitest run` (in `frontend/` directory, works while Docker runs)
- Unit tests required — pytest (backend), Vitest (frontend)
- No comments or documentation unless asked
- No emojis in code files
- Pre-commit hooks: ruff + tsc + prettier must pass
- Research/dev docs (`docs/WORLDBASE_ROADMAP_*`, `progress.txt`) not committed
- Never run venv backend and Docker stack simultaneously (`netstat -ano | findstr :8002`)

### Step 3a: Use MCP Tools (intelshed server)

The intelshed MCP server provides 32 tools connected to the live system. Use them:

**Pre-implementation (understand current state):**
- `worldbase_health` — check system is alive before starting
- `worldbase_feed_status` — check which feeds are fresh/stale before touching feed code
- `worldbase_agent_status` — check orchestrator/blackboard state before touching agent code
- `worldbase_briefing_latest` — read latest briefing before touching briefing code
- `worldbase_situations` — check situation board before touching situation features
- `worldbase_fusion_hotspots` — check fusion state before touching fusion code
- `worldbase_entity_search` / `worldbase_intel_entities` — check FtM graph before touching entity code
- `worldbase_feed_sample` — inspect actual feed data shape before writing parsers

**During implementation (validate as you go):**
- `worldbase_chat` — test chat/RAG changes by sending a query and checking response
- `worldbase_orchestrate` — test orchestrator changes by running a query through the 5-agent pipeline
- `worldbase_globe_toggle_layer` / `worldbase_globe_layers` — test layer changes live
- `worldbase_extract_iocs` — test IOC extraction on sample text

**Post-implementation (verify before commit):**
- `worldbase_health` — confirm system still alive after changes
- `worldbase_feed_status` — confirm no feeds broke
- `worldbase_agent_status` — confirm agent state sane
- `dev_tools_mcp` `security_scan` — scan new code for vulnerabilities
- `dev_tools_mcp` `analyze_code_quality` — check complexity/style of new code

**When working with new libraries:**
- `MCP_DOCKER` `resolve-library-id` + `get-library-docs` — fetch current API docs instead of guessing

**When context needs to survive sessions:**
- `memory` `create_memory` — save key decisions, gotchas, patterns for next instance

### Step 4: Update Status

After completing an item:
1. Update `docs/WORLDBASE_ROADMAP_V4.md` — mark item heading as `[SHIPPED]`
2. Log session in `progress.txt` with files changed and test results
3. `git add` only code + tests, no roadmap/progress files
4. **Mandatory PR workflow** (see `AGENTS.md` § Task completion workflow):
   - Feature branch → commit (`git commit -F .git/COMMIT_MSG.txt`) → push
   - `gh pr create --body-file .git/PR_BODY.md --base main`
   - Wait for CI green (`gh pr checks <PR#>`) — all checks must pass
   - `gh pr merge <PR#> --squash --delete-branch`
   - Never push directly to `main`, never merge before CI green, never skip the PR step

### Step 5: Verify

- `docker compose ps` — all 6 containers healthy
- `docker compose exec backend python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8002/api/health/ping')"`
- Frontend-Tests: `cd frontend && npx vitest run`
- Pre-commit: `ruff check .` + `tsc --noEmit` + `prettier --check src` must pass
- After backend code changes: `docker compose up -d --build` (rebuild required)

### File Roles

| File | Lines | Purpose |
|------|-------|---------|
| `AGENTS.md` | root | **Read first every session.** Endpoints, troubleshooting, conventions |
| `docs/WORLDBASE_ROADMAP_V4.md` | ~1850 | Item specs only (V4-01 to V4-71) — search by heading, read one section |
| `docs/STACK_INVENTORY_2026-07.md` | ~1275 | Live-verified technical inventory, module list, technique assessments |
| `docs/LLM_OPERATIONS_AGENT_BEST_PRACTICES_2026.md` | ~540 | Operations Agent design, safety model, rollout plan |
| `progress.txt` | growing | Session log — read last 20 lines for current stand |
| `.devin/workflows/next-instance.md` | ~87 | Concrete next-task assignment — read if starting fresh |
| `docs/WORLDBASE_ROADMAP_OPEN.md` | ~70 | **DEPRECATED** — status drifted, do not use |
| `docs/WORLDBASE_SESSION_PLAN.md` | ~990 | **ARCHIVED** — German, status drifted, historical reference only |
