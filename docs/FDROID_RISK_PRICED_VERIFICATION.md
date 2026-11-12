# Risk-Priced Verification for the F-Droid Review Lane

**Status:** Design document — not yet implemented. Written 2026-10-19 after R39 (devin-direct round), in response to the operator's question whether collapsing the Scout→Reviewer→Devin chain under budget pressure is harmful, and the follow-up request to find prior solutions in the literature.

**Revision v2 (2026-10-19):** incorporates a post-draft 2026-literature re-check (external review; load-bearing citations tool-layer verified by the generator — arXiv-ID resolution + title/author match; generator-side verification, not independent). Changes: new §3.5; amended §4.3 (timing trigger), §5.2 (blind eval downgraded to partial mitigation), §5.3 (different-family default with explicit competence tradeoff), §6 (failure-mode refinement), §9 (new citations).

**Scope:** This document (1) states the problem precisely, (2) reviews the relevant literature completely, (3) maps findings onto the lane, (4) proposes a concrete design, (5) lists failure modes, and (6) defines the implementation plan pending operator approval. Nothing in this document changes current lane behavior.

---

## 1. Problem statement

### 1.1 The lane's intended pipeline

```
Scout ──► Reviewer ──► Devin/Executor ──► Human gate
(pick,    (independent   (device tests,     (explicit GO
dedup,    re-check,      posting,          before any
packs+    sanity pass)   artifacts)        external action)
drafts)
```

- **Scout** (zcode/agents): selects `review-requested` MRs, checks `COVERED.txt` dedup, collects static evidence, writes evidence packs + note drafts.
- **Reviewer** (a different agent/model): re-validates the scout's evidence and reasoning before anything is presented or posted.
- **Devin/Executor** (this agent): runs device tests, PCAP captures, additional verification, posts notes only under explicit gates.
- **Human** (operator): final authority; owns every external mutation.

### 1.2 What happened in R39 (2026-10-19)

Budget pressure made the full chain unavailable (Scout/Reviewer credits depleted). The operator delegated a collapsed pipeline: **Devin performed scout + reviewer + executor roles end-to-end** on four MRs (`!50916`, `!52240`, `!52249`, `!52412`). All four reviews completed with full evidence and were posted after an explicit delegated GO.

The operator's question: _"Ist es schlimm, wenn wir manchmal diese Kette brechen?"_ — Is it harmful to break this chain when credits run out?

### 1.3 The honest answer, stated up front

Breaking the chain removes exactly one control: **independent (decorrelated) re-examination by a different model.** Everything else the chain provides — evidence artifacts, posting gates, dedup, boundary honesty — is artifact- or process-level and survives the collapse. The literature (Section 3) shows this removed control is real, measurable, and known-weak when replaced by self-review — but also that the field's established answer to budget pressure is **not** "skip verification"; it is **"price verification by risk and run it on the cheapest _different_ model."**

### 1.4 Research question as searched

> How do LLM-agent pipelines preserve verification quality when one model/instance both generates and judges — and how should verification budget be allocated under cost constraints?

---

## 2. What the chain's separation actually buys

Two distinct functions, worth separating because the collapse costs them differently:

### 2.1 Independence of error correlation

A reviewer that is a _different model_ has different blind spots, different memorized patterns, different failure modes. When the same instance both collects evidence and judges it, every error in collection propagates silently into the verdict. Concrete lane example: a bug in `dexscan.py` would corrupt **both** the "endpoint" claim in the pack **and** the verdict derived from it — invisible to a same-instance re-read.

### 2.2 Discipline enforcement

The reviewer is the instance that asks "did you actually check X, or did you pattern-match?" before artifacts leave the building. Self-review preserves the _form_ of this question but not its adversarial force — the generating context already "knows" what it meant to do.

### 2.3 What does NOT depend on the chain

- **Tool-grounded evidence** (`apksigner`, `aapt`, PCAPdroid, dropbox, CI traces, GitHub/GitLab APIs): deterministic, re-runnable by anyone, model-independent.
- **Process gates** (`POST_APPROVED.flag`, explicit IID, file-based bodies, roundtrip verification).
- **Dedup ledger** (`COVERED.txt`).
- **Honest-boundary vocabulary** (`NO_TRAFFIC_OBSERVED_IN_TESTED_WINDOW`, `PATH_NOT_REACHED`, `CAPTURE_UNHEALTHY`, `TRAFFIC_OBSERVED`).
- **External check of last resort**: F-Droid maintainers read every note; `linsui` merges or does not.

