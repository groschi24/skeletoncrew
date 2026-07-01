import type { Database } from "bun:sqlite";
import type { BudgetManager } from "./budget";
import { getState, setState } from "./db";
import type { UsageSnapshot } from "./limits";
import { formatUsage } from "./limits";
import type { Task } from "./queue";

/**
 * The morning briefing: what the crew did while you were away. Built entirely
 * from the ledger and task table — costs zero tokens to produce.
 */

const LAST_BRIEFING_KEY = "last_briefing_at";

export function briefingSince(db: Database, fallbackHours = 24): number {
  const raw = getState(db, LAST_BRIEFING_KEY);
  return raw ? Number(raw) : Date.now() - fallbackHours * 3600_000;
}

export function markBriefed(db: Database, at: number): void {
  setState(db, LAST_BRIEFING_KEY, String(at));
}

export function generateBriefing(
  db: Database,
  budget: BudgetManager,
  sinceMs: number,
  now = Date.now(),
  usage: UsageSnapshot | null = null,
): string {
  const touched = db
    .query("SELECT * FROM tasks WHERE updated_at >= ? ORDER BY updated_at ASC")
    .all(sinceMs) as Task[];
  const open = db
    .query(
      "SELECT * FROM tasks WHERE status IN ('pending', 'running') ORDER BY priority ASC, created_at ASC",
    )
    .all() as Task[];

  const done = touched.filter((t) => t.status === "done");
  const failed = touched.filter((t) => t.status === "failed");
  const spent = budget.spentSince(sinceMs);
  const hours = Math.max(1, Math.round((now - sinceMs) / 3600_000));

  const lines: string[] = [];
  lines.push(`# SkeletonCrew briefing — ${new Date(now).toISOString().slice(0, 16).replace("T", " ")}`);
  lines.push("");
  lines.push(
    `Last ${hours}h: ${done.length} done, ${failed.length} failed, ${open.length} still open · ` +
      `${spent.tokens.toLocaleString()} tokens ($${spent.costUsd.toFixed(2)} est.)`,
  );
  if (usage) {
    lines.push("");
    for (const line of formatUsage(usage)) lines.push(line);
  }

  if (done.length > 0) {
    lines.push("", "## Completed");
    for (const t of done) {
      lines.push(
        `- #${t.id} [${t.role}] **${t.title}** — ${(t.result ?? "").slice(0, 200)} ` +
          `(${t.tokens_spent.toLocaleString()} tok, $${t.cost_usd.toFixed(2)})`,
      );
    }
  }

  if (failed.length > 0) {
    lines.push("", "## Failed — needs your attention");
    for (const t of failed) {
      lines.push(
        `- #${t.id} [${t.role}] **${t.title}** after ${t.attempts} attempts — ${(t.error ?? "").slice(0, 200)}`,
      );
      if (t.session_id) lines.push(`  transcript: claude --resume ${t.session_id}`);
    }
  }

  if (open.length > 0) {
    lines.push("", "## Queue");
    for (const t of open.slice(0, 10)) {
      lines.push(`- #${t.id} [${t.status}] (${t.role}, p${t.priority}) ${t.title}`);
    }
    if (open.length > 10) lines.push(`- …and ${open.length - 10} more`);
  }

  if (budget.isPaused()) {
    lines.push("", `⏸ Queue is paused until ${new Date(budget.pausedUntil()).toISOString()}`);
  }
  if (budget.limitStrikes() > 0) {
    lines.push("", `⚠ ${budget.limitStrikes()} unresolved limit strike(s) — the daemon hit usage limits recently`);
  }

  return lines.join("\n") + "\n";
}
