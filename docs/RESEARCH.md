# Research: landscape + alternative project directions

*(Researched 2026-07-01. Companion to PLAN.md.)*

## What already exists (and what it means for us)

**Orchestration is becoming commodity.** Anthropic shipped official **agent teams**
in Claude Code (formerly the hidden "Swarms" feature, enabled via
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`), and there are at least six actively
maintained orchestrators around Claude Code: Claude Flow, Ruflo (~31k stars),
Claude Squad, ccpm, Swarm SDK, Mission Control, plus metaswarm (18 agents, TDD
enforcement, quality gates). Production setups already do the "define work in
Linear, swarm executes, Discord for human-in-the-loop, 24/7" pattern.
→ *Building a generic multi-agent orchestrator from scratch is re-inventing a
crowded wheel. The value is in what sits on top or underneath.*

**Company-simulation frameworks are old news.** MetaGPT (one-line requirement →
PRD, design docs, code, tests via simulated PM/architect/engineers) and ChatDev
2.0 "DevAll" (zero-code multi-agent workflow platform, ACL paper) cover the
"virtual software company" idea.
→ *The org-chart-as-prompt idea alone isn't novel; execution economics (tokens,
memory, uptime) and real-world grounding are where the gap is.*

**Self-improvement has a proven recipe.** Sakana's **Darwin Gödel Machine**
(ICLR 2026) evolves an *archive* of agent variants, keeps every variant, and
validates each self-modification empirically on benchmarks — SWE-bench 20%→50%.
Key insight: population + empirical validation beats a single agent patching
itself in place.
→ *Our "supervisor files a fix task" design is the weak version. The strong
version keeps an archive of runtime/role variants and lets benchmark results
pick winners.*

**Real AI-run businesses are a live research frontier.** Anthropic/Andon Labs'
Project Vend went from one hallucination-prone vending machine ("Claudius"
claiming to be human in a blue blazer) to AI-run stores and cafés in a year —
the agent even hired a barista (job posting → resume screen → phone interviews →
offer). Project Deal had agents close 186 real transactions (~$4k) in a week.
→ *"Agent org runs a real micro-business with real KPIs" is credible now, and
the failure modes (hallucinated payment details, giveaway discounts) tell us
exactly where the guardrails go: money and identity.*

**Memory is a measurable arms race.** Mem0's 2026 algorithm: 93.4% LongMemEval
at <7k tokens per retrieval vs 25k+ for full-context. Letta (MemGPT) has agents
self-edit core/recall/archival memory. Our planned index+entries+FTS design is
the same shape as the state of the art — the differentiator would be publishing
numbers.

## Alternative project directions

Ranked by (usefulness to Emma) × (achievability) × (novelty vs the landscape).

### A. "Night Shift" — the 24/7 backlog burner ⭐ pragmatic pick
Not a company simulation — a personal overnight workforce. Point it at your
repos + a backlog (GitHub issues / a TODO.md); it works through the night inside
token windows, opens PRs, and writes a **morning briefing** (what shipped, what's
blocked, what it wants approval for). Everything from PLAN.md's Phase 0–2 kernel
applies (queue, ledger, pause/resume); drop the org-chart theater and marketing
roles. Novelty: nobody has nailed the *token-window-aware scheduler* — squeezing
maximum value from a subscription's 5h reset windows is an optimization problem
(cheap tasks when budget is low, big refactors right after reset).
**Mini-plan:** Phase 0 kernel → GitHub issue intake → window-aware scheduler →
morning briefing generator → (later) grow roles back on top.

### B. Real micro-business operator (Project Vend, but SaaS)
Flip the fitness function: instead of "tasks completed", the org optimizes a
**real KPI** — MRR, signups, uptime of one deployed micro-SaaS. Agents read
Stripe/analytics via MCP, decide what to build/market next, and every dollar-
touching action goes through the approval queue (Vend's failures were all money
+ identity). This is the most ambitious version of the original vision and the
most interesting to write about publicly.
**Mini-plan:** pick one tiny product → deploy manually once → wire metrics MCP →
Director optimizes KPI deltas per token spent → weekly human "board meeting".

### C. Darwinian org evolution (DGM-lite)
Apply the Darwin Gödel Machine recipe to the *organization*, not the code: keep
an archive of role definitions / prompts / model-tier assignments; periodically
fork a variant org, run both on a benchmark task set (or A/B live tasks), keep
whichever spends fewer tokens per completed task. Self-optimization becomes
empirical selection instead of "agent patches its own runtime" — safer and
provably grounded.
**Mini-plan:** define org-config as versioned data (already in PLAN.md) → task
benchmark suite → variant runner in shadow mode → selection + archive.

### D. Agent Ops layer — build the missing infrastructure, not another swarm
Every orchestrator (Claude Flow, agent teams, metaswarm) has the same gaps:
token cost analytics, failure-pattern detection, memory compaction, budget
enforcement. Build the **ops/observability layer** that wraps *any* Claude Code
fleet: a ledger + dashboard + kill-switch + "why did this task cost 400k
tokens?" analyzer. Smallest scope, clearest gap, useful even for our own
projects on day one.
**Mini-plan:** hook-based usage capture (Claude Code hooks emit to SQLite) →
cost/failure dashboard → budget enforcement hooks → pluggable into agent teams.

### E. Token-frugal memory kernel as a product
Extract PLAN.md's memory design (hot index / warm entries / cold FTS +
compaction agent) into a standalone MCP server and benchmark it on LongMemEval
against Mem0/Letta. Success = a number ("X% at Y tokens"), which makes it the
most falsifiable project on this list.

### F. Swarm tournament harness
A meta-tool: pit orchestrator configurations (agent teams vs Claude Flow vs our
kernel; different org charts; different model tiers) against each other on a
standard task gauntlet, score on quality × tokens × wall-clock. Feeds C
directly, and the results are genuinely missing from the ecosystem (all current
comparisons are vibes and star counts).

## Recommendation

Keep the PLAN.md kernel (Phase 0–2: queue, dispatcher, token ledger,
window-aware pause/resume) — it's the shared foundation of every idea above.
Then choose the personality:

- **Want something useful in 2 weeks:** A (Night Shift), with D's usage-capture
  hooks built in from day one.
- **Want the ambitious flagship:** B (real micro-business), adopting C's
  evolutionary selection later instead of PLAN.md §5's riskier
  self-patching design.
- **Want the safest bet with a clear gap:** D (Agent Ops layer) — smallest,
  most differentiated, and every other idea needs it anyway.

A → D → C composes naturally into B over time.

## Sources

- [Claude Code multi-agent systems guide 2026 (eesel)](https://www.eesel.ai/blog/claude-code-multiple-agent-systems-complete-2026-guide)
- [Six Claude Code orchestrators compared (claudefa.st)](https://claudefa.st/blog/tools/orchestrators/multi-agent-orchestrators)
- [Claude Flow overview (Analytics Vidhya)](https://www.analyticsvidhya.com/blog/2026/03/claude-flow/)
- [metaswarm (GitHub)](https://github.com/dsifry/metaswarm)
- [OpenSwarm production field notes (ZHC Institute)](https://www.zhcinstitute.com/research/openswarm-multi-agent-orchestrator/)
- [MetaGPT (GitHub)](https://github.com/FoundationAgents/MetaGPT)
- [ChatDev 2.0 review](https://toolbrain.net/blog/chatdev-review-2026/)
- [Darwin Gödel Machine (Sakana AI)](https://sakana.ai/dgm/) · [paper](https://arxiv.org/abs/2505.22954)
- [Project Vend evolution (Fortune)](https://fortune.com/2026/06/02/anthropic-office-vending-machine-ai-agents-vendo-andon-lukas-petersson/)
- [Project Vend deep dive (IntuitionLabs)](https://intuitionlabs.ai/articles/andon-labs-project-vend-ai)
- [Project Deal marketplace (PYMNTS)](https://www.pymnts.com/artificial-intelligence-2/2026/anthropic-ran-a-marketplace-and-bots-closed-every-deal/)
- [State of AI agent memory 2026 (Mem0)](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [Mem0 vs Letta comparison (Vectorize)](https://vectorize.io/articles/mem0-vs-letta)
