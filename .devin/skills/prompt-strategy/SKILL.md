---
name: prompt-strategy
description: Prompt clarity strategy — direct language produces better LLM results than eloquent phrasing
---

## Prompt Clarity Strategy

### Principle

LLMs produce higher-quality results when prompts use **simple, direct, structurally precise language** rather than eloquent or complex phrasing.

### Why

- Training data is dominated by simple, direct text — the model's attention mechanism maps these patterns more reliably
- Complex sentence structures (nested clauses, rhetorical questions, indirect requests) increase token count and ambiguity
- Eloquent phrasing obscures intent — the model must infer what is actually being asked
- Simple phrasing is not "dumb" — it is **high-precision specification**

### Rules for prompting Cascade (and any LLM)

1. **Be direct** — "Summarize these 3 docs into 5 bullet points" beats "Would you be so kind as to provide a comprehensive overview..."
2. **Be structural** — Specify format explicitly: bullets, tables, numbered lists, code blocks
3. **Be concrete** — Name files, functions, line numbers. No vague references.
4. **Be short** — Fewer tokens = less noise = better signal extraction
5. **Be sequential** — Break complex requests into steps. One clear instruction per sentence.
6. **No politeness padding** — "Please", "could you", "I would appreciate" add tokens without information
7. **State the goal, not the journey** — "Create a Wilson CI function" beats "I was thinking maybe we could explore implementing some kind of confidence interval calculation"

### Anti-pattern

```
Bad:  "I was wondering if perhaps you might consider looking into the possibility of
       enhancing the firewall system to maybe include some form of uncertainty
       quantification, if that's not too much trouble?"

Good: "Add firewall_classify() with Wilson CI to firewall_bridge.py. Return ALLOW/ABSTAIN/BLOCK."
```

### Application to WorldBase

- Operator instructions to Cascade: keep them short and structural
- System prompts in `chat_proxy.py`: prefer direct directives over elaborate descriptions
- Briefing generation prompts: structured templates, not prose
- Agent prompts in `agent_blackboard.py`: explicit role + task per phase, no narrative
