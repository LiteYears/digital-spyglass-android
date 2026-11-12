#!/usr/bin/env python3
"""SessionStart hook — injects learned patterns into agent context.

Phase 1: reads recent failed commands from exec_log.jsonl.
Phase 2: queries physarum-learning DB for operator lessons + memory.
         Fail-soft to Phase 1 if physarum DB or CLI is unavailable.
"""

import json
import shutil
import subprocess
import sys
import os
from collections import Counter

LOG_FILE = os.path.join(
    os.environ.get("DEVIN_PROJECT_DIR", "."), ".devin", "hooks", "exec_log.jsonl"
)

PHYSARUM_CLI = os.path.join(
    os.environ.get("PHYSARUM_PROJECT_DIR", r"D:\MCP Mods\HAK_GAL_HEXAGONAL\affect_sidecar"),
    "src",
    "affect_hook_query.py",
)
PHYSARUM_TIMEOUT = 5

REQUIRED_HOOK_FILES = [
    "hooks.v1.json",
    "hooks/pre_exec_guard.py",
    "hooks/post_exec_log.py",
    "hooks/post_edit_lint.py",
    "hooks/stop_guard.py",
    "hooks/user_prompt_submit.py",
    "hooks/session_start.py",
    "rules/verify-first.md",
    "skills/backend-architecture/SKILL.md",
    "skills/dev-workflow/SKILL.md",
    "skills/next-instance/SKILL.md",
    "skills/physarum-logging/SKILL.md",
    "skills/prompt-strategy/SKILL.md",
    "skills/roadmap-session/SKILL.md",
    "skills/self-review-checklist/SKILL.md",
]

OPERATOR_TOOLING_DIR = os.path.join(
    os.environ.get("PHYSARUM_PROJECT_DIR", r"D:\MCP Mods\HAK_GAL_HEXAGONAL\affect_sidecar"),
    "operator-tooling",
)


def _check_and_restore():
    """Self-healing: restore ONLY missing .devin files from canonical source.

    Copies per-file — never blanket -Force — so newer local files
    (hooks, rules, skills) are never overwritten by stale canonical
    versions."""
    devin_dir = os.path.join(os.environ.get("DEVIN_PROJECT_DIR", "."), ".devin")
    missing = [
        rel
        for rel in REQUIRED_HOOK_FILES
        if not os.path.isfile(os.path.join(devin_dir, rel))
    ]
    if not missing:
        return None
    restored, failed = [], []
    for rel in missing:
        src = os.path.join(OPERATOR_TOOLING_DIR, rel.replace("/", os.sep))
        dst = os.path.join(devin_dir, rel)
        try:
            if not os.path.isfile(src):
                failed.append(rel)
                continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            restored.append(rel)
        except Exception:
            failed.append(rel)
    if failed:
        return (
            f"Self-healing PARTIAL: {len(failed)} files unrestorable "
            f"(not found in canonical source or copy failed): {', '.join(failed[:3])}"
        )
    return (
        f"Self-healing OK: restored {len(restored)} missing files "
        f"from canonical source (missing-only copy, existing files untouched)"
    )


