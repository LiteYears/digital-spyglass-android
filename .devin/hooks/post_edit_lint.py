#!/usr/bin/env python3
"""PostToolUse hook for edit/write — runs eslint on the changed file.

Catches lint errors (prefer-const, unused vars, exhaustive-deps, etc.)
immediately after an edit, before commit. Pre-commit only runs tsc,
so eslint errors slip through to CI otherwise.

Reads hook event JSON from stdin. If the edited file is a .ts/.tsx file
under src/, runs `npx eslint --no-eslintrc <file>` with the project config.
Non-blocking (exit 0 always) — injects warnings as additionalContext.

Fail-soft: if eslint is unavailable or the file is outside scope, exit 0
silently. Never blocks an edit.
"""

import json
import subprocess
import sys
import os

ESLINT_TIMEOUT = 10
FRONTEND_DIR = os.path.join(
    os.environ.get("DEVIN_PROJECT_DIR", "."),
    "frontend",
)


def _is_lintable(file_path):
    """Check if a file should be linted (.ts/.tsx under frontend/src)."""
    if not file_path:
        return False
    normalized = file_path.replace("\\", "/")
    if not (normalized.endswith(".ts") or normalized.endswith(".tsx")):
        return False
    # Only lint files under frontend/src or frontend/tests
    return "/frontend/src/" in normalized or "/frontend/tests/" in normalized


def _run_eslint(file_path):
    """Run eslint on a single file. Returns (success, output) tuple."""
    # Resolve to absolute path for eslint
    if not os.path.isabs(file_path):
        file_path = os.path.join(os.environ.get("DEVIN_PROJECT_DIR", "."), file_path)

    if not os.path.isfile(file_path):
        return True, ""

    try:
        proc = subprocess.run(
            f'npx eslint "{file_path}"',
            capture_output=True,
            text=True,
            timeout=ESLINT_TIMEOUT,
            cwd=FRONTEND_DIR,
            shell=True,
            env={
                **os.environ,
                "FORCE_COLOR": "0",
            },
        )
        # eslint exit 0 = no errors, 1 = errors, 2 = config error
        if proc.returncode == 0:
            return True, ""
        return False, proc.stdout + proc.stderr
    except subprocess.TimeoutExpired:
        return True, "[eslint hook: timed out, skipping]"
    except Exception:
        return True, ""


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_name = data.get("tool_name", "")
    if tool_name not in ("edit", "write"):
        sys.exit(0)

    tool_input = data.get("tool_input", {})
    file_path = tool_input.get("file_path", "")

    if not _is_lintable(file_path):
        sys.exit(0)

    success, output = _run_eslint(file_path)
    if success:
        sys.exit(0)

    # Non-blocking: inject lint errors as context
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    "additionalContext": (
                        f"ESLint found issues in {os.path.basename(file_path)}:\n"
                        f"{output.strip()}\n\n"
                        "Fix these before committing. Pre-commit only runs tsc, "
                        "not eslint — CI will catch these otherwise."
                    ),
                }
            }
        )
    )
    sys.exit(0)


if __name__ == "__main__":
    main()
