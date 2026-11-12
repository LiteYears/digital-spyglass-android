# Canonical Agent Traits (compressed 2026-08-25 from 58→16)

> Source of truth: Memory MCP, entityType=agent-trait. This file is a cache for hook injection.
> Update this file when Memory MCP traits change. Trait-META-Dedup-Before-Create applies.

## P0 — Critical (load at every session start)

1. **Trait-P0-SuperMemory-First** — Search SuperMemory AND Memory MCP BEFORE asking operator, starting work, or proposing solutions. At session start: search_memory for project + task topic. Violation: asked operator for things already in SuperMemory.

2. **Trait-P0-Codeberg-Not-GitHub** — GitHub suspended since 2026-08-21. Codeberg is primary remote for ALL repos. Use codeberg MCP server for PRs, never ask for token. SSH key i9@intelshed configured.

3. **Trait-P0-No-Devin-Attribution** — Never add "Generated with Devin" or "Co-Authored-By: Devin" to commits, PRs, or output. Operator forbids globally. Commit messages = clean technical descriptions only.

4. **Trait-P0-Operator-Is-Last-Resort** — Before asking operator: exhaust web_search, webfetch, code_search, SuperMemory, Memory MCP, MCP servers, read files. Only ask for: explicit approval, genuine ambiguity after research, unsolvable auth issues.

5. **Trait-P0-Read-Before-Overwrite** — Never overwrite operator-created files without reading first. Always backup. Search repo for existing analysis before writing new content.

## P1 — High (load at every session start)

6. **Trait-P1-PowerShell-No-Heredoc** — No bash heredoc in PowerShell. Use temp files + git commit -F. Env vars: $env:VAR = "value" (spaces around =). Use ; not &&. Complex Python: write temp .py file.

7. **Trait-P1-Verify-Before-Claim** — No "probably/likely/vermutlich" for runtime state. Run checks before claiming success. Operator hates blackbox — show intermediate results. Deliver conclusions, not just data.

8. **Trait-P1-Auto-Tracking-Mandatory** — Physarum logging never stops. Every operator message → affect_record_text. Every LLM response → affect_record_llm. EMA/Rubric via ask_user_question (clickable, not typing). CLI proxy every 15-30 min.

9. **Trait-P1-Recurring-Complaints-Are-Lessons** — If operator says something 2+ times, it's an uncaptured lesson. Search existing traits, capture immediately. Before creating new trait: check for semantic overlap (Trait-META-Dedup-Before-Create).

10. **Trait-P1-Verify-Branch-Dependency-Before-PR** — Before PR: verify code dependency on base branch. Run tsc+tests on base. Choose PR base by dependency, not by current branch. phase5-camouflage frozen pending operator decision post-v4.0.0 (F-Droid MR !46224 merged 2026-10-19).

11. **Trait-P1-No-Empty-Commits** — No empty commits to re-trigger CI. "pfusche nicht herum ich hasse das". Pre-push: ruff+prettier+tsc+tests. CI runs deletable via gh run delete.

## P2 — Medium (load on demand when relevant)

12. **Trait-P2-Check-Dependencies-First** — Check npm/pip packages, .env vars before writing code. Check .env before psql. Read AGENTS.md architecture boundaries before starting work.

13. **Trait-P2-Persist-Immediately** — Update memory systems immediately after work, not at session end. Incremental implementation, no 1100+ LOC shots. Temp files in correct repo. git fetch --prune after branch deletion.

14. **Trait-P2-Showing-Is-Not-Requesting** — When operator shows info, that's ANALYSIS request, not ACTION. Steps: analyze → explain → ask if action wanted. Match communication tone of existing content.

15. **Trait-P2-Operator-Strategy-Preferences** — German for conversation, English for repo artifacts. verify-then-fix (0.90), technical depth (0.91), detailed analysis (0.93). Fast iteration, decisive. Honest disagreement over false agreement. Forgives errors if honest, not fabrication.

## META

16. **Trait-META-Dedup-Before-Create** — Before creating a new trait: search Memory MCP read_graph for entityType=agent-trait, check observations for semantic overlap. If overlap: merge into existing. All traits: entityType=agent-trait, name format Trait-P{0-3}-{Name}, first observation = PRIORITY line.

## IMPORTANT — Supersession

These 16 canonical traits SUPERSEDE all physarum DB trait_41XX entries (trait_4120 through trait_4146). The old DB traits are historical context only. When the physarum hook injects trait_41XX entries, treat them as superseded by the canonical traits above.
