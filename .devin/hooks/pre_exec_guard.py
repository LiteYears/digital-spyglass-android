#!/usr/bin/env python3
"""PreToolUse hook for exec — blocks known PowerShell anti-patterns.

Phase 1: static anti-pattern list (always runs).
Phase 2: queries physarum-learning DB for operator lessons. Fail-soft
         to Phase 1 static list if physarum DB or CLI is unavailable.

Reads hook event JSON from stdin, returns exit 2 + reason on block.
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
PHYSARUM_TIMEOUT = 3

ANTI_PATTERNS = [
    {
        "pattern": "<<'EOF'",
        "reason": "Bash heredoc syntax (<<'EOF') does not work in PowerShell. "
        "Use: write content to a temp file, then use the file as input.",
    },
    {
        "pattern": "<<EOF",
        "reason": "Bash heredoc syntax (<<EOF) does not work in PowerShell. "
        "Use: write content to a temp file, then use the file as input.",
    },
    {
        "pattern": "cat <<",
        "reason": "Bash heredoc (cat <<) does not work in PowerShell. "
        "Use: write content to a temp file, then read it.",
    },
    {
        "pattern": "tail -",
        "reason": "tail is not available as a native PowerShell command. "
        "Use: Select-Object -Last <N> or | Select-Object -Last <N>",
    },
    {
        "pattern": "head -",
        "reason": "head is not available as a native PowerShell command. "
        "Use: Select-Object -First <N> or | Select-Object -First <N>",
    },
    {
        "pattern": "grep -",
        "reason": "grep is not available as a native PowerShell command. "
        "Use the provided grep tool instead, or Select-String in PowerShell.",
    },
    {
        "pattern": "find . -",
        "reason": "Unix find syntax does not work in PowerShell. "
        "Use: Get-ChildItem -Recurse -Filter <pattern>",
    },
    {
        "pattern": "chmod +x",
        "reason": "chmod is not available in PowerShell. "
        "Use: icacls or Set-ItemProperty for permissions.",
    },
    {
        "pattern": "sed -i",
        "reason": "sed is not available in PowerShell. "
        "Use: (Get-Content file) -replace 'old','new' | Set-Content file",
    },
    {
        "pattern": "awk ",
        "reason": "awk is not available in PowerShell. "
        "Use PowerShell string operators or ForEach-Object.",
    },
    {
        "pattern": "wc -l",
        "reason": "wc is not available in PowerShell. "
        "Use: (Get-Content file).Count or Measure-Object -Line",
    },
    {
        "pattern": 'echo "$(cat',
        "reason": "Bash command substitution $(cat ...) does not work in PowerShell. "
        "Use: Get-Content file | ... or write to temp file first.",
    },
]


def _check_static(command):
    """Phase 1: check against static anti-pattern list."""
    for ap in ANTI_PATTERNS:
        if ap["pattern"] in command:
            return ap
    return None


def _check_physarum(tool_name, tool_input):
    """Phase 2: query physarum DB for operator lessons. Fail-soft to None."""
    if not os.path.isfile(PHYSARUM_CLI):
        return None
    try:
        proc = subprocess.run(
            [
                sys.executable,
                PHYSARUM_CLI,
                "--event",
                "pre_tool_use",
                "--tool",
                tool_name,
                "--input",
                json.dumps(tool_input),
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
            result = json.loads(proc.stdout.strip())
            if result.get("decision") == "block":
                return result
            if result.get("warning") or result.get("source") == "agent_technical_error_trait":
                return result
    except Exception:
        pass
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_input = data.get("tool_input", {})
    command = tool_input.get("command", "")
    if not command:
        sys.exit(0)

    ap = _check_static(command)
    if ap:
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "additionalContext": (
                            f"WARNING (static anti-pattern, non-blocking): {ap['reason']} "
                            "This is a known Windows/PowerShell incompatibility. "
                            "Use the suggested alternative instead. "
                            "You may proceed if you have a justified reason, but the command will likely fail."
                        ),
                    }
                }
            )
        )
        sys.exit(0)

    physarum_result = _check_physarum("exec", tool_input)
    if physarum_result:
        is_warning = physarum_result.get("warning", False) or physarum_result.get("source") == "agent_technical_error_trait"
        if is_warning:
            print(
                json.dumps(
                    {
                        "hookSpecificOutput": {
                            "hookEventName": "PreToolUse",
                            "additionalContext": (
                                f"WARNING (agent technical error from previous session): "
                                f"{physarum_result.get('reason', '')}. "
                                "Do NOT repeat this error. Use the suggested alternative. "
                                "You may proceed if you have a justified reason."
                            ),
                        },
                        "trait_id": physarum_result.get("trait_id"),
                    }
                )
            )
            sys.exit(0)
        else:
            print(
                json.dumps(
                    {
                        "hookSpecificOutput": {
                            "hookEventName": "PreToolUse",
                            "additionalContext": (
                                f"WARNING (physarum lesson match, non-blocking): "
                                f"{physarum_result.get('reason', '')}. "
                                "Consider an alternative approach. This is a warning, not a block — "
                                "you may proceed if you have a justified reason."
                            ),
                        },
                        "lesson_id": physarum_result.get("lesson_id"),
                        "confidence": physarum_result.get("confidence"),
                    }
                )
            )
            sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()
