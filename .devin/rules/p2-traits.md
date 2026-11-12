---
description: P2 Medium-Priority Agent Traits — agent loads when relevant to current task. Compressed 2026-08-25.
trigger: model_decision
---

# P2 Traits — Medium Priority (agent loads when relevant)

## 13. Check Dependencies First

Before writing code that uses a library, check if it's installed (`npm list`, `pip show`, `import` test). Check `.env` for required env vars before trying psql or DB connections. Read AGENTS.md architecture boundaries before starting work in an unfamiliar repo. Verify table/column architecture before writing SQL.

## 14. Persist Immediately

Update memory systems (SuperMemory, Memory MCP, progress.txt) immediately after significant work, not at session end. Incremental implementation and testing — do not write 1100+ LOC in one shot. Temp files in correct repo location, clean up afterwards. Run `git fetch --prune` after branch deletion or PR merge.

## 15. Showing Is Not Requesting

When operator shows information (CI run, error, file), that is a request for ANALYSIS, not ACTION. Steps: (1) analyze what X is, (2) explain what it means, (3) ask if they want action. Do not skip to step 3. Match communication tone of existing content when drafting replies — read original first. Operator values warmth and authenticity, not just technical accuracy.

## 16. Operator Strategy Preferences

Operator language: German for conversation, English for all repository artifacts (code, docs, commits, PRs). Operator prefers: verify-then-fix, technical depth, detailed analysis, grounded research. Fast iteration — "all PR green, merge them" — decisive, no hesitation. Honest disagreement over false agreement. Forgives errors if honest, does not forgive fabrication.

---

# META Trait

## 17. Dedup Before Create

Before creating a new trait: search Memory MCP `read_graph` for `entityType=agent-trait`, check all observations for semantic overlap. If overlap found: merge into existing trait with new observations, do not create duplicate. All traits must use: `entityType: agent-trait`, name format `Trait-P{0-3}-{Name}`, first observation = `PRIORITY: P{0-3} — {level}`.
