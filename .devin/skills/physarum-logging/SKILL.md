---
name: physarum-logging
description: End-of-session physarum logging ritual — rubric, EMA, CLI proxy, session report, SuperMemory, Memory MCP, progress.txt. Invoke at session end or when logging is needed.
triggers:
  - user
  - model
---

# Physarum Logging Ritual

The `physarum-learning` MCP server tracks operator affective state, CLI behavior, LLM agent state, and session quality. Log throughout the session — not just at the end.

## Automated logging via hooks (`.devin/hooks.v1.json`)

| Hook                    | Event                     | What it does                                                                    | Agent action needed?                         |
| ----------------------- | ------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------- |
| `user_prompt_submit.py` | `UserPromptSubmit`        | Auto-records operator text to physarum CLI + injects "remember to log" reminder | No — operator text is auto-logged            |
| `stop_guard.py`         | `Stop`                    | Injects end-of-session ritual reminder                                          | Agent should complete ritual before stopping |
| `post_exec_log.py`      | `PostToolUse(exec)`       | Logs exec command outcomes to exec_log.jsonl + physarum                         | No — auto-logged                             |
| `post_edit_lint.py`     | `PostToolUse(edit/write)` | Runs eslint on edited .ts/.tsx files, injects errors as context                 | No — auto-linted                             |
| `pre_exec_guard.py`     | `PreToolUse(exec)`        | Blocks PowerShell anti-patterns + queries physarum for past lessons             | No — auto-guarded                            |

## What is auto vs manual

| Data                         | Auto (hook)             | Manual (agent)                                                                     |
| ---------------------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| Operator text (every prompt) | `user_prompt_submit.py` | —                                                                                  |
| Exec command outcomes        | `post_exec_log.py`      | —                                                                                  |
| ESLint errors on edit        | `post_edit_lint.py`     | —                                                                                  |
| CLI proxy metrics            | —                       | `affect_record(query="CLI proxy", ...)` every 15-30 min                            |
| LLM output                   | —                       | `affect_record(query="LLM responded with: ...", ...)` after each LLM call          |
| Feedback (strategy change)   | —                       | `affect_record(query="feedback", ...)`                                             |
| EMA (operator self-report)   | —                       | `ask_user_question` + `affect_record(query="record EMA", ...)`                     |
| Rubric (session quality)     | —                       | `ask_user_question` + `affect_record(query="record rubric", ...)`                  |
| Session report               | —                       | `affect_session(query="session report")` + SuperMemory + Memory MCP + progress.txt |

## During the session

**Record EMA** (operator self-report, 1-5 scale each):

```
affect_record(query="record EMA", valence=5, focus=5, frustration=1, fatigue=1, trust=5, source="operator_self_report")
```

Fields: `valence`, `arousal`, `dominance`, `focus`, `frustration`, `fatigue`, `trust` (all 1-5 int).

**Record rubric** (session quality, 1-5 scale each):

```
affect_record(query="record rubric", task_completion=5, operator_satisfaction=5, groundedness=5, conversation_coherence=5)
```

**Record CLI proxy** (agent behavior metrics):

```
affect_record(query="CLI proxy", tool_call_density_per_min=8, time_since_success_s=30, error_rate=0.0, retry_burst_count=0, session_length_min=45)
```

**Record LLM output** (per LLM call):

```
affect_record(query="LLM responded with: ...", text="the response", tool_calls=["read","exec"], outcome=true)
```

**Record feedback** (after strategy changes):

```
affect_record(query="feedback", trigger_emotion="frustrated", strategy="brief", reward=0.8, outcome="positive")
```

## End of session (mandatory ritual)

**Every session ends with this sequence — do not skip, do not let the operator forget:**

### Step 1: Rubric (interactive, via `ask_user_question`)

Ask the operator 4 rubric questions with clickable answers (1-5 scale, 4 options + "Other"):

```
ask_user_question(
  questions=[
    {
      question: "Rubric: Task Completion — how well did the task get done?",
      header: "Task Completion",
      options: [
        {label: "5 — Fully complete", description: "All requirements met, verified, tests pass"},
        {label: "4 — Mostly complete", description: "Minor gaps remaining"},
        {label: "3 — Partially complete", description: "Core work done, significant gaps"},
        {label: "2 — Barely started", description: "Most work remaining"}
      ]
    },
    {
      question: "Rubric: Operator Satisfaction — how satisfied are you with the session?",
      header: "Satisfaction",
      options: [
        {label: "5 — Very satisfied", description: "Exactly what I wanted, smooth process"},
        {label: "4 — Satisfied", description: "Good outcome, minor friction"},
        {label: "3 — Neutral", description: "Got there but with issues"},
        {label: "2 — Frustrated", description: "Process problems, rework needed"}
      ]
    },
    {
      question: "Rubric: Groundedness — were all claims and changes evidence-based?",
      header: "Groundedness",
      options: [
        {label: "5 — Fully grounded", description: "Every change verified against code/docs, no assumptions"},
        {label: "4 — Mostly grounded", description: "Minor assumptions, all verified post-hoc"},
        {label: "3 — Some guesses", description: "A few unverified claims, corrected when caught"},
        {label: "2 — Too much speculation", description: "Multiple ungrounded assertions"}
      ]
    },
    {
      question: "Rubric: Conversation Coherence — did the agent stay on track?",
      header: "Coherence",
      options: [
        {label: "5 — Perfectly coherent", description: "No tangent, no confusion, clear progression"},
        {label: "4 — Mostly coherent", description: "Minor detours, recovered quickly"},
        {label: "3 — Some confusion", description: "Lost context once or twice"},
        {label: "2 — Frequently lost", description: "Repeated context loss or tangents"}
      ]
    }
  ]
)
```

