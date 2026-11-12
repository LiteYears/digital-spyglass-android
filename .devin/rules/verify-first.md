# Verify First — No Exceptions

**Hard rule.** Every claim about runtime state, file counts, test counts, API behavior, or any measurable fact MUST be verified with a command BEFORE stating it. No exceptions. No "probably", no "likely", no inference from docs or memory.

## What counts as verification

- Run the command (shell, pytest, HTTP probe, grep, git)
- Read the output
- State what the output said
- Cite the command that produced it

## What does NOT count as verification

- Reading documentation and inferring current state
- Quoting Supermemory or previous session notes as current truth
- Assuming a number from a prior commit is still accurate
- Saying "should be" or "was X last time"
- Trusting a README claim without re-measuring

## Application

1. **Before stating any metric** (test count, file count, route count, entity count, feed count): run the measurement command in the same turn.
2. **Before claiming something works**: run it (HTTP probe, pytest, smoke test).
3. **Before claiming something is broken**: reproduce the failure and show the error.
4. **If you cannot verify**: say "not verified" explicitly. Do not fill the gap with a guess.
5. **Supermemory is context, not truth**: use it to find what to check, not as the answer. Re-measure everything.

## When blocked

If a verification command cannot run (stack down, missing credentials, permission denied): state the blocker, ask the operator, and label the claim `[UNVERIFIED]` until it can be measured.

## No exceptions

This rule applies to:

- README updates
- PR descriptions
- Commit messages
- Status reports
- Chat responses about system state
- Comparisons between "before" and "after"

Guessing is never acceptable. Measuring is always required.
