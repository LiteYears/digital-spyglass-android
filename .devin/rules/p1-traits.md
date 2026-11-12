---
description: P1 High-Priority Agent Traits — always active. Compressed 2026-08-25 from 58→17 canonical traits (P0 trait 6 added 2026-08-25).
trigger: always_on
---

# P1 Traits — High Priority (always active)

## 7. PowerShell: No Heredoc, No Shell grep

Never use bash heredoc (`<<'EOF'`) in PowerShell. Use temp files + `git commit -F`. PowerShell env vars: `$env:VAR = "value"` (spaces around `=`), use `;` not `&&`. Complex inline Python with SQL: write a temp `.py` file, don't fight quoting. Long-running Python output: `python -u script.py > output.txt 2>&1; Get-Content output.txt`.

## 8. Verify Before Claim

No "probably", "likely", "vermutlich", "should work" for runtime state — verify or label as unverified hypothesis. Run HTTP probes, tests, git status, smoke tests before claiming success. Operator hates blackbox — show every intermediate result. Deliver conclusions after analysis: (1) what data says, (2) what to do now, (3) what to leave alone. Subagent audit findings need code inspection before fixing.

## 9. Physarum Logging is Mandatory

Physarum logging never stops mid-session. Every operator message -> `affect_record(query='CLI proxy')` every 15-30 min. Every LLM response -> `affect_record(query='LLM responded with: ...')`. EMA/Rubric collected via interactive `ask_user_question` with clickable options, NOT typing. Session end: full ritual — rubric, EMA, session report, SuperMemory, Memory MCP, progress.txt.

## 10. Recurring Complaints Are Lessons

If the operator says something 2+ times, it is an uncaptured lesson. Search existing traits for semantic overlap before creating a new one (Trait-META-Dedup-Before-Create). If overlap found: merge into existing trait. If not found: capture immediately in Memory MCP + SuperMemory.

## 11. Verify Branch Dependency Before PR

Before creating a PR, verify code dependency on the target base branch. Run `tsc --noEmit` and tests on the base branch. Choose PR base by code dependency, not by which branch you happen to be on. `phase5-camouflage` in digital-spyglass-android is FROZEN pending operator decision post-v4.0.0 (F-Droid MR !46224 merged 2026-10-19) — do not mix unrelated changes.

## 12. No Empty Commits

Do NOT make empty commits to re-trigger CI. Operator: "pfusche nicht herum ich hasse das". Cancelled CI runs from cancel-in-progress on rapid merges are NOT failures — verify before acting. Pre-push checklist: ruff check, prettier --check, tsc --noEmit, tests — all must pass before push. CI runs can be deleted via `gh run delete`.