The R39 round demonstrated this asymmetry directly: the one novel finding (Karasu's cold-start SIGABRT) came from the **tool layer** (system dropbox), not from agent judgment — while the self-review risk sat precisely on the judgment side (verdicts, interpretation).

---

## 3. Literature review

The literature splits into three clusters: (A) limits of self-verification, (B) self-preference and judge bias, (C) budget-adaptive verification systems — the near-solution cluster.

### 3.1 Cluster A — Self-verification has documented, measurable limits

**[A1] Stechly et al., "On the Self-Verification Limitations of Large Language Models on Reasoning and Planning Tasks" (arXiv:2402.08115)**

The canonical paper. Principled empirical study of GPT-4 in Game-of-24, Graph Coloring, and STRIPS planning, comparing same-model iterative self-critique (LLM+LLM) against external sound verifiers.

Key findings:

- "Significant performance collapse with self-critique and significant performance gains with sound external verification."
- The popular assumption "verification should be easier than generation" — a classical complexity argument — **fails for LLMs**, because what they do is approximate retrieval, not algorithmic checking.
- Critically actionable: "**merely re-prompting with a sound verifier maintains most of the benefits** of more involved setups." The gain comes from the verifier's soundness, not the pipeline's sophistication.

**Lane mapping:** our tools ARE sound external verifiers. A cheap-but-different model sanity pass approximates the remainder.

**[A2] Stechly et al., "Can Large Language Models Really Improve by Self-critiquing Their Own Plans?" (arXiv:2310.08118)**

Planning-domain follow-up: GPT-4 verifier vs. ground-truth verification. Findings: self-critique _diminishes_ plan-generation performance relative to external verifiers; LLM verifiers produce a notable rate of **false positives**; feedback granularity (binary vs. detailed) has minimal effect — i.e., verbosity doesn't rescue a weak verifier.

**Lane mapping:** a self-review that emits detailed-sounding critiques is not thereby reliable. Detail is not soundness.

**[A3] "Benchmarking and Improving Generator-Validator Consistency of LMs" (ICLR 2024)**

Introduces GV-consistency: does a model's validation agree with its own generation? Canonical example: ChatGPT answers "7+8" with 15, then judges "7+8=15, True or False" as False. GPT-4 is GV-consistent only ~76% of the time. Consistency fine-tuning improves both generator and validator.

**Lane mapping:** even absent bias, same-model generate-then-verify is noisy _mechanically_. The inconsistency exists in the model itself.

**[A4] "A Closer Look at the Self-Verification Abilities of LLMs in Logical Reasoning" (NAACL 2024, FALLACIES dataset)**

4,640 reasoning steps across 232 fallacy types: models "struggle to identify fallacious reasoning steps accurately and may fall short of guaranteeing the validity of self-verification methods."

**Lane mapping:** structured-argument errors (the kind hiding in a 4KB evidence pack) are exactly where self-verification is weak.

**[A5] "Learning to Self-Verify Makes Language Models Better Reasoners" (PMLR v306)**

Asymmetry across training: improving generation does **not** improve self-verification; but training self-verification improves generation. Generation→verification is the broken direction.

**Lane mapping:** a stronger scout does not become a stronger reviewer for free. Capability does not substitute for independence — consistent with the routing result in [C3]/[C4] that _differentness_, not size, is what a second model buys.

### 3.2 Cluster B — Self-preference and judge bias

**[B1] "LLM Evaluators Recognize and Favor Their Own Generations" (arXiv:2404.13076)**

LLMs identify their own outputs with non-trivial accuracy and score them higher; fine-tuning shows **self-recognition linearly correlates with self-preference**. The bias has a causal, not coincidental, mechanism.

**[B2] "Do LLM Evaluators Prefer Themselves for a Reason?" (arXiv:2504.03846)**

The nuance paper, using verifiable benchmarks to split legitimate from harmful self-preference:

- Most self-preference in strong models tracks genuinely better output — legitimate.
- **Harmful self-preference persists exactly where the generator erred** — and is _more pronounced_ in stronger models. Models are worst at detecting their own errors precisely where detection matters most.
- Mitigation found: **long chain-of-thought before evaluation reduces harmful self-preference.**

**Lane mapping:** the lane's receipt-block convention (question/observed/source/interpretation/boundary/evidence_index written _before_ the verdict) is a forcing function in exactly this direction — evidence-then-judgment as generated structure. Keep it; it's the cheapest in-model mitigation that exists.

**[B3] "Self-Preference Bias in LLM-as-a-Judge" (arXiv:2410.21819)**

Mechanism study: evaluators assign higher scores to low-perplexity (familiar) text regardless of actual authorship. Familiarity is the bias substrate.

**[B4] "Quantifying Label-Induced Bias in LLM Self- and Cross-Evaluations" (arXiv:2508.21164)**

Controlled label-swap experiment across ChatGPT/Gemini/Claude: perceived model _identity_ distorts scores by up to 50pp in voting and 12pp in ratings, independent of content. Recommendation: **blind evaluation protocols** and multi-model validation.

**Lane mapping:** when a cheap model cross-reviews a pack, strip the generator's identity (no "devin wrote this", no lane-internal labels that signal authorship). Blind evaluation is a documented, free mitigation.

**[B5] "MLLM-as-a-Judge Exhibits Model Preference Bias" (arXiv:2604.11589)**

Preference bias exists at _model-family_ level — likely driven by shared connectors and instruction-tuning data. Ensembling across families (Pomms) mitigates it.

**Lane mapping:** "different model" must mean different _family_, not a sibling build of the same lineage.

### 3.3 Cluster C — Budget-adaptive verification: the near-solutions

This is where the literature directly answers "I sometimes have no credits."

**[C1] CAVR-MAS — "Adaptive Verification and Confidence-Aware Routing for Reliable Multi-Agent LLM Reasoning" (IJAIES)**

The most direct formalization of the operator's problem. A control framework for multi-agent systems that, per subtask node, estimates: calibrated correctness, path disagreement, downstream propagation risk, task criticality, and **verification cost** — then selects among:

```
no check → critique → cross-agent checking →
evidence-grounded checking → re-decomposition
```

by **maximizing estimated error reduction per unit cost**, under a budget-adaptive controller. Includes provable properties: one-step Bayes optimality, routing-regret bound, monotone verification workload vs. threshold, cumulative budget bound, consistency of reliability memory.

**Why it matters here:** the lane's collapsed-chain question is literally CAVR-MAS's design space. Its answer: never "always verify" or "never verify" — pick the _verification level_ per node by risk÷cost.

**[C2] JOVE — "Joint Execution and Verification for Resource-Aware LLM Task Graphs" (arXiv:2610.03296)**

Online framework assigning executor LLMs AND selecting which intermediate outputs receive **paid verification**, under long-term budget + per-query latency. Per-query MILP; verification feedback updates quality estimates; sublinear learning regret. Result: **competitive accuracy at ≥3.17× lower average cost and latency.**

**Why it matters:** proves selective verification under hard budget is not a compromise but an _optimized strategy_ — you don't lose accuracy by verifying selectively if selection is risk-aware.

**[C3] "A Unified Approach to Routing and Cascading for LLMs" (arXiv:2410.10347, ETH-SRI)**

Formal theory of routing (pick one model per query) vs. cascading (escalate until satisfied). Derives optimal cascade strategy, unifies both into provably-optimal "cascade routing." Key structural finding: **quality estimators are the critical factor** — the system is only as good as its estimate of "was this answer good enough."

**Lane mapping:** our quality estimator is cheap and good: the evidence-key structure + badging/pcap artifacts make "is this claim supported" mechanically checkable, unlike free-form QA.

**[C4] "Learning to Route" (GitHub: lee101/learning-to-route)**

Engineering-scale proof: verify-and-escalate cascade over four cheap models solves **100% of tasks at 26% of best-single-model cost** (4% of frontier cost). Router = static-embedding ANN index + EWMA online learning; escalation to expensive models is the _learned exception, not the default._

**Lane mapping:** the reviewer does not need to be the best available model — it needs to be the cheapest model that is _different_. Escalation (full reviewer / human) fires on risk, not routine.

**[C5] hasna/swarm (GitHub: hasna/swarm)**

Production orchestration framework implementing exactly this pattern: task DAG → tiered agents → **actor/verifier loop** where a workhorse produces and a frontier model approves before acceptance → cross-agent **budget governor** that halts at ceiling.

**Lane mapping:** existence proof that "budget governor + actor/verifier tiers" is a shipped pattern, not a paper abstraction. Our `POST_APPROVED.flag` is already the human-side governor; the missing piece is the cheap mid-tier verifier.

### 3.5 Post-draft 2026 update — corrections and reinforcements

A follow-up pass over 2026 literature surfaced six works that modify or strengthen the above. All load-bearing claims below were verified against the actual papers.

**[U1] Roytburg et al., "Are LLM Evaluators Really Narcissists? Sanity Checking Self-Preference Evaluations" (arXiv:2601.22548, ICML 2026)** — a statistical sanity-check of the self-preference literature: after controlling for **evaluator quality** (judges may self-prefer on questions they themselves fail at), only **51% of previously "significant" results survive, covering 89.6% of the self-preference probability mass.** Most reported self-preference is plausibly competence noise, not identity bias.

Consequence: "different family" is weakened from axiom to _default_. If bias is largely a competence problem, a **more capable same-family auditor may beat a weaker different-family one** — the tradeoff should be explicit, not forbidden (§5.3).

**[U2] "Mitigating Self-Preference by Authorship Obfuscation" (arXiv:2512.05379, AAAI 2026)** — black-box perturbations (e.g., synonym replacement of a few words) _predictably reduce_ self-preference — but **more complete stylistic neutralization makes self-preference recover.** Self-recognition operates on many semantic levels; complete mitigation remains unsolved.

Consequence: blind evaluation (§5.2) is a **partial mitigation, not a solution.** Keep it — it is free and reduces bias — but the residual-risk backstop stays the tool layer + human GO, not the blinding.

**[U3] "Breaking the Mirror: Activation-Based Mitigation of Self-Preference in LLM Evaluators" (arXiv:2509.03647, NeurIPS 2025 Reliable ML Workshop)** — inference-time steering vectors reduce _unjustified_ self-preference by up to **97%**, beating prompting and DPO — but are unstable on legitimate self-preference (bias spans multiple/nonlinear directions). Immature, but a path to intra-model debiasing if it matures — noted for completeness, not part of the design.

**[U4] "The Hallucination Snowball: Modeling Error Propagation as State Transitions in Multi-Agent LLM Pipelines" (arXiv:2608.14588)** — hallucinations injected at stage 1 _transform_ across handoffs (Raw Fact → Derived → Narrative → Invisible) with per-boundary escape probabilities 24.6% / 48.3% / 89.3%; **23.7% survive completely undetected** in final output. **Boundary gates cut survival 58.4%→16.2%, while end-of-pipeline checking improves over no verification by only 2.3pp.** Core claim: "**when you verify matters more than whether you verify**" — invest at the earliest catchable boundary.

Consequence: new trigger dimension for §4.3 — the _pipeline position_ where a judgment is made (evidence-annotation vs. note-phrasing) determines how catchable an error is. Errors in Scout-stage evidence annotation are the highest-value cross-check targets because they are still pre-transformation.

(Adjacent: "Delayed Verification Destabilizes Multi-Agent LLM Belief", arXiv:2606.27409 — verification dose/delay can destabilize consensus; grounded verification remains stabilizing. Supporting evidence for early placement.)

**[U5] "Verify-Gated Fan-Out: Measuring the Cost-Quality Pareto Frontier of Adversarial Verification" (July 2026)** — production-harness measurement across 27 verifier-tier × breadth × threshold configurations with seeded ground truth: **the cheapest tier (Haiku, N=1 skeptic, $3.46) is the sole Pareto-optimal configuration**; Opus is never optimal and can cost 15.66× for worse hallucination suppression. Also: more skeptics can _worsen_ safety under majority rules (Condorcet-style vote dilution when per-skeptic recall <50%).

Consequence: direct empirical support for "cheapest different model + single skeptic" as the default cross-check configuration — and a caution against adding parallel cheap reviewers under majority voting (dilution, not amplification).

**[U6] "Chain-of-Models: Cross-Model Auditing for Bias-Robust LLM Judges" (arXiv:2607.28636)** — systematic study of same-model vs. same-family vs. different-family auditors on reasoning-trace auditing: **cross-family beats same-family** (which only moderately improves over self-audit) — _and_ the best auditor is **bias-specific** (GPT-4o strongest on bandwagon/authority/distraction; **GLM-5 strongest on sycophancy**). A per-bias selector beats any fixed auditor (0.884 vs 0.824 vs 0.805 no-audit).

Consequence: independent 2026 confirmation that different-family remains the right _default_ — plus a notable detail for our lane: **GLM is specifically strong at sycophancy-auditing**, the bias most relevant when a model reviews its own advocacy-style verdicts. Supports `zai-glm` as the default cross-check model.

**[U7] Yuhao Lin, "The Prose Barrier: Structural Limits of Agent Self-Verification and a Five-Layer Configuration Integrity Architecture" (Zenodo preprint v2, 2026-08-14, Fujian Agriculture and Forestry University — self-described "independent undergraduate work, no supervisor, no funding"; not peer-reviewed)** — structural argument stronger than [A1]: generation and self-evaluation **share the same decoder distribution** `P(token|context; θ)`, so an LLM cannot independently verify compliance — "it can only generate a claim that it did." Proposes a layered architecture with **Type-D (deterministic: regex, timestamps, exit codes) vs. Type-P (probabilistic: LM) verifiers** forming mutual-suspicion loops. Notable empirical datapoint across 34 sessions/16 experiments/3 architectures: **mechanical gates (L1) cut rule violations 55.9% → 0.7% while operating entirely outside the Barrier** — filesystem checks, no model judgment. Cited as articulation + a suggestive (single-author, unreviewed) empirical result, not as authority.

Consequence: sharpened framing of what our lane already does — the tool layer _is_ the Type-D side of exactly this architecture; the RPV cross-check is the Type-P side. The Prose Barrier says Type-P can never be load-bearing alone — consistent with §5.5's "tool layer stays mandatory."

**[U8] "Pre- versus Post-Action Verification: Measuring the Safety-per-Dollar Frontier of Gating versus Auditing in Autonomous K8s Agent Loops" (ThakiCloud AI Research, Sept 2026, technical report)** — formalizes verifier _placement_ as an independent design axis with a per-action cost model: at equal call price a pre-action gate dominates a post-action audit (an audit recall point is worth ~0.68 of a gate recall point); the audit's incremental value collapses as gate precision rises ($17.30/action at gate recall 0.60 vs $1.28 at 0.97); both-placement is the optimal interior. Honest caveat from the authors: no live measurements — illustrative scenarios + a falsifiable protocol. Adjacent to [U4]: where [U4] says _early_ verification wins, [U8] prices _pre-action vs. post-action_ explicitly — our posting gate IS the pre-action gate; the cross-check is a pre-posting audit.

**[U9] "Against Ungrounded 'Done': Risk-Limiting Completion Certificates for LLM Agents" (TU Eisenfeld Working Paper, Zenodo, Sept 2026 — not peer reviewed)** — argues completion claims should be **inadmissible without a verifiable evidence certificate**, combining action receipts, randomized audits, and calibrated language; simulates lower verification cost than exhaustive transcript inspection. Adjacent in spirit — honestly delimited: U9's core contribution is _risk-limiting_ (certificates carrying statistical guarantees on claim error rates); our `evidence_key` + `boundary:` records are a _traceability_ scheme — same instinct (no ungrounded "done"), weaker mechanism, no statistical bound. The paper's "against ungrounded done" thesis also mirrors the lane's pre-completion completeness rule.

**[U10] "Less Verification Is Safer" (ThakiCloud, 2026-07-11, companion analysis of U5 — technical report, not peer-reviewed)** — same dataset sliced by _aggregation rule_: strict-veto (any skeptic refutes → discard) was the **only** rule with 0% hallucination survival across all tiers and headcounts; "unanimous" sounded safest but was the most fragile (0.167 survival at Opus N=3/N=5); majority sits in between and dilutes. Cost side: strict veto at Haiku tier had 0.833 true-finding survival — noise-driven false vetoes exist and must be absorbed. For RPV: upgrades "single skeptic" from a cost argument to a _safety_ argument, and our NEEDS-CHANGE-flags-operator design is exactly the absorption mechanism for false vetoes. Same small-corpus caveat as U5 applies.

**[U11] Xu & Wu, "Mitigating LLM Hallucination Snowballing in Multiagent Systems via Context-Aware Semantic Consistency Reasoning" (IEEE TNNLS, 2026-01-28 — peer-reviewed)** — U4's mitigation-side complement: token-level semantic-consistency checking (bidirectional entailment clustering) at handoff boundaries, far cheaper than a full LLM cross-check. For RPV: a candidate **middle tier** between tool layer and full cross-model check — if the pilot shows GLM's sanity pass over-triggers or is too noisy, this class of check is the fallback before going quiet.

**[U12] "Clean Engineering, Unstable Measurement: A Preregistered Reliability Failure of Black-Box LLM Observers on Shared Endpoints" (arXiv:2609.04198, Sept 2026 — preregistered study; the authors self-describe the analysis as an "exploratory measurement-error and request-scale diagnostic, not an executed experiment")** — treats the LLM judge as a _measurement instrument_ and measures its reliability: same-window repeat rankings agreed at Spearman 0.400 vs a required 0.90; byte-identical next-day replays at 0.78 vs 0.99; four providers in three jurisdictions share the noise floor (0.74–0.88) predicted by no exposed metadata. For RPV: **the cross-check model is itself a noisy instrument** — a `## Cross-check` block's _existence_ is not evidence of verification; its _content_ must remain operator-spot-checkable, and a single verdict is one noisy draw, not a measurement.

### 3.6 What the literature says collectively (updated)

1. **Self-review is the weakest verification mode** — measurably worse than external verification, biased toward the generator's own output, worst exactly where the generator errs ([A1],[A2],[B1],[B2]), and — per the strongest framing — _architecturally_ bounded by the shared decoder ([U7]).
2. **The winning substrate is sound external verification, not smarter prompting** — "re-prompting with a sound verifier maintains most of the benefits" ([A1]); tool-grounded checks are that verifier made concrete ([U7]'s Type-D).
3. **Independence is what a reviewer buys — with nuance.** Family-difference remains the right default ([B5],[C4],[U6]), but ~half of classic self-preference findings may be competence noise, not identity bias ([U1]): when the capability gap is large, a stronger same-family auditor can outperform a weaker different-family one — choose explicitly, don't forbid.
4. **Cheapest-tier + single skeptic is empirically Pareto-optimal** for adversarial verification ([U5]); more skeptics under majority voting can _worsen_ safety via vote dilution, and aggregation rule dominates headcount — strict-veto was the only 0%-survival rule, unanimous the most fragile ([U10]). Cheapness is not a compromise here — it's the frontier.
5. **Verification budget should be allocated by risk — and by pipeline position.** Risk-aware selection loses little/no accuracy ([C1],[C2],[C4]); _timing_ matters as much as _whether_ — errors are most catchable at the earliest boundary, near-invisible by the end ([U4]).
6. **Cheap free mitigations exist but are partial** — blind evaluation reduces but cannot eliminate self-recognition ([B4],[U2]); evidence-before-verdict forcing helps ([B2]); activation-level debiasing is promising but immature ([U3]). The residual-risk backstop remains tool evidence + human gates.
7. **Auditor choice should be bias-aware** — GLM is specifically strong at sycophancy-auditing, the failure mode most relevant when a model audits advocacy-shaped verdicts ([U6]).
8. **The cross-check is itself a noisy instrument** — preregistered study: LLM observers fail reliability thresholds even on byte-identical inputs; the noise floor is shared across providers ([U12]). Every verdict is one draw — keep content spot-checkable, never treat block-presence as proof of verification.

---

## 4. Mapping onto the F-Droid lane

### 4.1 Decompose the chain by verification type, not role

| Layer            | What it checks                                                       | Sound verifier?              | Cost                  | In the lane today               |
| ---------------- | -------------------------------------------------------------------- | ---------------------------- | --------------------- | ------------------------------- |
| Tool evidence    | hashes, signers, badging, endpoints, tombstones, CI traces, tag==pin | Yes — deterministic tools    | ~0                    | ✅ mandatory already            |
| Process gates    | dedup, flag, file-bodies, roundtrip, head re-verify                  | Yes — scripts/API            | ~0                    | ✅ mandatory already            |
| Boundary honesty | capture health, PATH_NOT_REACHED, empty-claim anchoring              | Mostly — canary + vocabulary | ~0                    | ✅ mandatory already            |
| Judgment review  | interpretation, verdicts, "is this mergeable", nit framing           | No — needs a mind            | High if full Reviewer | ⚠️ collapses first under budget |

The collapse in R39 only affected the bottom row. The literature's answer: the bottom row doesn't need a full Reviewer — it needs a **risk-priced, different-family sanity check**.

### 4.2 Case study: Karasu `!52249` (R39)

- **Finding:** first cold launch → SIGABRT in `Rust_ipc`/`JavaBridge` (dropbox tombstone, 1.7s uptime), self-recovered, then healthy + zero-packet capture.
- **Caught by:** tool layer (dropbox), not judgment. Would exist identically under the full chain.
- **Where self-review risk lived:** the _verdict_ ("mergeable with a note to the author") — interpretation, not evidence.
- **CAVR-MAS reading:** this node was the round's highest-risk judgment call → under risk-priced verification it is precisely where a cheap cross-model check should fire. Cost ≈ a few K tokens.

### 4.3 Risk triggers for the judgment layer

A note/pack escalates to cross-model review when ANY of:

1. **Ambiguous or mixed findings** — e.g., crash-but-recovers, permission sets with partial justification, borderline AF cases.
2. **Agent-judgment-heavy notes** — verdicts that go beyond artifact restatement (mergeable/not-mergeable calls, harm assessments).
3. **High-volume rounds** — >~5 MRs per session. Reframed per the irreversibility-budget result (arXiv:2609.00275): the load that matters is not only generator fatigue but **cumulative judgment-layer volume against the human gate's attention budget** — per-note checks can each pass while the round as a whole overdraws what the operator can meaningfully adjudicate (their controlled study: per-effect gates admitted fleet overdraws up to 48× the risk limit). Candidate metric if ever needed: count of _judgment-bearing_ notes/flags per round, not just MR count.
4. **Novel stacks or recipe shapes** — first-seen build systems, unusual pinning, new verifier paths.
5. **Sensitive-surface apps** — SMS/contacts/phone-state permissions, NonFreeNet/Tracking AFs, updater surfaces.
6. **Anything the posting decision hinges on** — last gate before external mutation.
7. **Reviewer-disagreement history** — MR authors who previously contested notes.
8. **Pipeline-position risk (added v2, per [U4])** — judgments made at _early, pre-transformation_ nodes are the most catchable and therefore highest-value checks: an error in Scout-stage evidence annotation (wrong endpoint table, misread trace, misattributed permission) is still a raw fact and cheap to catch there; by note-writing time it has been narrativized and is near-invisible (89.3% escape probability at the last boundary). When budget forces a single check, prefer the **earliest judgment node that is not already tool-verified** — typically evidence interpretation at pack stage — over prose polish at draft stage.

None of these fired on the four R39 static checks; #2 and #6 fired on Karasu's verdict line — which is why this document exists.

**Narrowing lens (added v3, per [U7]'s L1 datapoint):** mechanical gates alone cut rule violations 55.9%→0.7% _outside_ the Barrier — so Type-P marginal value is smallest exactly where mechanical checks already cover the claim. Read the trigger list through this lens: fire when the **judgment content exceeds what any mechanical check could cover** (interpretation, verdicts, mergeability), not when a note merely contains prose. Triggers #1, #2, #5 are intentionally broad but should be applied to _uncovered_ judgments, not to judgment-flavored text in general.

### 4.4 What was lost in R39 and how it was compensated (post-mortem)

| Control                      | Status in R39 | Compensation applied                                                                                |
| ---------------------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| Independent model review     | Lost          | Evidence-before-verdict forcing; live head re-verification before posting; explicit delegated GO    |
| Reviewer discipline question | Weakened      | Pre-completion checklist; self-reported boundaries (PATH_NOT_REACHED etc.)                          |
| Adversarial re-read          | Weakened      | Packs written facts-first; every claim carries an artifact pointer (trace line, hash, tombstone ts) |
| Tool evidence                | Intact        | apksigner, pcap+canary, dropbox, GitHub tag refs, badging                                           |
| Posting gate                 | Intact        | operator GO (delegated decision), flag lifecycle honored                                            |

Verdict on R39: acceptable under the criteria the literature supports — but structurally weaker than intended, and the Karasu verdict would have been the right node to spend a cheap cross-check on.

---

## 5. Proposed design: the Risk-Priced Verification (RPV) tier

### 5.1 Principle

```
Mandatory:  tool-evidence layer        (cost ~0, always)
            process gates              (cost ~0, always)
            honest-boundary vocabulary (cost ~0, always)
Priced:     judgment-layer cross-check (fires on risk triggers only)
            └─ cheapest DIFFERENT-FAMILY model available
Unchanged:  human GO before any external mutation
```

### 5.2 The cross-check itself

- **Input:** the evidence pack + the draft note, **authorship-stripped** (blind evaluation per [B4]) — explicitly as a _partial_ mitigation: [U2] shows perturbation-level blinding reduces self-preference but fuller neutralization makes it recover, since self-recognition operates on many semantic levels. We strip what is cheap (agent name, lane labels identifying the generator, self-referential praise) and accept the residual; the backstop for residual bias is the tool layer + human GO, not the blinding itself.
- **Prompt contract** (fixed, minimal): "You are a hostile reviewer. For each numbered claim in the pack: supported by the cited artifact — yes/no/cannot-tell. List unsupported claims, misinterpretations, and missing checks. Verdict: SAFE-TO-POST / NEEDS-CHANGE with reasons. Do not re-derive; audit." Minimalism is a _measured_ choice, not an aesthetic one — preregistered evidence (arXiv:2608.23941): longer review windows make monitors **more rejective, not more discriminative** (informedness peaked at 1–2 review units for all six judges; false rejection climbed in lockstep with catch). If the pilot shows flag flooding, _shortening/narrowing the contract_ is a first-line fix before changing models. And [adjacent: arXiv:2609.09776] warns the flip side, in its precise scope: _frozen/shallow verifiers under selection or training pressure_ lose soundness (best-of-N: 0.94→0.32 at N=4096; a frozen reward model under GRPO traced the full overoptimization collapse) — do not add redraws/depth as a substitute for groundable claims; the single-draw + human-gate design is the safe configuration here.
- **Output:** appended to the pack as a `## Cross-check` block (model name, timestamp, verdict, items), and reflected in `evidence_key` via `xcheck=<model>:<verdict>`.
- **Disagreement handling:** NEEDS-CHANGE never auto-resolves — it flags the item for the operator. The cheap reviewer's job is triage, not authority.
- **Cost accounting:** record tokens/cost in the cross-check block; the lane's review cost becomes auditable per note.

### 5.3 Reviewer selection policy (amended v2)

Preference order for the cross-check model:

1. **`zai-glm` (GLM) as default** — different family, configured MCP, measured ~$0.20–0.90 per deep run (a sanity pass costs far less), and per [U6] GLM is the strongest _auditor on_ sycophancy — the bias most relevant to a model reviewing its own advocacy-shaped verdicts. Precision note (tightened v3): [U6]'s claim is a **benchmark-specific empirical fact** — GLM led the sycophancy-auditing dimension _of that benchmark_ — not a model-property claim. The same paper shows standalone bias resistance does not predict audit effectiveness (Kimi-K2.5 counterexample), and [U12] shows LLM-observer output is instrumentally noisy in general. Do not infer "GLM will audit our lane well" from "GLM audited CoM's benchmark well" — transfer is exactly what the §5.4 pilot tests. **Status note (v4):** the default was unreachable at pilot time (HTTP 429); the actually-measured skeptic (DeepSeek-V4-Flash via dahl) saturated verdicts — the preference order stands on benchmark evidence only until the measured-instrument pool exists. A _measured_ instrument outranks a _benchmarked_ one.
2. Any other available different-family endpoint in `mcp_config.json`.
3. **Explicit competence tradeoff (added v2, per [U1]):** if the only reachable different-family option is dramatically weaker than a same-family option, a _stronger same-family_ auditor may be chosen instead — different-family is the default, not an axiom; ~half of classic self-preference findings may be competence noise rather than identity bias, and [U6] shows per-bias auditor quality beats a fixed-family rule. The choice must be logged (`xcheck=<model>(same-family, rationale: capability gap)`).
4. If _no_ other model is reachable: proceed ONLY on artifact-clean cases (verdict is pure evidence restatement, no judgment call); flag judgment-heavy notes for the operator explicitly rather than self-approving them.

Explicitly still discouraged but no longer forbidden: a sibling/derived model of the generator's own family — [B5] and [U6] both show family-level bias, so it loses to any reasonably capable different-family option, wins only against a clearly incapable one.

### 5.4 Pilot & self-verification of the mechanism

**Piloted 2026-10-19 — report: `tmp/fdroid-review/xcheck-pilot-report.md`.** Seven calls on `deepseek-ai/DeepSeek-V4-Flash-0731` via dahl-inference (zai-glm HTTP 429 out-of-balance; GLM-5.3-Flash/MiniMax on Dahl only reachable via streaming — ~125 s non-stream ceiling). Result: skeptic is **not inert** (planted canary contradictions located under "contradicted by pack's own evidence"), but the top-line verdict **saturates NEEDS-CHANGE on all clean packs** — the contradictions subsection is the actionable signal, not the verdict. Real catches: "Runtime confirmation of LAN-only" honest-boundary overclaim (Daak), "not a merge blocker if upstream-known" with no link (Karasu, both draws), under-evidenced rendered=False cause attribution (Counted). Misses: ~50% flag-set churn between fresh draws, one manufactured phantom contradiction, recurring missed-evidence flags, scope-inflation. Endpoint caches identical prompts byte-for-byte → nonce mandatory for consistency measurement. Contract gained the clause "treat cited artifact names and quoted lines as evidence pointers."

**Retrospective §5.7 pass on the pilot stream (added after self-audit, rough numbers):** pooled anchor-verification — DeepSeek-Flash ≈ 5 anchor-verified flags of ~13 total (1 phantom, ~3 missed-evidence, ~4 scope-inflation) → **~0.38, below the E2 0.5 floor** → under the proposed procedure its stream alone would issue _no recommendation_. The GLM-5.3-Flash external run sits ≈ 4/5 verified → above the floor. The floor discriminates as designed even on retrospective data. **Deferred pilot items (explicitly not DONE, correcting an earlier overclaim):** (a) fresh-session same-model baseline ([U14] confound control — not run), (b) evidence-unsupported vs judgment-questionable flag categorization ([U13]-class — done informally, not per-protocol). Both remain required before the trigger model counts as calibrated.

Original pilot spec (retained for the record): replay the four R39 packs through the chosen cross-check model (blind) and compare its flags against what actually mattered (Karasu verdict). If the cheap reviewer surfaces nothing on the 3 clean packs and flags the Karasu judgment call, the trigger model is calibrated. If it rubber-stamps everything or flags noise, adjust the contract — this is itself a verification-of-the-verifier exercise (consistent with [A1]'s "soundness of the verifier" being the variable that matters).

The pilot must also resolve the **cheap-vs-competent boundary** left open by [U5] vs [U1] and produce a **calibration validity window** ([U12]: endpoint-label outputs drift below deployment level — a calibration is time-bounded, and an endpoint/version change invalidates it until re-checked). Joint [U1]+[U5]+[U12] reading: if part of the cheapest tier's Pareto-optimality rests on a noise profile that happens to match the endpoint's current state, drift may destroy _that_ optimality first — so **GLM verdict consistency across repeated same-endpoint calls is a primary pilot report item, not a secondary diagnostic**. Two further report items added per Oct-2026 work: **(a)** a fresh-session same-model baseline (arXiv:2610.01471) to separate "different family" from "fresh context" — otherwise `zai-glm` success is unattributable; **(b)** categorize every NEEDS-CHANGE flag as _evidence-unsupported_ (a groundability signal — the claim outruns its artifact) vs _judgment-questionable_ (a model-opinion signal) (arXiv:2610.01023) — the former is what the cross-check is really for; U5 says the cheapest tier is Pareto-optimal; U1 says low evaluator competence produces undifferentiated noise rather than identity bias. Do not presuppose the cheap sanity pass wins — measure it. If GLM's flags are undifferentiated noise on the R39 corpus, escalate to the next-capable endpoint rather than concluding "cross-checks don't work." If pilot noise is structural (any single verdict unreliable per [U12]), consider the [U11]-class middle tier (cheap semantic-consistency checking) before abandoning the judgment layer.

### 5.5 What RPV deliberately does NOT do

- Does not replace the human GO. External mutations still require explicit operator approval; delegated GOs remain a documented exception, not a norm.
- Does not add review to tool-evidence — re-running `apksigner` through an LLM adds noise, not soundness ([A2]: false positives).
- Does not promise "as good as the full chain" — it is the documented degradation mode, chosen consciously per round, with the risk concentrated where risk actually lives.
- Does not remove the option of the full Reviewer — when credits return, high-risk notes still get the real reviewer; RPV is the floor, not the ceiling.

### 5.6 Round-type policy

| Round type                                                                              | Verification posture                                                 |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Low-risk (artifact-clean, ≤~5 MRs, no triggers)                                         | Tool layer + gates; RPV optional                                     |
| Medium (any trigger fires)                                                              | Tool layer + gates + RPV on flagged notes                            |
| High-risk (ambiguous findings, novel stack, sensitive surface, posting-hinge judgments) | RPV mandatory; full Reviewer if credits allow; else flag to operator |
| No cross-model available AND triggers fired                                             | Do not post judgment-heavy notes; report and wait                    |

### 5.7 Flag-stream → disposition: the claim-table decision procedure

_Source: GLM-5.3-Flash (AutoClaw webchat, operator-paste) answering the §8-Q6-class design question on 2026-10-19. Status: **proposed disposition layer on top of the §5.2 contract — adoption pending operator decision + claim-table tooling** (§7). It is included here as a complete candidate design; its self-declared failure modes are folded into §6 verbatim-condensed. Note the instrument's own conflict caveat — this section was authored by the same model family as the §5.3 default reviewer; adoption-faithfulness was audited, its truth claim was not._

**Diagnosis:** the verdict channel is saturated, not the flags — a binary verdict cannot distinguish "RB failure" from "one wording nit". All remaining information lives in the flag stream, which is heterogeneous on three axes: precision (phantoms), recall (missed staleness), claim decomposition (a catch existing only because the input framing included the follow-up note). Any aggregation that treats flags as draws from one ground-truth set — voting, weighted unioning — inherits that heterogeneity as noise. Fix: make the decomposition the fixed part and the instruments the variable part.

**Core move — pre-registered claim table T.** Before any audit, mechanically derive a flat table of atomic claims from the pack (sections map to claim clusters). Each row: claim text, cited anchor artifact, `load-bearing ∈ {yes, no}`. The load-bearing set L (RB pass, signer match, tag=pin, tracker scan, endpoint scoping, license) is **operator-owned**, 4–7 rows, declared before any flags are read. Add _joint rows_ wherever a follow-up note touches pack claims — joint-read catches become a designed feature, not luck. Consequences: row-complete audits bound cost to O(|T|); flags merge by claim id (two instruments flagging the same claim = one entry after anchor-dedup — **agreement is not evidence; anchors are**); heterogeneous _framing_ (solo-read / joint-read / coverage-only) buys more recall per token than heterogeneous models.

**Disposition map — five classes, each maps to exactly one action (the class label is a sufficient statistic):**

| class             | chain state                                                  | disposition                                                   |
| ----------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| contradiction     | chain broken (pack's own artifacts conflict)                 | **auto-defer** if ×L or joint-reading; else change-request    |
| unevidenced-claim | chain absent or insufficient                                 | blocking iff ×L (task: run the check); else pointer fix       |
| missing-check     | chain incomplete                                             | blocking iff ×L (defined task); else boundary note            |
| scope-inflation   | chain valid, wording exceeds window                          | reword list, never blocking                                   |
| phantom           | anchor fails — evidence about the _instrument_, not the pack | quarantine + reliability score; never counts against the pack |

Interaction rule: class × load-bearing. Origin rule: joint-reading contradictions get top priority (rarest, cheapest to verify, survive solo-read audits). The gatekeeper sees a one-screen sheet: L-table status, disqualifiers quoted, boundary items, reword list, phantom log — with flag provenance (instrument + framing) attached.

**Anchor verification replaces redraws.** Every flag's anchor is checked mechanically (does the artifact exist; does the quoted line exist in it) — deterministic, cheap, yields per-instrument precision in one pass, and turns churn into a testable prediction: re-run once with the fixed table as a _calibration experiment_; persistent churn → genuinely noisy instrument → weight or drop it.

**Escalation criterion (falsifiable, both countable and pre-registered):**

- **E1 — anchor conflict:** two anchor-verified flags on the same claim id yield opposite dispositions → one-pass tie-break on that claim only (bounded spend).
- **E2 — reliability floor:** pooled anchor-verification rate < 0.5 → the stream is indistinguishable from instrument noise → no recommendation is issued; escalate or re-contract.

Explicit non-triggers: high disagreement, high flag counts, cross-instrument churn — cheap diversity unless they hit E1/E2.

**Self-declared failure modes (kept verbatim-condensed — they are the honest boundary):**

1. _Claim-table capture_ — whoever owns T owns the outcome; author-owned T can be gerrymandered (split a bad claim into benign rows, omit one). The taxonomy audits claim–evidence fit, never claim-space completeness. Only operator-owned T + coverage-only framing partially compensate.
2. _Class boundary leakage_ — scope-inflation vs unevidenced-claim is a gradient; misclassification flips dispositions, and the anchor check adjudicates anchors, not classes.
3. _Anchor-present-but-misread recursion_ — pointer exists, content doesn't support it; verifying "misread" recurses back to a human read.
4. _Soft anchors_ — claims like "TetheredNet accurate" have no textually checkable anchor; the procedure silently degrades to single-instrument trust, and E2 cannot fire because no measurable conflict exists. This is where the residual risk hides.
5. _Correlated instruments_ — shared-family reviewers' overlap is not independent evidence; anchor verification fixes it where anchors are hard, nothing fixes it where they're soft.
6. _Calibration drift_ — thresholds (0.5, |L|) are empirical; without logging gatekeeper overrides there is no recalibration loop and the procedure rots into ritual.

Net: the recommendation stops being a vote and becomes a computed function of (class × load-bearing × anchor-verified), escalation event-triggered not vibe-triggered. Honest boundary: claim–evidence auditing becomes a procedure, but claim-space completeness and soft-anchor judgment remain irreducibly human.

**Interface gap (found by the self-audit, pending spec change):** the §5.2 contract currently emits yes/no/cannot-tell per claim plus a verdict — §5.7 requires each flag to carry a **class tag + claim id**. No component emits class labels today, and the posting gate checks block _existence_, not content. Required contract amendment before §5.7 is load-bearing: "tag every flag with class (contradiction/unevidenced-claim/missing-check/scope-inflation/phantom) + the claim id it addresses." Until xcheck.py emits that schema, §5.7 is a specification, not a mechanism.

---

## 6. Failure modes and mitigations

| Failure mode                                                                                                                                                                                                                                                | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cheap reviewer rubber-stamps everything                                                                                                                                                                                                                     | Periodic audit: when credits exist, replay a sample of self-reviewed packs through the full Reviewer; measure flag-recall. Tune contract if it misses what the strong reviewer catches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Cheap reviewer false-positives (noise flags, blocks good notes)                                                                                                                                                                                             | NEEDS-CHANGE is a _flag to the human_, never an auto-block. False positives cost operator attention, not correctness — acceptable asymmetry **when operator attention is plentiful**. Calibration warning (Nguyen & Tran 2026, arXiv:2605.17998): a governed-runtime verifier measured 98.58% rule agreement but **0.39% blocked precision** — nearly every rejection a false positive, "so it remains advisory." Sample caveat: 97.83% of rows came from one high-volume cluster, only 17 events were production-classified, and the authors disclaim benchmark status — read the 0.39% as a _directional warning about unmeasured precision_, not as evidence about gate reliability in general. Flag-not-block is necessary but _not free_: at low interception precision the flag stream becomes operator fatigue — worst exactly under the budget pressure that created RPV, where the operator's per-round attention budget is smallest. If flag rate exceeds that budget, RPV's net effect can go **negative** (operator starts ignoring flags, or burns attention on noise — both erode the human-GO backstop itself). The pilot and the 3-round review must measure flags-per-round and flag-precision-ish proxies, not just misses. |
| Generator learns what the reviewer checks and optimizes for the check                                                                                                                                                                                       | Keep reviewer prompt + checks out of the pack content; rotate reviewer model/prompt occasionally; the check targets claims-vs-artifacts, a hard-to-game axis.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Blind-stripping leaks authorship anyway (writing style, lane phrases)                                                                                                                                                                                       | Structural, not incidental — [U2]: fuller neutralization _restores_ self-preference; self-recognition lives on many semantic levels. Accept residual bias explicitly; backstop = tool layer + human GO.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Multiple parallel cheap reviewers dilute detection ([U5],[U10])                                                                                                                                                                                             | Default to **single skeptic**. If breadth is ever added, aggregation rule dominates headcount: [U10] shows strict-veto was the _only_ rule with 0% hallucination survival across tiers, while "unanimous" was paradoxically most fragile (0.167 at Opus N=3/5). Strict veto costs false discards (0.833 true-finding survival at Haiku) — absorbed here because NEEDS-CHANGE flags the operator rather than auto-blocking.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Cross-check model is itself a noisy instrument — verdicts are draws, not measurements ([U12]: byte-identical replays agree 0.78; noise floor shared across providers)                                                                                       | A `## Cross-check` block's _existence_ satisfies the gate; its _content_ (per-claim supported/unsupported lines) must stay spot-checkable by the operator. Audit sampling (row 1) verifies content, not presence. Never treat a single verdict as ground truth — it feeds triage, not authority.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Over-triggering (everything gets checked → budget drain)                                                                                                                                                                                                    | Trigger list is explicit and count-limited; log trigger hits per round; review the rate monthly. CAVR-MAS predicts monotone workload vs threshold — tune the threshold, not the concept.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The check itself is wrong (cheap model misreads the pack)                                                                                                                                                                                                   | Verifier-of-verifier pilot (5.4) + audit sampling. Known limit of cheap verification — priced into the "triage not authority" role.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Inert reviewer — below a capability floor the cross-check produces _no signal_ at all, at double cost (arXiv:2609.04270: weakest reviewer changed 0/100 answers; a zero NEEDS-CHANGE rate is ambiguous — "clean packs" and "inert reviewer" look identical) | Pilot must distinguish the two: seed at least one pack with a _known_ defect (canary claim — e.g., a deliberately wrong signer or endpoint) and confirm the reviewer flags it. Zero flags on clean packs only counts as calibration if the canary fires.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Instrument drift — "model name is not a snapshot identity": the same endpoint label drifts below deployment level; verdicts on different days are different instruments ([U12])                                                                             | The Cross-check block already logs model + timestamp — extend to endpoint/date so `xcheck=<model>` records the instrument actually used. Never compare verdicts across versions/endpoints as if same instrument; pilot calibration must be same-endpoint, same-window. On NEEDS-CHANGE disputes a redraw on the _same_ endpoint is legitimate; across endpoints it is a new instrument, not a recount.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| §5.7 procedure failure modes (claim-table capture, class-boundary leakage, anchor-misread recursion, soft anchors, correlated instruments, calibration drift)                                                                                               | Operator-owned load-bearing set declared before flags are read; coverage-only framing as partial compensation; soft-anchor claims degrade explicitly to human judgment (no measurable conflict → E2 cannot fire, so mark them `boundary:` rather than letting them pass silently); gatekeeper-override logging feeds recalibration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Future directions noted from adjacent 2026 literature (not absorbed — no lane change without operator decision):

- _Verify-gated completion as admission control_ (Nguyen & Tran, arXiv:2605.17998 + AgentPatterns pattern) — "ambiguous cases fail closed" matches NEEDS-CHANGE-never-auto-resolves. **Honest boundary:** the pattern's admission-control guarantee requires four conditions — verifier independent of producer, ground truth (deterministic checks, _not_ another LLM's opinion), verifier on the critical path, measured blocked-precision. Our cross-check satisfies only the first partially: it is LLM-verifying-LLM (no ground truth), it is _not_ on the critical path (the human GO is), and its precision is unmeasured (the pilot's job). By the pattern's own fallback rule ("if any condition fails, prefer agent-internal verification or **recording without admission control — a verification ledger**"), the `## Cross-check` block is precisely _that_: an audit ledger entry, not a gate — real audit value, but it must not borrow admission-control authority in wording.
- _Budgeted verification failures in inherited agent memory_ (Nakayashiki, arXiv:2608.25553, 2026) — agents re-verify a settled-looking constraint in ~1 of 5 episodes; once superseded, they produce stale-consistent decisions in 77.3%/74.7%/74.7% of episodes; reallocating one budget slot to the critical provenance path **recovered +61–74pp in the authors' experimenter-informed allocation** — an intervention that "uses knowledge of the critical path and is not a scheduler," identifying how much stale-error share allocation _can_ recover, not how to recover it automatically. The gain is real but not directly deployable; COVERED.txt would first need a way to _identify_ the critical path without prior knowledge. Lane implication: `COVERED.txt` dedup records "covered" with **no freshness or supersession signal** — a reviewed IID whose MR head later changed could silently inherit a stale verdict. Live-head re-verify covers the pre-posting moment only. Worth a formal rule later: a coverage entry is superseded evidence if the MR head/commit it was reviewed against has moved.
- _Specification-driven orchestration vs. "smart" verification_ (Manifold, Zenodo 2026, alpha-stage project) — 600 trials: naive prompting reported 100% success with only 34% true success and 66% false-positive rate; spec-contract orchestration hit 94% true success / 0% FP at 0.36× cost, while "smart" retry logic degraded to 58–98% success at **1.5–3.5×** cost inflation. Supports the tool-layer-first stance with engineering-side evidence: adding verifier _intelligence_ can raise cost and noise simultaneously; deterministic contract checks are the FP-reduction lever.
- _Anytime-valid admission accounting_ (Wei & Liu, arXiv:2608.15810, 2026) — distinguishes three regimes: no gate (omission failure), a gate whose budget is exhausted (noise failure), and a physically accounted gate whose bound holds per admission call. Union-bound budgets exhausted on 100% of long requests in a production stack; their ledger held on all 352,333 calls and halved the fallback rate at matched risk (0.30→0.14), Lean-4-checked kernels. For §5.6: "no check" vs "check with exhausted/invalid budget" are different failure modes — a silently unreliable check is worse than an honestly absent one.
- _Verifier placement as a computable problem_ (delayed-verification paper, arXiv:2606.27409 — expanded from U4-adjacent) — beyond its instability result it contributes a **supermodular placement objective**: a greedy rule places a fixed corrector budget within 1−1/e of optimal, concentrating on amplifier/bridge nodes (with the authors' own caveat that the bound holds for the surrogate objective). Its concrete structural finding also sharpens trigger #8: on graphs deeper than ~4 hops, correctors must sit mid-pipeline — terminal-node placement fails to suppress propagation past the stability threshold. If trigger #8 is ever upgraded from heuristic to computed placement, this is the method source.
- _Reviewer capability floor — the "inert reviewer" failure mode_ (arXiv:2609.04270, execute–review–revise pilot, 100 olympiad problems) — directly tests RPV's core assumption: a cross-family **mid-tier** reviewer improved final accuracy 52%→64% (+12pp, p=0.0005, zero damaged); same-model self-review had the _highest_ error-detection recall (0.85) yet no significant gain — rejected 2.1× as often at 1/3 the repair rate (15% vs 43%) and **falsely rejected 35% of its own correct answers** (vs 2% cross-family). Below a capability floor the reviewer becomes **inert**: zero of 100 answers changed while doubling cost — not noise, but _no signal at all_. Authors' caveat: single configuration, controlled pilot. For RPV: a zero-flag pilot result is ambiguous — could mean "calibrated, clean packs" or "inert reviewer"; the pilot must distinguish.
- _Priced label-free checks_ (PriceCheck, arXiv:2609.37493, Sept 2026) — closest operational formalization of RPV's core idea: each check gets a _price_ (agreement rates on correct/incorrect answers + unit cost); fitted prices compose into coverage/cost predictions for schedules; a calibration test selects which checks run and when to stop at a stated selective-risk target. Served 76.1% of answers at <1.5% held-out risk on all 15 splits, beating reward models, prompted judges, generator confidence, and trained classifiers at matched coverage (0.97 rank correlation on coverage prediction). For §8 Q6: a more operationally adjacent method source than act-or-defer — our `## Cross-check` is currently a single fixed rule; PriceCheck shows how a family of priced sub-checks could be scheduled instead.
- _Session-freshness confound_ (arXiv:2610.01471, Oct 2026, controlled: 30 artifacts / 150 planted errors / 900 review sessions) — challenges the different-family premise directly: a top-tier cross-model reviewer was **not significantly better in F1 than same-model review in a fresh session** — the perceived cross-family advantage may be largely _session freshness_, not model diversity. Authors: "model difference and reviewer capability are not separable." For RPV: `zai-glm` runs in a fresh context anyway (the confound works _for_ us operationally), but the pilot cannot attribute performance to family vs freshness unless it also runs a **fresh-session same-model baseline** — flagged as a confound to report, not a design change.
- _CrossAudit_ (arXiv:2608.28631, Dong & Chen, Aug 2026) — a Git-native cross-vendor audit protocol whose invariants converge with RPV's architecture from the engineering side: **scripted checks run before any model; a model blocks only by citing a rule; no model may waive a deterministic failure; surviving blockers escalate to a person** — i.e., tool layer first, evidence-anchored flags, human terminal gate. Its seeded-defect trial (30 increments, 43 defects) also ran a cross-vendor audit of _its own repo_ that voided the trial's blinding — the authors adopted the audit's findings and re-reported. Evidence-anchoring as the activation condition for cross-vendor value: supports §5.2's cited-artifact contract and pilot item (b).
- _Weak–strong verification policies_ ("When to Trust the Cheap Check", arXiv:2602.17633, Kiyani/Noorani/Pappas/Hassani, UPenn — **ICML 2026 poster, peer-reviewed**) — formalizes exactly the RPV trigger problem: when to accept on a cheap weak check vs. defer to strong verification; optimal policies admit a **two-threshold structure**; an online algorithm provably bounds accept/reject errors without assumptions on the stream, matching exhaustive-strong-verification reliability at far lower cost. For §5.6/§8 Q6: the accept/defer boundary RPV hand-encodes in round types has a provable formulation — a candidate formalization that, unlike act-or-defer, makes no calibration assumptions about the stream.
- _Groundability over scale/family_ (arXiv:2610.01023, Guo et al., Oct 2026) — when can a weaker reviewer audit a stronger generator? Answer: when a **decisive, groundable check exists**. 411 execution-labeled traces: structured-but-unverified evidence raised _both_ catch and over-rejection; with official execution evidence, 5/6 reviewers improved both (two perfect) — reviewer size was _not_ a consistent predictor. Without official tests, the best frozen cascade still showed 0.66–0.67 over-rejection: "producing equally reliable checks without official tests remains the main bottleneck." For RPV: the leverage is not _which_ model reviews but _whether the judgment layer's claims are groundable_ — the lane's `evidence_key`/`boundary:` anchors are exactly that. Shifts attention from §5.3 model choice to claim-evidence anchoring (which the §5.2 contract already exploits: "supported by the cited artifact — yes/no/cannot-tell").

---

## 7. Implementation plan

1. **Pilot — DONE 2026-10-19:** `tmp/fdroid-review/xcheck-pilot-report.md` (see §5.4).
2. **Playbook amendment — DONE:** §5c "Risk-Priced Verification" in `FDROID_REVIEW_PLAYBOOK.md` (tiers, triggers, blind-stripping, block format, round types, pilot lessons).
3. **Gate extension — DONE:** `post_note.py` refuses when `XCHECK_REQUIRED_<iid>.flag`/`XCHECK_REQUIRED.flag` exists and the pack lacks `## Cross-check`; `XCHECK_OVERRIDE_<iid>.flag`/`XCHECK_OVERRIDE.flag` bypasses with a printed warning.
4. **Helper — DONE:** `xcheck.py` verified end-to-end (streaming required on Dahl; GLM-5.3-Flash works via stream, timed out non-stream).
5. **Ledger — DONE:** `xcheck` field in `drift_baseline.json` per IID + `xcheck=<model>:<verdict>` in pack evidence_key; COVERED.txt files carry digit-free pointer comments (parsers treat bare digit tokens as covered IIDs). _Drift detection_ solved by `drift_monitor.py` (live run during implementation caught HEAD_DRIFT on !52238 + 10 merges) — **supersession semantics remain open** per the §6 Nakayashiki bullet: a drifted entry is flagged, not invalidated; COVERED.txt still counts it as covered until re-review.
6. **Review after 3 rounds:** trigger rate, flag precision vs. operator judgment, cost per note. Adjust.

Pending implementation items (added after self-audit): 7. **Contract amendment (blocks §5.7):** xcheck.py must emit per-flag class tags + claim ids (disposition-map schema) — currently emits yes/no/cannot-tell + verdict only. 8. **Claim-table derivation:** mechanical pass that extracts atomic claims + anchors from a pack; operator-owned load-bearing set L declared per round before flags are read. 9. **Anchor-verification pass:** deterministic check that each flag's cited artifact exists and the quoted line exists in it — feeds E2's pooled rate. 10. **Pilot items (a) + (b):** fresh-session same-model baseline; evidence-unsupported vs judgment-questionable flag categorization — required before "calibrated" may be claimed. 11. **Seeded-defect ID registry:** phantoms/canaries need stable IDs so instrument reliability is comparable across rounds.

Remaining manual step for the operator: run `xcheck.py` on a live pack when the first §4.3 trigger fires; GLM-balance recheck when credits return.

---

## 8. Open questions for the operator

1. Is `zai-glm`/GLM acceptable as the default cross-check model, or is there a preferred different-family endpoint (e.g., `dahl-inference`, a local Ollama model — free but weaker)? _(2026-10-19: zai-glm HTTP 429 insufficient balance at pilot time; `deepseek-ai/DeepSeek-V4-Flash-0731` via dahl-inference measured functional — see §5.4; `zai-org/GLM-5.3-Flash` on the same endpoint works via streaming only.)_
2. Trigger threshold OK as listed (§4.3), or tighten/loosen?
3. Should self-reviewed (no cross-check) packs carry an explicit marker (`xcheck=none(self-reviewed)`) so maintainers/auditors can see the verification tier at a glance — or keep that internal?
4. Full-Reviewer fallback policy when credits return: retroactively re-check posted self-reviewed notes, or only forward-looking?
5. If the pilot shows GLM's cheap sanity pass produces undifferentiated noise — [U1] and [U5] measure _different_ dependent variables (self-preference vs adversarial hallucination survival), so this is a hypothesis about whether cheap-tier noise dominates **our** task, not a proven contradiction — do we: escalate to a stronger endpoint and accept higher per-note cost, or declare "no viable cross-check" and flag judgment-heavy notes to the operator instead?
6. Longer-term: should the "flag to operator / defer" decision (§5.6) eventually be formalized as a computable reliability bound rather than qualitative triggers? _(2026-10-19: candidate design exists — §5.7 E1/E2 escalation criteria are countable and pre-registered; pending operator decision + claim-table tooling in xcheck.py.)_
7. Should high-volume triggering (§4.3 #3) become a _cumulative_ metric — count of judgment-bearing notes/flags per round against an explicit operator attention budget (irreversibility-budget framing, arXiv:2609.00275) — rather than a flat MR count? [arXiv:2606.29654 — budgeted act-or-defer with local reliability bounds] does this for multi-agent deliberation; plausible future direction, but its guarantee is explicitly **conditional, not distribution-free** (relies on a valid local bias envelope + representation-gap bound, each paired with falsification diagnostics) — adopting it would mean first verifying those assumptions hold on `evidence_key` structure, not just collecting calibration data. An operationally closer alternative is **PriceCheck** (arXiv:2609.37493): checks priced by agreement rates + unit cost, scheduled against a stated selective-risk target — nearer to our single-rule cross-check's granularity. Neither is needed for the pilot.

---

## 9. Citations

**Cluster A — self-verification limits**

- A1: Stechly, Karamanolakis, Kambhampati — "On the Self-Verification Limitations of Large Language Models on Reasoning and Planning Tasks", arXiv:2402.08115 — https://arxiv.org/html/2402.08115v2
- A2: Stechly, Kambhampati — "Can Large Language Models Really Improve by Self-critiquing Their Own Plans?", arXiv:2310.08118 — https://doi.org/10.48550/arxiv.2310.08118
- A3: "Benchmarking and Improving Generator-Validator Consistency of LMs", ICLR 2024 — https://proceedings.iclr.cc/paper_files/paper/2024/file/bfcb583d225b1db8d3ca2331f6785774-Paper-Conference.pdf
- A4: "A Closer Look at the Self-Verification Abilities of Large Language Models in Logical Reasoning" (FALLACIES), NAACL 2024 — https://doi.org/10.18653/v1/2024.naacl-long.52
- A5: "Learning to Self-Verify Makes Language Models Better Reasoners", PMLR v306 — https://proceedings.mlr.press/v306/chen26es.html

**Cluster B — judge bias / self-preference**

- B1: "LLM Evaluators Recognize and Favor Their Own Generations", arXiv:2404.13076 — https://arxiv.org/abs/2404.13076
- B2: "Do LLM Evaluators Prefer Themselves for a Reason?", arXiv:2504.03846 — https://arxiv.org/html/2504.03846v3
- B3: "Self-Preference Bias in LLM-as-a-Judge", arXiv:2410.21819 — https://arxiv.org/html/2410.21819
- B4: "Quantifying Label-Induced Bias in LLM Self- and Cross-Evaluations", arXiv:2508.21164 — https://arxiv.org/abs/2508.21164
- B5: "MLLM-as-a-Judge Exhibits Model Preference Bias", arXiv:2604.11589 — https://arxiv.org/html/2604.11589

**Cluster C — budget-adaptive verification**

- C1: "Adaptive Verification and Confidence-Aware Routing for Reliable Multi-Agent LLM Reasoning" (CAVR-MAS), IJAIES — https://www.ijaies.org/index.php/home/article/view/125
- C2: "JOVE: Joint Execution and Verification for Resource-Aware LLM Task Graphs", arXiv:2610.03296 — https://arxiv.org/html/2610.03296
- C3: "A Unified Approach to Routing and Cascading for LLMs" (ETH-SRI), arXiv:2410.10347 — https://arxiv.org/html/2410.10347v3 (code: https://github.com/eth-sri/cascade-routing)
- C4: "Learning to Route" — https://github.com/lee101/learning-to-route
- C5: hasna/swarm — actor/verifier + budget governor — https://github.com/hasna/swarm

**2026 update cluster (verified 2026-10-19)**

- U1: Roytburg, Bozoukov, Nguyen, Barzdukas, Puig-Hall, Oozeer — "Are LLM Evaluators Really Narcissists? Sanity Checking Self-Preference Evaluations", ICML 2026 / arXiv:2601.22548 — https://arxiv.org/abs/2601.22548 (PMLR v306: https://proceedings.mlr.press/v306/roytburg26a.html)
- U2: "Mitigating Self-Preference by Authorship Obfuscation", AAAI 2026 / arXiv:2512.05379 — https://arxiv.org/abs/2512.05379 (DOI: https://doi.org/10.1609/aaai.v40i44.41105)
- U3: Barzdukas, Nguyen, Bozoukov, Fu, Roytburg, Oozeer — "Breaking the Mirror: Activation-Based Mitigation of Self-Preference in LLM Evaluators", NeurIPS 2025 Reliable ML Workshop / arXiv:2509.03647 — https://arxiv.org/abs/2509.03647 (code: https://github.com/djroytburg/steering_self_preference)
- U4: "The Hallucination Snowball: Modeling Error Propagation as State Transitions in Multi-Agent LLM Pipelines", arXiv:2608.14588 — https://arxiv.org/abs/2608.14588 (adjacent: "Delayed Verification Destabilizes Multi-Agent LLM Belief", arXiv:2606.27409 — https://arxiv.org/html/2606.27409v1)
- U5: "Verify-Gated Fan-Out: Measuring the Cost-Quality Pareto Frontier of Adversarial Verification in Tiered Multi-Agent Skill Workflows", July 2026 — https://huggingface.co/datasets/thaki-AI/daily-paper-2026-07-11-verify-gated-fanout-pareto
- U6: "Chain-of-Models: Cross-Model Auditing for Bias-Robust LLM Judges", arXiv:2607.28636 — https://arxiv.org/abs/2607.28636
- U7: Lin, Y. (Fujian Agriculture and Forestry University) — "The Prose Barrier: Structural Limits of Agent Self-Verification and a Five-Layer Configuration Integrity Architecture", Zenodo preprint v2, 2026-08-14 — https://doi.org/10.5281/zenodo.21934129 (self-described independent undergraduate work; NOT peer-reviewed — cited as articulation + suggestive empirical datapoint, not academic authority; earlier versions circulated via GitHub hermes-workspace + dev.to)
- U8: "Pre- versus Post-Action Verification: Measuring the Safety-per-Dollar Frontier of Gating versus Auditing in Autonomous K8s Agent Loops", ThakiCloud AI Research technical report, Sept 2026 — https://huggingface.co/datasets/thaki-AI/daily-paper-2026-09-01-verification-placement-safety-cost (technical report, not peer-reviewed; illustrative scenarios, no live measurements)
- U9: Reinhardt & Rasmussen — "Against Ungrounded 'Done': Risk-Limiting Completion Certificates for LLM Agents", TU Eisenfeld Working Paper, Sept 2026 — https://doi.org/10.5281/zenodo.22969566 (working paper, not peer-reviewed)
- U10: "Less Verification Is Safer: Measuring the Cost-Quality Curve of Multi-Agent Verification Gates", ThakiCloud, 2026-07-11 — https://thakicloud.com/tech-blog/en/research/verify-gated-fanout-pareto/ (technical report/blog analysis of the U5 corpus; not peer-reviewed; same 12-finding benchmark)
- U11: Xu, X. & Wu, J. — "Mitigating LLM Hallucination Snowballing in Multiagent Systems via Context-Aware Semantic Consistency Reasoning", IEEE Transactions on Neural Networks and Learning Systems, 2026-01-28 — https://doi.org/10.1109/tnnls.2026.3655508 (peer-reviewed journal)
- U12: "Clean Engineering, Unstable Measurement: A Preregistered Reliability Failure of Black-Box LLM Observers on Shared Endpoints", arXiv:2609.04198, Sept 2026 — https://arxiv.org/html/2609.04198v1 (preregistered study; authors' own label for the analysis: exploratory diagnostic, "not an executed experiment")

**Adjacent works noted by external review (design space only, not load-bearing)**

- Wang, Xie, Wang, Zhang, Woo (AWS GenAI + GM) — "Budgeted Act-or-Defer Multi-Agent LLM Deliberation with Local Reliability Bounds", arXiv:2606.29654, June 2026 — https://arxiv.org/abs/2606.29654 (k-NN lower confidence bound on state-conditional correctness; 9–12% budget usage, 84% automation, 96% acted-on accuracy; candidate formalization for the defer decision — see §8 Q6)
- Nguyen, H.-D. & Tran, X.-T. (Vietnam Maritime University) — "Verify-Gated Completion as Admission Control in a Governed Multi-Agent Runtime: A Bounded Architecture Case Study", arXiv:2605.17998, May 2026 — https://arxiv.org/abs/2605.17998 (preprint; 98.58% rule agreement / 0.39% blocked precision → verifier "remains advisory"; pattern articulation: https://agentpatterns.ai/patterns/multi-agent/verify-gated-completion-admission-control/ — four conditions incl. ground-truth + critical-path, which our advisory cross-check does not meet; see §6)
- Nakayashiki, K. (Glasp) — "When Stale Constraints Go Unchecked: Budgeted Verification Failures in Inherited Agent Memory", arXiv:2608.25553, Aug 2026 / Zenodo 10.5281/zenodo.22108558 — https://arxiv.org/abs/2608.25553 (preprint; 77.3%/74.7%/74.7% stale-consistent under fixed budget; +61–74pp recovered by _experimenter-informed_ critical-path allocation — "not a scheduler"; "memory systems may need freshness or supersession signals separate from relevance" — see §6)
- "Manifold: Eliminating False Positives in Multi-Agent LLM Systems Through Specification-Driven Orchestration", Zenodo, Feb 2026 — https://doi.org/10.5281/zenodo.18707310 (independent project, NOT peer-reviewed, alpha-stage; code: https://github.com/fabs133/manifold; 600 trials — spec-contract orchestration 94%/0%FP vs naive 34%/66%FP; smart retry 1.5–3.5× cost — see §6)
- Wei, F. & Liu, L. (Metask Lab) — "Pricing the Risk of Runtime Compression: Anytime-Valid Admission and a Served-Output Law for Compressed Serving State", arXiv:2608.15810, Aug 2026 — https://arxiv.org/abs/2608.15810 (preprint; anytime-valid admission ledger, 352,333 calls, Lean-4-checked kernels; distinguishes no-gate vs exhausted-gate vs accounted-gate failure modes — see §5.6/§6)
- "Delayed Verification Destabilizes Multi-Agent LLM Belief: Instability Thresholds and Optimal Corrector Placement", arXiv:2606.27409, June 2026 — https://arxiv.org/html/2606.27409v1 (supermodular placement objective + greedy 1−1/e rule for corrector budgets; bound holds for the surrogate objective; >4-hop graphs need mid-pipeline correctors — candidate for computed trigger-#8 placement, see §4.3/§6)
- "Reviewer Capability Governs Rejection Targeting, Not Repair Skill: Evidence from LLM Execute–Review–Revise Pipelines", arXiv:2609.04270, Sept 2026 — https://arxiv.org/abs/2609.04270 (controlled pilot on 100 problems; cross-family mid-tier +12pp/zero damage; same-model self-review falsely rejected 35% of own correct answers; capability floor → inert reviewer, see §6)
- Lee, D.J. et al. — "Risk-Controlled Selective LLM Answering by Pricing Label-Free Checks" (PriceCheck), arXiv:2609.37493, Sept 2026 — https://arxiv.org/abs/2609.37493 (checks priced by agreement rates + unit cost; 76.1% served at <1.5% selective risk on all 15 splits; code: https://github.com/js-lee-AI/PriceCheck — candidate method for §8 Q6)
- Zhang, Y. & Shrestha, Y.R. — "Review Rarely Beats the Stronger Model: Separating Verification from Capability Transfer in LLM Pipelines", arXiv:2610.15897, Oct 2026 — https://arxiv.org/abs/2610.15897 (also https://doi.org/10.48550/arXiv.2610.15897; code: https://github.com/Kamilaabb/verification-or-capability-transfer; direct fetch verified — some search indexes failed to surface it) (sobering counterweight: across 48 pairs of 12 open-weight models, review beat the stronger model alone in only 9 of 96 directions, worse the larger the capability gap; mechanism = anchoring — the reviewer follows the generator and discards its own correct answers; review costs 2.6–2.8× while a same-calls selector is 2.7–4.2pp more accurate — reinforces "cheapest _capable_, not cheapest" and warns that a cross-check can _harm_ when the reviewer defers to the pack)
- "When Does a Second Model Help? Cross-Model Review in LLM Verification", arXiv:2610.01471, Oct 2026 — https://arxiv.org/html/2610.01471v1 (controlled: 30 artifacts/150 planted errors/900 sessions; top-tier cross-model ≈ fresh-session same-model in F1 — cross-family advantage confounded with session freshness; see §5.4 pilot item (a))
- Guo, J., Gu, S., Jin, M., Lavaei, J. — "Groundability, Not Scale Alone: When Weak Reviewers Can Audit Strong Coding Agents", arXiv:2610.01023, Oct 2026 — https://arxiv.org/abs/2610.01023 (411 execution-labeled traces; decisive checks enable weak reviewers, unverifiable evidence raises catch AND over-rejection; reviewer size not a consistent predictor; see §5.4 pilot item (b))
- M, E.R. & Karmakar, S. — "Proof-Carrying Cognition: Closing the Verification Gap with Reality-Settled Reward", arXiv:2609.09776, Sept 2026 — https://arxiv.org/abs/2609.09776 (unsound verifiers lose soundness under optimization pressure, 0.94→0.32 at N=4096, sound verifiers improve monotonically; paper itself reports and repairs two falsified claims — supports single-draw design, see §5.2)
- Han, Y., Yan, C., Zhang, W. — "More Rejective, Not More Discriminative: The Unit of Verification in Pre-Execution LLM Oversight", arXiv:2608.23941, Aug 2026 — https://arxiv.org/abs/2608.23941 (preregistered twin-prefix framework; informedness peaks at 1–2 review units; longer windows → more rejective, not more discriminative — supports the minimal prompt contract, see §5.2)
- Mohammadi, B. & Bindschaedler, L. (MPI-SWS) — "The Irreversibility Budget: Fleet-Level Risk Accounting and Admission Control for Agent Operating Systems", arXiv:2609.00275, Aug 2026 — https://arxiv.org/abs/2609.00275 (AgenticOS Workshop @ SOSP; per-effect gates admitted fleet overdraws up to 48× while cumulative budget held correctly charged runs in-limit — informs §4.3 trigger #3 + §8 Q7)
- Dong, Z. & Chen, Y. (Cambridge / UW-Madison) — "CrossAudit: A Git-Native, Cross-Vendor Audit Loop for Agentic Science", arXiv:2608.28631, Aug 2026 — https://arxiv.org/abs/2608.28631 (eight-invariant protocol: scripted checks before models, model blocks only by citing a rule, no model waives a deterministic failure, blockers escalate to a person; seeded-defect trial + self-audit that voided its own blinding — see §6/§5.2)
- Kiyani, S., Noorani, S., Pappas, G., Hassani, H. (UPenn) — "When to Trust the Cheap Check: Weak and Strong Verification for Reasoning", arXiv:2602.17633, Feb 2026 — https://arxiv.org/abs/2602.17633 (**ICML 2026 poster, peer-reviewed**; weak-strong verification policies with provable two-threshold structure + assumption-free error control; formalizes the accept/defer boundary — see §5.6/§8 Q6; code: https://github.com/nooranisima/weak-and-strong-verification)