def main():
    try:
        json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    heal_result = _check_and_restore()

    recent_failures = []
    if os.path.exists(LOG_FILE):
        try:
            with open(LOG_FILE, "r", encoding="utf-8") as f:
                lines = f.readlines()[-200:]
            for line in lines:
                try:
                    entry = json.loads(line.strip())
                    if not entry.get("success", True):
                        recent_failures.append(entry.get("command", "")[:100])
                except Exception:
                    continue
        except Exception:
            pass

    project_dir = os.environ.get("DEVIN_PROJECT_DIR", ".")
    project_name = os.path.basename(project_dir)

    context_parts = [
        f"{project_name} session started. PowerShell environment (not bash).",
        "Known anti-patterns: no heredocs (<<'EOF'), no tail/head/grep/sed/awk/wc — use PowerShell equivalents.",
        "Paths with spaces: use -LiteralPath in PowerShell, quote in bash.",
        "Never run venv backend and Docker stack at the same time.",
        "CRITICAL: AGENTS.md and other rule files may be truncated when loaded as IDE rules. If you see '[Rule content truncated...]' or similar, you MUST read the full file with the read tool before acting. Never assume the truncated portion is irrelevant — it contains critical rules, testing requirements, and logging procedures.",
        "TRAIT SYSTEM: 16 canonical traits exist as Global Rules (P0, in %APPDATA%/devin/AGENTS.md) + Project Rules (.devin/rules/p1-traits.md always_on, .devin/rules/p2-traits.md model_decision). Any trait_41XX entries below from physarum DB are SUPERSEDED — do not confirm them individually. The canonical traits in the Rules files are authoritative.",
        "",
        "SUPREME PRINCIPLE - Operator is ground truth (Trait 7, global AGENTS.md):",
        "  When uncertain: immediately ask operator via ask_user_question (clickable).",
        "  If data contradicts operator: ask a SECOND time with the conflicting data.",
        "  If operator confirms again: operator wins, data loses. No exceptions.",
        "  This overrides ALL automated decisions: consolidation, reflection, decay, coherence.",
        "  The operator has context that no memory system captures.",
        "",
        "4-LAYER COGNITIVE STACK (Digital Brain sits on top):",
        "  Layer 1: SuperMemory — cross-session semantic search ('What did I do before?')",
        "  Layer 2: Memory MCP — structured entity/relation graph ('What do I know?')",
        "  Layer 3: Physarum Learning — operator affective state ('How is the operator?')",
        "  Layer 4: Digital Brain — cognitive lifecycle ('What do I keep, consolidate, reflect on, decay?')",
        "",
        "DIGITAL BRAIN INIT PROTOCOL (8 steps, complete ALL before accepting tasks):",
        "1. Call brain_query(query='memory stats') — Memory MCP graph statistics",
        "2. Call brain_query(query='decay candidates') — find stale observations",
        "3. Call brain_session(action='brief') — load the full session brief",
        "4. Call brain_query(query='surprisal') — surprisal gate stats (write-time noise filter)",
        "5. Call brain_query(query='recurrence') — recurrence buffer status (consolidation triggers)",
        "6. Search SuperMemory: search_memory(query='digital brain architecture operator authority session') — cross-session recall",
        "7. Search Memory MCP for project-relevant entities: search for 'digital-spyglass' and related concepts",
        "8. Query Physarum: affect_query(query='current state') — operator affective state (Layer 3)",
        "  Digital Brain is the cognitive layer ABOVE SuperMemory, Memory MCP, and Physarum.",
        "  It manages what gets consolidated, reflected on, and decayed across sessions.",
        "",
        "After completing all 8 steps, present a COHERENT INIT SUMMARY to the operator that includes:",
        "  - Memory graph stats (entities, observations, active/superseded/decayed counts)",
        "  - Previous session brief (decisions, tasks, dead-ends, open questions)",
        "  - Surprisal gate stats (rejection rate, total inputs)",
        "  - Recurrence buffer status (ready clusters, total entries)",
        "  - SuperMemory recall results (what previous sessions did, cross-project)",
        "  - Project-relevant entities from Memory MCP",
        "  - Operator affective state from Physarum (dominant emotion, confidence, VAD values)",
        "  - The authority principle acknowledgment",
        "  - The 4-layer stack awareness",
    ]

    if heal_result:
        context_parts.append("--- .devin self-healing ---")
        context_parts.append(heal_result)

    if os.path.isfile(PHYSARUM_CLI):
        try:
            proc = subprocess.run(
                [
                    sys.executable,
                    PHYSARUM_CLI,
                    "--event",
                    "session_start",
                ],
                capture_output=True,
                text=True,
                timeout=PHYSARUM_TIMEOUT,
                env={
                    **os.environ,
                    "POSTGRES_PASSWORD": os.environ.get("POSTGRES_PASSWORD", "admin"),
                },
            )
            if proc.stdout.strip():
                physarum_result = json.loads(proc.stdout.strip())
                physarum_context = physarum_result.get("hookSpecificOutput", {}).get(
                    "additionalContext", ""
                )
                if physarum_context:
                    context_parts.append("--- physarum-learning operator lessons ---")
                    context_parts.append(physarum_context)
        except Exception:
            pass

    if recent_failures:
        top_failures = Counter(recent_failures).most_common(3)
        failure_summary = "; ".join(
            f"'{cmd[:60]}...' ({count}x)" for cmd, count in top_failures if cmd
        )
        if failure_summary:
            context_parts.append(f"Recent recurring failures: {failure_summary}")

    temporal = _temporal_line()
    if temporal:
        context_parts.insert(0, temporal)

    output = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": "\n".join(context_parts),
        }
    }
    print(json.dumps(output))
    sys.exit(0)


def _temporal_line():
    """Elapsed-gap + ICT clock + presence line at session start. Fail-soft, read-only."""
    try:
        otime_dir = r"D:\MCP Mods\hermes-brain\tools"
        if otime_dir not in sys.path:
            sys.path.insert(0, otime_dir)
        import operator_time
        line = operator_time.temporal_line(update_pulse=False)
        if line:
            return f"[temporal] {line} — gap measured since last operator prompt (any project)."
    except Exception:
        pass
    return None


if __name__ == "__main__":
    main()
