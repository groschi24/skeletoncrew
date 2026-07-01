import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  /** Directory agents work in. For Night Shift mode, point this at your repo. */
  workspace: string;
  /** SQLite database file. */
  dbPath: string;
  /** Max concurrent agent sessions. */
  concurrency: number;
  /** Seconds between queue polls when idle. */
  pollIntervalSec: number;
  /** "subscription" pauses on limit errors until the window resets; "api" enforces dailyBudgetUsd. */
  billingMode: "subscription" | "api";
  /** Daily spend ceiling in USD (api mode). */
  dailyBudgetUsd: number;
  /** Below this fraction of remaining budget, only priority-0 tasks dispatch. */
  degradedThreshold: number;
  /** Subscription limit windows reset every N hours. */
  windowHours: number;
  /** Default model per role name; roles can override in their frontmatter. */
  models: Record<string, string>;
  defaultModel: string;
}

export const DEFAULTS: Config = {
  workspace: "./workspace",
  dbPath: "./autoagents.db",
  concurrency: 2,
  pollIntervalSec: 15,
  billingMode: "subscription",
  dailyBudgetUsd: 20,
  degradedThreshold: 0.2,
  windowHours: 5,
  models: {
    director: "claude-opus-4-8",
    engineer: "claude-sonnet-5",
    reviewer: "claude-sonnet-5",
    triage: "claude-haiku-4-5-20251001",
  },
  defaultModel: "claude-sonnet-5",
};

export function loadConfig(root: string = process.cwd()): Config {
  const path = join(root, "autoagents.json");
  if (!existsSync(path)) return { ...DEFAULTS };
  const user = JSON.parse(readFileSync(path, "utf-8"));
  return { ...DEFAULTS, ...user, models: { ...DEFAULTS.models, ...user.models } };
}
