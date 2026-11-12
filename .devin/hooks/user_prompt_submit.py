#!/usr/bin/env python3
"""UserPromptSubmit hook — auto-records operator text + injects logging reminder.

Fires on every operator prompt. Does two things:
1. Calls physarum CLI to auto-record operator text (fail-soft)
2. Injects a brief reminder into agent context: "physarum logging is active,
   remember to log CLI proxy / LLM output / feedback manually"

Non-blocking: always exits 0. If physarum CLI is unavailable, only the
reminder is injected (no data recording).
"""

import json
import subprocess
import sys
import os

PHYSARUM_CLI = os.path.join(
    os.environ.get("PHYSARUM_PROJECT_DIR", r"D:\MCP Mods\HAK_GAL_HEXAGONAL\affect_sidecar"),
    "src",
    "affect_hook_query.py",
)
PHYSARUM_TIMEOUT = 5

OTIME_DIR = r"D:\MCP Mods\hermes-brain\tools"

REMINDER = (
    "--- physarum-logging reminder ---\n"
    "Physarum logging is active for this session. Operator text is auto-recorded by this hook.\n"
    "You (the agent) are still responsible for logging:\n"
    "  - CLI proxy: affect_record(query='CLI proxy', ...) every ~15 min during long tasks\n"
    "  - LLM output: affect_record(query='LLM responded with: ...', text='...', ...) after each LLM call\n"
    "  - Feedback: affect_record(query='feedback', ...) after strategy changes\n"
    "  - EMA + Rubric: collect from operator via ask_user_question at session end\n"
    "  - Session report: affect_session(query='session report') + persist to SuperMemory + Memory MCP\n"
    "Do NOT skip these. The Stop hook will remind you again before you can end the session."
)


def _record_operator_text(prompt_text):
    """Call physarum CLI to auto-record operator text. Fail-soft."""
    if not os.path.isfile(PHYSARUM_CLI):
        return
    try:
        subprocess.run(
            [
                sys.executable,
                PHYSARUM_CLI,
                "--event",
                "user_prompt_submit",
                "--input",
                json.dumps({"prompt": prompt_text[:500]}),
            ],
            capture_output=True,
            text=True,
            timeout=PHYSARUM_TIMEOUT,
            env={
                **os.environ,
                "POSTGRES_PASSWORD": os.environ.get("POSTGRES_PASSWORD", "admin"),
            },
        )
    except Exception:
        pass


def _temporal_context():
    """Elapsed-gap + ICT clock + presence line. Fail-soft."""
    try:
        if OTIME_DIR not in sys.path:
            sys.path.insert(0, OTIME_DIR)
        import operator_time
        line = operator_time.temporal_line(update_pulse=True)
        if line:
            return f"[temporal] {line}\nInterpret gap with evidence, not assumption: silence is not proof of absence."
    except Exception:
        pass
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    prompt_text = data.get("prompt", "")
    if not prompt_text:
        prompt_text = data.get("user_prompt", "")
    if not prompt_text:
        sys.exit(0)

    _record_operator_text(prompt_text)

    temporal = _temporal_context()
    context = f"{temporal}\n\n{REMINDER}" if temporal else REMINDER

    output = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": context,
        }
    }
    print(json.dumps(output))
    sys.exit(0)


if __name__ == "__main__":
    main()
