# Contributing

Thanks for your interest! SkeletonCrew is early — the kernel (queue, dispatcher, budget,
memory) is in place and the roadmap in the README lists what's next.

## Setup

```bash
bun install
bun test        # unit tests (no API calls)
bunx tsc        # typecheck
```

## Ground rules

- **No hand-written dependency versions.** Add deps with `bun add <pkg>` so the
  lockfile stays authoritative.
- **Tests for kernel logic.** Queue, budget, and parsing changes need unit tests;
  they run without any Claude API access.
- **Token frugality is a feature.** Changes that inject more unconditional context
  into agent sessions (bigger prompts, bigger memory index) need a strong argument.
- **Safety-relevant code** (budget enforcement, permission modes, the future approval
  queue) gets extra scrutiny — explain the failure modes in your PR description.

## Architecture

Read [docs/PLAN.md](docs/PLAN.md) first. Short version: one dispatcher loop
(`src/dispatcher.ts`), tasks in SQLite (`src/queue.ts`), each task runs as an
ephemeral Claude Code session (`src/runner.ts`) whose usage is written to a ledger
(`src/budget.ts`); roles are markdown in `org/roles/` (`src/roles.ts`).
