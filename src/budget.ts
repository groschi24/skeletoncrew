import type { Database } from "bun:sqlite";
import type { Config } from "./config";
import { getState, setState } from "./db";

export interface UsageRecord {
  taskId: number | null;
  role: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

const PAUSED_UNTIL_KEY = "paused_until";
const LIMIT_STRIKES_KEY = "limit_strikes";
const LAST_LIMIT_AT_KEY = "last_limit_at";

/** Consecutive limit hits escalate the pause by these extra minutes (capped at the last entry). */
const STRIKE_ESCALATION_MIN = [0, 30, 120, 480];
/** Strikes reset if the previous limit hit is older than this. */
const STRIKE_MEMORY_MS = 6 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export class BudgetManager {
  constructor(
    private db: Database,
    private config: Config,
  ) {}

  record(u: UsageRecord): void {
    this.db
      .query(
        `INSERT INTO ledger (task_id, role, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        u.taskId,
        u.role,
        u.model,
        u.inputTokens,
        u.outputTokens,
        u.cacheReadTokens,
        u.cacheCreationTokens,
        u.costUsd,
        Date.now(),
      );
  }

  spentSince(epochMs: number): { costUsd: number; tokens: number } {
    const row = this.db
      .query(
        `SELECT COALESCE(SUM(cost_usd), 0) AS cost,
                COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
         FROM ledger WHERE created_at >= ?`,
      )
      .get(epochMs) as { cost: number; tokens: number };
    return { costUsd: row.cost, tokens: row.tokens };
  }

  spentToday(): { costUsd: number; tokens: number } {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return this.spentSince(midnight.getTime());
  }

  /** Fraction of today's budget remaining (api mode). Subscription mode has no dollar meter, so 1 unless paused. */
  remainingFraction(): number {
    if (this.config.billingMode !== "api") return this.isPaused() ? 0 : 1;
    const spent = this.spentToday().costUsd;
    return Math.max(0, 1 - spent / this.config.dailyBudgetUsd);
  }

  isDegraded(): boolean {
    return this.remainingFraction() < this.config.degradedThreshold && this.remainingFraction() > 0;
  }

  isPaused(): boolean {
    return this.pausedUntil() > Date.now();
  }

  pausedUntil(): number {
    const raw = getState(this.db, PAUSED_UNTIL_KEY);
    return raw ? Number(raw) : 0;
  }

  /**
   * Called when a session hits a usage/rate limit. Pauses until the reset time
   * parsed from the error (falling back to the next window boundary, or 24h for
   * weekly limits), escalated by consecutive-strike backoff so a wrong guess
   * can never turn into a resume→limit→resume hammering loop.
   */
  pauseForLimit(errorText: string): number {
    const now = Date.now();
    const lastLimit = Number(getState(this.db, LAST_LIMIT_AT_KEY) ?? 0);
    const strikes =
      now - lastLimit < STRIKE_MEMORY_MS
        ? Number(getState(this.db, LIMIT_STRIKES_KEY) ?? 0) + 1
        : 1;
    setState(this.db, LIMIT_STRIKES_KEY, String(strikes));
    setState(this.db, LAST_LIMIT_AT_KEY, String(now));

    const isWeekly = /week/i.test(errorText);
    const base =
      parseResetTime(errorText) ??
      (isWeekly ? now + 24 * 60 * 60 * 1000 : nextWindowBoundary(now, this.config.windowHours));
    const escalationMin =
      STRIKE_ESCALATION_MIN[Math.min(strikes - 1, STRIKE_ESCALATION_MIN.length - 1)];
    const until = base + escalationMin * 60 * 1000;
    setState(this.db, PAUSED_UNTIL_KEY, String(until));
    return until;
  }

  pauseUntil(epochMs: number): void {
    setState(this.db, PAUSED_UNTIL_KEY, String(epochMs));
  }

  /** Call after any successful session: proves the limit is gone, resets strike escalation. */
  noteSuccess(): void {
    setState(this.db, LIMIT_STRIKES_KEY, "0");
  }

  limitStrikes(): number {
    return Number(getState(this.db, LIMIT_STRIKES_KEY) ?? 0);
  }

  /** Spend inside the current N-hour limit window (grid from midnight). */
  spentThisWindow(): { costUsd: number; tokens: number } {
    const windowMs = this.config.windowHours * 60 * 60 * 1000;
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const start =
      midnight.getTime() + Math.floor((Date.now() - midnight.getTime()) / windowMs) * windowMs;
    return this.spentSince(start);
  }

  spentThisWeek(): { costUsd: number; tokens: number } {
    return this.spentSince(Date.now() - WEEK_MS);
  }

  /**
   * Proactive throttle: self-pause BEFORE hitting the provider's hard limit when
   * soft token ceilings are configured. Returns the pause end + reason, or null.
   */
  enforceSoftCaps(): { until: number; reason: string } | null {
    if (this.config.softWindowTokens > 0) {
      const { tokens } = this.spentThisWindow();
      if (tokens >= this.config.softWindowTokens) {
        const until = nextWindowBoundary(Date.now(), this.config.windowHours);
        setState(this.db, PAUSED_UNTIL_KEY, String(until));
        return {
          until,
          reason: `soft window cap (${tokens.toLocaleString()}/${this.config.softWindowTokens.toLocaleString()} tokens)`,
        };
      }
    }
    if (this.config.softWeeklyTokens > 0) {
      const { tokens } = this.spentThisWeek();
      if (tokens >= this.config.softWeeklyTokens) {
        // Rolling window: re-evaluate hourly as old ledger entries age out.
        const until = Date.now() + 60 * 60 * 1000;
        setState(this.db, PAUSED_UNTIL_KEY, String(until));
        return {
          until,
          reason: `soft weekly cap (${tokens.toLocaleString()}/${this.config.softWeeklyTokens.toLocaleString()} tokens, rechecks hourly)`,
        };
      }
    }
    return null;
  }

  /** api mode: pause to midnight when the daily ceiling is hit. */
  enforceDailyCeiling(): number | null {
    if (this.config.billingMode !== "api") return null;
    if (this.spentToday().costUsd < this.config.dailyBudgetUsd) return null;
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    setState(this.db, PAUSED_UNTIL_KEY, String(midnight.getTime()));
    return midnight.getTime();
  }

  clearPause(): void {
    setState(this.db, PAUSED_UNTIL_KEY, "0");
  }
}

export function isLimitError(text: string): boolean {
  return /usage limit|rate limit|limit reached|overloaded|429|out of credits|credit balance/i.test(
    text,
  );
}

/** Extract a reset timestamp from limit-error text like "resets at 3am" / "try again at 2026-07-02T03:00:00Z". */
export function parseResetTime(text: string): number | null {
  const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/);
  if (iso) {
    const t = Date.parse(iso[0]);
    if (!Number.isNaN(t) && t > Date.now()) return t;
  }
  const epoch = text.match(/reset[^0-9]{0,20}(\d{10,13})/i);
  if (epoch) {
    let t = Number(epoch[1]);
    if (t < 1e12) t *= 1000;
    if (t > Date.now()) return t;
  }
  const clock = text.match(/resets? (?:at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (clock) {
    let hours = Number(clock[1]);
    const minutes = Number(clock[2] ?? 0);
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    const d = new Date();
    d.setHours(hours, minutes, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

/** Next boundary of the N-hour window grid (from midnight), plus 2min jitter margin. */
export function nextWindowBoundary(now: number, windowHours: number): number {
  const windowMs = windowHours * 60 * 60 * 1000;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const elapsed = now - midnight.getTime();
  const next = midnight.getTime() + Math.ceil((elapsed + 1) / windowMs) * windowMs;
  return next + 2 * 60 * 1000;
}