### Step 2: EMA (interactive, via `ask_user_question`)

Ask the operator for their current affective state (1-5 scale, 4 options + "Other"):

```
ask_user_question(
  questions=[
    {
      question: "EMA: Valence (1=very negative, 5=very positive) — how do you feel right now?",
      header: "Valence",
      options: [
        {label: "5 — Very positive", description: "Great mood, energized"},
        {label: "4 — Positive", description: "Good mood, productive"},
        {label: "3 — Neutral", description: "Neither positive nor negative"},
        {label: "2 — Negative", description: "Frustrated or annoyed"}
      ]
    },
    {
      question: "EMA: Focus (1=distracted, 5=deeply focused) — how focused are you?",
      header: "Focus",
      options: [
        {label: "5 — Deep focus", description: "Fully absorbed, flow state"},
        {label: "4 — Focused", description: "On task, minor distractions"},
        {label: "3 — Moderate", description: "Some context switching"},
        {label: "2 — Distracted", description: "Hard to stay on task"}
      ]
    },
    {
      question: "EMA: Frustration (1=none, 5=very high) — how frustrated are you?",
      header: "Frustration",
      options: [
        {label: "1 — None", description: "No frustration at all"},
        {label: "2 — Slight", description: "Minor annoyance"},
        {label: "3 — Moderate", description: "Some friction, but manageable"},
        {label: "4 — High", description: "Significantly frustrated with process"}
      ]
    },
    {
      question: "EMA: Trust (1=no trust, 5=full trust) — how much do you trust the agent?",
      header: "Trust",
      options: [
        {label: "5 — Full trust", description: "Agent did exactly what I needed"},
        {label: "4 — Trust", description: "Reliable, minor doubts"},
        {label: "3 — Cautious", description: "Some verification needed"},
        {label: "2 — Skeptical", description: "Needed to double-check most outputs"}
      ]
    }
  ]
)
```

### Step 3: Record to physarum-learning MCP

Use the operator's answers from Steps 1-2:

```
affect_record(query="record rubric", task_completion=<answer>, operator_satisfaction=<answer>, groundedness=<answer>, conversation_coherence=<answer>)
affect_record(query="record EMA", valence=<answer>, focus=<answer>, frustration=<answer>, trust=<answer>, source="operator_self_report")
```

### Step 4: Generate session report

```
affect_session(query="session report")
```

Returns: Bayesian trajectory, temporal regime (SSM: flow/calm/turbulent), CLI history, feedback summary, LLM agent state, calibration pack, shadow policy recommendation.

### Step 5: Log to progress.txt + SuperMemory + Memory MCP

**Log to progress.txt** (one-liner, append):

```
Physarum: SuperMemory session report + Memory MCP N entities + N relations.
EMA: V=5, A=4, D=5, Focus=5, Frustration=1, Fatigue=2, Trust=5. Rubric: 5/5/5/5. SSM: flow.
```

**Log to SuperMemory** via `supermemory_mcp` `add_memory` — full session report with metadata `{"topic": "physarum-session", "type": "session_log"}`.

**Log to Memory MCP** via `memory` `create_entities` + `create_relations` — key decisions, gotchas, patterns for next instance.

**Important:** The rubric + EMA interactive questions (Steps 1-2) are mandatory. Do not skip them. Do not log without asking the operator first. The operator wants to click answers, not type them.

## Query past sessions

```
affect_query(query="EMA history")          # past EMA records
affect_query(query="rubric history")       # past rubric scores
affect_query(query="SSM state")            # current temporal regime
affect_query(query="calibration")          # ECE, Brier, AUROC
affect_memory(query="recall: debugging a database issue", text="debugging a database issue")
```

## When to log

| Event                 | Tool                                                                | Frequency                  |
| --------------------- | ------------------------------------------------------------------- | -------------------------- |
| Operator reports mood | `affect_record` EMA                                                 | When operator shares state |
| Session quality check | `affect_record` rubric                                              | Mid-session + end          |
| LLM call completes    | `affect_record` LLM                                                 | Every LLM call             |
| CLI behavior changes  | `affect_record` CLI                                                 | Every 15-30 min            |
| Strategy change       | `affect_record` feedback                                            | After adapting approach    |
| Session end           | `affect_session` report + `progress.txt` + SuperMemory + Memory MCP | Always                     |
