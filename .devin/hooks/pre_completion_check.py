#!/usr/bin/env python3
"""Pre-completion completeness check hook (Trait 10).

Fires at Stop events. Injects the 8-point completeness checklist
as additionalContext. Non-blocking — the agent must run through it
mentally before declaring done.

Trait 10: Pre-Completion Completeness Check — Meta-Cognitive Gate
Added 2026-09-06 after operator insight: "Habe ich an alle wichtigen
Dinge gedacht, die fuer diese Aufgabe notwendig sind?"
"""

import json
import sys
import os


CHECKLIST = [
    "TRAIT 10 PRE-COMPLETION CHECK — run mentally before saying 'done':",
    "",
    "1. Did I read the relevant files before writing? (Trait 5) — target file, dependencies, configs, tests, AGENTS.md",
    "2. Did I search SuperMemory and Memory MCP for prior context? (Trait 1) — similar incidents, lessons, operator preferences",
    "3. Did I verify my assumptions against the real state of the world? — not 'should work' but 'tested and works'",
    "4. Did I check for edge cases and failure modes? — what breaks, what's missing, what's untested",
    "5. Did I run the verification commands? — tests, typecheck, build, lint as applicable",
    "6. Did I preserve partial outputs and state? — no silent data loss, no overwrite without backup",
    "7. Did I distinguish what I observed from what I assumed? (Trait 0) — no false confidence, no unverified claims",
    "8. Is there anything the operator will discover after I say done that I could have caught now?",
    "",
    "If ANY answer is 'no' or 'not sure': do not declare done. Fix the gap first.",
    "This is not perfectionism. It is meta-cognitive self-questioning at the completion boundary.",
    "Source: operator insight 2026-09-06 — recurring pattern of iterative fixes that would not be needed if the agent had asked 'did I think of everything important?'",
]


def main():
    try:
        json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    output = {
        "hookSpecificOutput": {
            "hookEventName": "Stop",
            "additionalContext": "\n".join(CHECKLIST),
        }
    }
    print(json.dumps(output))
    sys.exit(0)


if __name__ == "__main__":
    main()
