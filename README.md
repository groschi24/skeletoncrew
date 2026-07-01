# SkeletonCrew

**A token-aware, 24/7 agent organization runtime built on Claude Code.**

SkeletonCrew runs a small "organization" of Claude Code agents — director, engineers,
reviewer, triage — against a durable task queue. It is designed around the constraint
every always-on agent system actually dies on: **tokens**. It tracks every session's
usage in a ledger, pauses cleanly when a usage limit is hit, resumes when the window
resets, and keeps per-session memory cost flat no matter how much history accumulates.

```
skeletoncrew goal "Ship dark mode across the app"
skeletoncrew daemon        # runs 24/7, pauses/resumes around token limits
skeletoncrew status        # queue, spend, pause state
```

## How it works

- **One daemon, ephemeral agents.** The dispatcher is the only long-running process.
  Every task runs as a fresh headless Claude Code session (via the
  [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)).
  All durable state lives in SQLite — kill the daemon mid-task and it recovers.
- **Organization as data.** Roles are markdown files in `org/roles/` (system prompt +
  model tier + permission mode in frontmatter). Agents return a structured JSON result:
  outcome, follow-up tasks, memory notes. The runtime never parses prose.
- **Token awareness.** Every session's per-model usage lands in a ledger. Subscription
  mode parses the reset time out of limit errors and sleeps until the window turns
  over; API mode enforces a daily dollar ceiling. Below 20% budget, only priority-0
  tasks dispatch. Cheap work runs on cheap models (triage is Haiku by default).
- **Never hammers the provider.** Consecutive limit hits escalate the pause
  (+30min/+2h/+8h strikes, reset by a successful session), weekly limits get a
  conservative 24h pause, and optional soft caps (`softWindowTokens`,
  `softWeeklyTokens`) make the daemon throttle itself *before* ever touching your
  plan's hard limits — leaving headroom for your interactive use.
- **Flat-cost memory.** Agents get a capped index (`memory/INDEX.md`, ~2k tokens) —
  never a history dump — and read individual entries on demand. Memory grows forever;
  per-session cost doesn't.

## Quick start

Requires [Bun](https://bun.sh) and [Claude Code](https://claude.com/claude-code) (logged in).

```bash
git clone https://github.com/groschi24/skeletoncrew && cd skeletoncrew
bun install

# in the project you want the org to work on:
cd ~/my-project
bun /path/to/skeletoncrew/src/cli.ts init      # scaffolds config, roles, memory, db
bun /path/to/skeletoncrew/src/cli.ts goal "Fix all TODO comments in src/"
bun /path/to/skeletoncrew/src/cli.ts daemon
```

Edit `skeletoncrew.json` to point `workspace` at the repo the agents should work in and
choose `billingMode`: `"subscription"` (pause on limit errors until the window resets)
or `"api"` (enforce `dailyBudgetUsd`).

## CLI

| Command | What it does |
|---|---|
| `init` | Scaffold config, default roles, memory, database |
| `goal "<objective>"` | Hand the director an objective; it decomposes into tasks |
| `add <role> "<title>" [--spec … --priority N --cwd path]` | Queue a task directly |
| `daemon` | Run the dispatcher loop (24/7; SIGINT drains gracefully) |
| `status` | Queue counts, today's spend, pause/degraded state, recent tasks |
| `log <id>` | Task detail + `claude --resume` pointer to the full transcript |
| `roles` | Active roles and whether each is a shipped default or project override |
| `briefing [--since h]` | Morning report: done/failed/open since last briefing, spend, limits (saved to `briefings/`) |
| `resume` | Manually clear a budget pause |

Run 24/7 under `launchd`/`systemd` with restart-on-exit; the queue recovers orphaned
tasks on boot.

## Roles

A role is a markdown file:

```markdown
---
name: engineer
model: claude-sonnet-5
maxTurns: 80
permissionMode: acceptEdits
---
You are an Engineer… (system prompt)
```

Defaults shipped: **director** (plans, never implements — optimizes for the fewest
tasks that advance the goal), **engineer** (implements on a branch, runs tests),
**reviewer** (merges only on green tests, bounces work back otherwise), **triage**
(Haiku-tier filter that keeps noise away from expensive agents).

Defaults load from the package at runtime — your project's `org/roles/` holds only
*overrides* (matched by role name) and additions, so upgrading SkeletonCrew upgrades
the default roles everywhere. `skeletoncrew roles` shows what's active and from where.

## Roadmap

See [docs/PLAN.md](docs/PLAN.md) for the full architecture and phase plan, and
[docs/RESEARCH.md](docs/RESEARCH.md) for the landscape research behind the design.

- [x] Phase 0 — kernel: queue, dispatcher, ledger, structured results, CLI
- [x] Phase 1a — git-worktree isolation (roles with `isolation: worktree` get a fresh
      checkout on a `task/<id>-<slug>` branch; commits survive, trees never collide)
- [x] Phase 2a — morning briefing (`skeletoncrew briefing`, zero-token, from the ledger)
- [x] Phase 1b — memory compaction: a Haiku-tier librarian role is queued
      automatically when `memory/INDEX.md` nears its cap
- [x] Phase 2b — `skeletoncrew service` (launchd, 24/7 with KeepAlive) and
      window-aware scheduling: expensive-model roles defer past
      `deferExpensiveAtUtilization` (default 70%) of the live 5h window, so
      Opus-tier planning burns budget early and Haiku work fills the tail
- [ ] systemd template (Linux)
- [ ] Phase 3 — self-optimization via empirical selection over org-config variants
      (Darwin-Gödel-style archive, not in-place self-patching)
- [ ] Phase 4 — approval queue for money/outward-facing actions, ops + marketing roles

## Safety posture

Agents run with `acceptEdits` (or stricter) permission modes, work on branches, and a
reviewer role gates merges. Anything irreversible or outward-facing is designed to go
through a human approval queue (Phase 4); until then, don't give the org credentials
you wouldn't give a new contractor on day one.

## License

MIT
