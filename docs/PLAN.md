# SkeletonCrew — Autonomous Agent Organization Runtime

A long-running orchestrator that spins up a virtual "organization" of Claude Code
agents to manage a project end-to-end (planning, building, testing, marketing),
runs 24/7 with token-budget awareness, and improves its own runtime code when it
detects problems.

## 1. Core decisions (recommended defaults)

| Decision | Choice | Why |
|---|---|---|
| Runtime | TypeScript + Bun | Fast startup, single binary-ish deploys, good SQLite built-in |
| Claude integration | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) with raw `claude -p` fallback | The SDK *is* Claude Code programmatically: sessions, subagents, hooks, MCP, permission modes, and per-message `usage` data. Shelling out to `claude -p --output-format stream-json` remains a drop-in fallback. |
| State | SQLite (single file, WAL mode) | Task queue, memory index, token ledger, audit log — one dependency, trivially inspectable |
| Process model | One orchestrator daemon + ephemeral agent sessions | Agents are stateless workers; all durable state lives in SQLite + workspace files. Crash-safe by design. |
| 24/7 hosting | `launchd` (macOS) / `systemd` (Linux) with `KeepAlive` | Auto-restart on crash is also what makes self-optimization restarts safe |

## 2. Architecture

```
┌─────────────────────────── orchestrator daemon ───────────────────────────┐
│                                                                            │
│  Scheduler ──► Task Queue (SQLite) ──► Dispatcher ──► Agent Sessions       │
│      ▲              ▲                       │         (Claude Code, one    │
│      │              │                       │          per task, headless) │
│  Budget Manager ────┤                       ▼                              │
│  (token ledger,     │                  Result Handler ──► new tasks,       │
│   pause/resume)     │                       │             memory writes    │
│                     │                       ▼                              │
│  Supervisor ────────┘                  Memory Store (index + files)        │
│  (health, error patterns,                                                  │
│   self-optimization tasks)             Approval Queue (human gates)        │
└────────────────────────────────────────────────────────────────────────────┘
```

### The organization

Roles are **agent definitions**, not processes: a system prompt + allowed tools +
model tier + token budget, stored in `org/roles/*.md`. The org chart is data, so
the org can restructure itself by editing files.

Initial roles:

- **Director** (planner) — decomposes goals into tasks, prioritizes the queue. Runs on the big model, rarely.
- **Engineer** — implements tasks in a git worktree; opens internal "PRs" (branches).
- **Reviewer/QA** — reviews branches, writes/runs tests, merges or bounces back.
- **Ops** — deploys, monitors, handles infra tasks.
- **Marketing** — copy, landing pages, ad campaigns (via MCP servers, e.g. meta-ads); anything outward-facing goes through the approval queue.
- **Triage** (Haiku) — cheap classifier that routes inbound events and dedupes tasks before expensive agents see them.

Every role writes results as structured JSON (task outcome, follow-up tasks,
memory entries) — the orchestrator never parses prose.

### Task queue

`tasks` table: `id, role, title, spec, priority, status, depends_on, attempts,
max_attempts, tokens_spent, created_by, result`. Dispatcher rules:

- Respect dependencies and per-role concurrency caps (engineers get isolated git worktrees).
- Exponential backoff on failure; after `max_attempts`, escalate to Director with the error history.
- Everything is a task — including "improve the runtime" and "compact memory".

## 3. Token awareness (24/7 without burning out)

- **Ledger**: every session's `usage` (input/output/cache tokens per model) is recorded per task and per role in SQLite.
- **Budgets**: configurable daily budget plus rolling-window awareness. On subscription plans, limits reset on ~5h windows — when a session returns a rate-limit/limit-reached error, the Budget Manager parses the reset time, marks the queue `PAUSED`, and the scheduler sleeps until reset (with jitter). On API billing, it pauses at a configured $/day ceiling instead.
- **Tiering**: Triage and mechanical tasks run on Haiku; engineering on Sonnet; Director/architecture on the top model. The dispatcher picks the model from the role definition, and the Director can downgrade a task's tier.
- **Degraded mode**: when < 20% of budget remains, only priority-0 tasks (fix broken build, respond to alerts) dispatch; everything else queues for the next window.
- Pausing is safe because agents are ephemeral: an interrupted task just returns to `pending` and re-runs from its spec + memory, not from a half-dead session.

