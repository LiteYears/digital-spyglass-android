#!/usr/bin/env python3
"""Stop hook — reminds agent to complete physarum end-of-session ritual.

Fires when the agent wants to stop. Injects a reminder to complete:
1. EMA (operator self-report via ask_user_question)
2. Rubric (operator self-report via ask_user_question)
3. Session report (affect_session + SuperMemory + Memory MCP)
4. progress.txt update

NON-BLOCKING: always exits 0. Never uses decision: "block" — that can
cause agent loops per Devin docs. The reminder is injected as
additionalContext; the agent decides whether to act on it.

The stop_hook_active field is checked to prevent infinite loops: if
the agent was already reminded and is stopping again, let it stop.
"""

import json
import sys

REMINDER = (
    "--- digital brain end-of-session check ---\n"
    "Before ending this session, verify you have completed ALL of these:\n"
    "  1. Save brain session state: brain_session(action='save', state={sessionId, timestamp, project, tasks, decisions, deadEnds, openQuestions, nextSteps, artifacts})\n"
    "  2. Run decay pass: brain_act(action='decay_all') - find stale Memory MCP observations\n"
    "  3. Check reflection threshold: brain_query(query='reflection status', entries=[...]) - if threshold met, call brain_act(action='reflect')\n"
    "  4. Check consolidation: brain_query(query='consolidation candidates', entries=[...]) - if threshold met, call brain_act(action='consolidate')\n"
    "  5. Log to SuperMemory: add_memory with session report\n"
    "  6. Log to Memory MCP: create_entities + create_relations for key decisions and patterns\n"
    "\n"
    "--- physarum end-of-session check ---\n"
    "  7. EMA recorded: affect_record(query='record EMA', valence=X, focus=X, frustration=X, trust=X, ...)\n"
    "  8. Rubric recorded: affect_record(query='record rubric', task_completion=X, ...)\n"
    "  9. Session report generated: affect_session(query='session report')\n"
    "  10. progress.txt updated with session summary line\n"
    "  11. SELF-ERROR REFLECTION (mandatory for learning loop):\n"
    "     a. Identify technical errors you made this session (wrong assumptions, failed commands,\n"
    "        missing env vars, wrong container/role/file paths, architecture misunderstandings).\n"
    "     b. For EACH error, persist it as a physarum trait via:\n"
    "        affect_memory(query='add trait: <short description>',\n"
    "                      content='<full description with context>',\n"
    "                      context='agent_technical_error',\n"
    "                      session_id='<this session>')\n"
    "     c. These traits appear in the NEXT session's startup context automatically.\n"
    "     d. If you made no technical errors, state that explicitly.\n"
    "\n"
    "AUTHORITY CHECK - did you violate the operator-is-ground-truth rule this session?\n"
    "  - Did you make any decision without asking when uncertain?\n"
    "  - Did you trust data over an operator statement without a second confirmation?\n"
    "  - If yes: record the violation in brain session-state as a deadEnd and persist to Memory MCP\n"
    "\n"
    "If any are missing, do them now before stopping. Use ask_user_question for EMA + Rubric.\n"
    "If the operator says to stop anyway, respect that — this is a reminder, not a block."
)


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    stop_hook_active = data.get("stop_hook_active", False)
    if stop_hook_active:
        sys.exit(0)

    output = {
        "hookSpecificOutput": {
            "hookEventName": "Stop",
            "additionalContext": REMINDER,
        }
    }
    print(json.dumps(output))
    sys.exit(0)


if __name__ == "__main__":
    main()
