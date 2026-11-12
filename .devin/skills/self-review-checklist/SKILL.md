# Self-Review Checklist

## When to invoke
Before claiming a task "done" or "complete" — especially before commits, PRs, or session end.

## What it does
Queries physarum-learning for accumulated `agent_technical_error` traits and verifies your current work against each one. Each trait represents a technical error a previous agent instance made.

## Steps

1. Query physarum for agent_technical_error traits:
   ```
   affect_memory(query='what traits are supported?', status='candidate')
   ```
   Query ALL traits — do NOT filter by context. The hook and SKILL.md
   fallback both query all candidate + supported traits without a
   context filter. New technical contexts appear automatically.

2. For each trait, verify your current work does NOT repeat that error class. Output a table:

   | Trait | Verified? | Note |
   |-------|-----------|------|
   | trait_4142: PowerShell heredoc | Yes — used `git commit -F` | No heredoc attempted |
   | trait_4138: .env before psql | Yes — read .env first | POSTGRES_USER=hakgal |
   | ... | ... | ... |

3. If any check fails, fix the issue before proceeding.

4. If you identify a NEW error class not yet in the traits, persist it:
   ```
   affect_memory(query='add trait: <description>', content='<full description>',
                 context='agent_technical_error', session_id='<current>')
   ```

## Rules

- "Verified" alone is NOT sufficient — state what you did to verify
- If a trait is not applicable to the current work, say "Not applicable — no X in this task"
- Do NOT skip traits — every trait gets a row

## Rationale
Based on "Mistake Notebook Learning" (ACL 2026) and "Self-Improving AI Coding Agents Through Accumulated Behavioral Rules" (arxiv 2607.13091). The key insight: LLM agents repeat the same classes of mistakes across sessions because they lack a mechanism to retain corrections. A version-controlled accumulating rule set with a self-review checklist achieves 0% recurrence for ruled-against error classes.

## Integration with physarum
- Traits with `context='agent_technical_error'` are automatically injected at session start via `session_start.py` → `affect_hook_query.py` → `query_session_start()`.
- The self-review checklist is the proactive pre-completion counterpart.
- Together they form a closed loop: session start (confirm traits) → during session (just-in-time warnings) → before completion (self-review) → session end (persist new errors as traits).
