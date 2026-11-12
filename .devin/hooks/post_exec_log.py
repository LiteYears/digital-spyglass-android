#!/usr/bin/env python3
"""PostToolUse hook for exec — logs command outcomes for pattern learning.

Phase 1: appends to .devin/hooks/exec_log.jsonl (local file).
Phase 2: calls physarum-learning's affect_hook_query (read-only).
Phase 3: persists failed commands to affect_memory_nodes as observations,
         so they appear in the NEXT session's startup context as concrete
         failure examples. This closes the learning loop without blocking.
         Fail-soft: logging never fails the hook.
"""

import json
import subprocess
import sys
import os
from datetime import datetime, timezone

LOG_FILE = os.path.join(
    os.environ.get("DEVIN_PROJECT_DIR", "."), ".devin", "hooks", "exec_log.jsonl"
)

PHYSARUM_CLI = os.path.join(
    os.environ.get("PHYSARUM_PROJECT_DIR", r"D:\MCP Mods\HAK_GAL_HEXAGONAL\affect_sidecar"),
    "src",
    "affect_hook_query.py",
)
PHYSARUM_TIMEOUT = 3

DB_TIMEOUT = 5


def _persist_failure_to_db(command, error, exit_code, session_id):
    """Phase 3: persist failed command as observation in affect_memory_nodes."""
    if not error and exit_code in (0, None):
        return
    try:
        import psycopg2
        conn = psycopg2.connect(
            host=os.getenv("POSTGRES_HOST", "127.0.0.1"),
            port=int(os.getenv("POSTGRES_PORT", "5172")),
            user=os.getenv("POSTGRES_USER", "hakgal"),
            password=os.getenv("POSTGRES_PASSWORD", "admin"),
            dbname=os.getenv("POSTGRES_DB", "hakgal"),
        )
        cur = conn.cursor()
        content = (
            f"AGENT EXEC FAILURE: '{command[:120]}' "
            f"exit_code={exit_code} error={error[:150]}"
        )
        cur.execute(
            """INSERT INTO affect_memory_nodes
               (node_type, content, session_id, created_at, metadata)
               VALUES ('observation', %s, %s, NOW(), %s)""",
            (
                content,
                session_id or "unknown",
                json.dumps({
                    "source": "post_exec_log_phase3",
                    "command": command[:500],
                    "error": error[:200] if error else "",
                    "exit_code": exit_code,
                    "category": "agent_exec_failure",
                }),
            ),
        )
        conn.commit()
        cur.close()
        conn.close()
    except Exception:
        pass


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_input = data.get("tool_input", {})
    command = tool_input.get("command", "")
    if not command:
        sys.exit(0)

    response = data.get("tool_response", {})
    success = response.get("success", True)
    error = response.get("error", "")
    exit_code = response.get("exit_code", None)
    session_id = data.get("session_id", "")

    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "session_id": session_id,
        "prompt_id": data.get("prompt_id", ""),
        "command": command[:500],
        "success": success,
        "error": error[:200] if error else "",
        "exit_code": exit_code,
    }

    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass

    if not success:
        _persist_failure_to_db(command, error, exit_code, session_id)

    if os.path.isfile(PHYSARUM_CLI):
        try:
            subprocess.run(
                [
                    sys.executable,
                    PHYSARUM_CLI,
                    "--event",
                    "post_tool_use",
                    "--tool",
                    "exec",
                    "--input",
                    json.dumps(tool_input),
                    "--response",
                    json.dumps(
                        {"success": success, "error": error, "exit_code": exit_code}
                    ),
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

    sys.exit(0)


if __name__ == "__main__":
    main()