## 4. Memory system (fast, token-frugal)

Three layers, with the rule: **agents receive an index, never a dump**.

1. **Hot — `memory/INDEX.md`** (hard cap ~2k tokens): one line per memory entry
   (`- [slug] one-line hook`). Injected into every agent's context. That's the
   *only* unconditional memory cost per session.
2. **Warm — `memory/entries/*.md`**: one fact/decision/runbook per file with
   frontmatter (`type`, `role_scope`, `last_used`). Agents read specific entries
   on demand (they see the index and fetch what's relevant — ~200 tokens per
   fetch instead of 50k of history).
3. **Cold — SQLite full-text search** (`fts5`) over all task results, session
   summaries, and logs. Agents query it with a `memory_search` tool (an in-process
   MCP server) when the index doesn't cover something.

**Compaction agent** (scheduled task, Haiku): dedupes entries, merges stale ones,
evicts entries unused for N days to cold storage, and rewrites INDEX.md to stay
under the cap. Memory can grow forever; per-session cost stays flat.

## 5. Self-optimization loop

The Supervisor watches signals: task failure rates per role, repeated error
signatures, sessions that time out, budget anomalies, healthcheck latency. When a
pattern crosses a threshold it files a `runtime-improvement` task with the
evidence attached.

The improvement pipeline (all inside the normal task system):

1. **Engineer** clones the orchestrator's own repo into a worktree, makes the fix.
2. **Reviewer** runs the runtime's self-test suite + a smoke test (boot a shadow orchestrator against a copy of the DB, run 3 canned tasks).
3. On green: merge, then the daemon execs a graceful restart (`launchd` restarts it) with the previous version tagged.
4. **Rollback watchdog**: if the new version fails its healthcheck within 10 minutes, it reverts to the last good tag and files an incident task.

Hard guardrails (enforced by the runtime, not by prompts):

- The Budget Manager, guardrail module, and approval-queue code are **write-protected** — changes to those paths always require human approval.
- Self-changes are rate-limited (max N merges/day) and never happen while the queue is degraded.

## 6. Human gates

An `approvals` table + notification (push/CLI). Required for: spending money
(ads, infra), anything sent to external services (emails, posts, campaigns),
production deploys, and edits to protected runtime paths. Everything else is
autonomous. `skeletoncrew approve <id>` / a tiny web dashboard to review.

## 7. Interfaces

- `skeletoncrew status` — queue, budgets, running sessions, recent failures.
- `skeletoncrew goal "…"` — hand the Director a new objective.
- `skeletoncrew log <task-id>` — full transcript of any agent session.
- Small read-only web dashboard later (itself a task for the org to build).

## 8. Build phases

**Phase 0 — Kernel (the 20% that proves it):**
scaffold (bun + SQLite), task queue, dispatcher that runs one Claude Code session
per task via the Agent SDK, token ledger, structured-JSON results, `status` CLI.
*Exit test: give it "build a TODO web app", watch it plan → build → test unattended.*

**Phase 1 — Organization:** role definitions, Director planning loop, Triage
tier, git-worktree isolation, Reviewer gate, memory v1 (INDEX.md + entries +
compaction).

**Phase 2 — 24/7:** launchd service, budget windows with pause/resume on limit
errors, degraded mode, crash recovery test (kill -9 mid-task, verify resume).

**Phase 3 — Self-optimization:** Supervisor signals, self-test suite, shadow-boot
smoke test, protected paths, rollback watchdog.

**Phase 4 — SaaS playbook:** approval queue + notifications, Ops role (deploy to
Vercel/Fly via CLI), Marketing role wired to MCP servers (meta-ads is already
connected in this environment), FTS cold memory, dashboard.

## 9. Honest risks

- **Cost**: a 24/7 org can burn a Max subscription's full window every window. Budget tiering (Haiku triage) is not optional — it's the economics of the whole system.
- **Self-modification** is the riskiest feature; the shadow-boot smoke test and protected paths are load-bearing. Ship it last, after the org is boring and stable.
- **Drift**: autonomous planners generate plausible busywork. The Director prompt must optimize for "fewest tasks that advance the goal", and the human `goal` command is the steering wheel.
