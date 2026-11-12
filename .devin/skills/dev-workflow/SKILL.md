---
name: dev-workflow
description: Non-trivial engineering workflow — analyze, plan, scope-check before implementing. Invoke with /dev-workflow for tasks larger than a one-liner.
triggers:
  - user
allowed-tools:
  - read
  - grep
  - glob
---

# IntelShed Development Workflow

## Purpose

Use this workflow for any non-trivial engineering task in IntelShed.
The goal is to keep development fast, verifiable, and safe in a high-complexity research codebase.

This skill is read-only. It covers analysis, planning, and scope-checking.
Implementation happens after the operator approves the plan — at that point
the agent exits this skill context and uses its normal tools, or the operator
invokes a future `/dev-execute` skill.

## Core Rules

1. Do not start coding immediately.
   First inspect the repository, identify the affected modules, and explain the implementation plan.
2. Keep tasks bounded.
   If the task is larger than one focused PR or likely exceeds 4–8 hours, split it into smaller sub-tasks before coding.
3. Prefer minimal, isolated changes.
   Do not mix documentation fixes, refactors, feature work, and behavioral changes in the same PR unless explicitly requested.
4. Preserve existing behavior unless the task explicitly changes it.
   For feature-flagged work, keep the OFF path unchanged.
5. Never silently swallow uncertainty.
   If requirements are ambiguous, stop and ask for clarification before implementation.

## Execution Steps

### Step 1 — Repo Analysis

- Read the relevant files first.
- Identify the entry points, affected functions, tests, config flags, migrations, and API surfaces.
- Summarize the current behavior before proposing a change.

### Step 2 — Plan First

Write a concise implementation plan before editing code.
State:

- affected files
- expected behavior change
- risks
- tests to add or update
- rollback path

Do not proceed until the plan is coherent.

### Step 3 — Scope Check

If the task is too broad, split it.
Prefer one clear PR per concern, for example:

- docs-only
- config-only
- feature-flag plumbing
- read-path cutover
- backfill
- aggregation logic
- cleanup

### Step 4 — Implement (after approval)

- Change the smallest possible surface area.
- Preserve naming and style already used in the repository.
- Avoid speculative abstraction unless the task requires it.
- Keep legacy compatibility where the workflow or flag requires it.

### Step 5 — Test and Verify

- Run the narrowest relevant tests first.
- Then run the broader regression suite for the affected subsystem.
- If behavior changed, explain exactly why.
- If tests fail, fix the root cause rather than weakening assertions.

### Step 6 — Document

- Update docs, contracts, or comments whenever behavior, schema, flags, or return shapes change.
- Keep documentation consistent with the merged code, not with stale plans.

### Step 7 — Prepare PR

For every PR, provide:

- title
- short problem statement
- exact change summary
- risk assessment
- acceptance criteria
- test evidence
- rollback note

**Operator approval required:** Before committing, pushing, creating the PR, or merging, the agent MUST ask the operator via `ask_user_question` for explicit approval. Never automate GitHub operations.

### Step 8 — Review Gate

Before suggesting merge, verify:

- CI is green
- required tests passed
- docs/contracts match code
- feature flags default safely
- no unrelated files are included
- the PR scope is still isolated

**Merge requires explicit operator approval via `ask_user_question`.** Never merge automatically, even when CI is green.

## IntelShed-Specific Rules

- Treat schema, trust scoring, and aggregation changes as high-risk.
- For trust-layer changes, require explicit invariants and regression tests.
- For feature-flagged migrations, keep OFF behavior stable and verify ON behavior separately.
- For read/write path migrations, separate:
  - schema introduction
  - dual-write
  - read cutover
  - backfill
  - aggregation changes
  - cleanup
- Never use silent exception handling in trust-scoring paths.
- When behavior depends on data semantics, prefer measurable verification over assumptions.

## Required Output Format

When assigned a task, always respond in this order:

1. Current understanding
2. Files likely affected
3. Implementation plan
4. Risks and unknowns
5. Tests to run
6. Then — stop and present the plan for operator approval before implementing.

## Stop Conditions

Stop and ask for guidance if:

- the task touches multiple subsystems with unclear boundaries
- the code contradicts the docs or contract
- a migration changes runtime semantics unexpectedly
- CI behavior differs from local results
- the requested change cannot be verified with available tests

## PR Style

- Prefer small PRs.
- Prefer reversible changes.
- Prefer explicit contracts over implicit behavior.
- Prefer measurable claims over speculative claims.
