import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { BudgetManager, isLimitError, nextWindowBoundary, parseResetTime } from "../src/budget";
import { DEFAULTS, type Config } from "../src/config";
import { openDb } from "../src/db";

let db: Database;
beforeEach(() => {
  db = openDb(":memory:");
});

const apiConfig: Config = { ...DEFAULTS, billingMode: "api", dailyBudgetUsd: 10 };

describe("BudgetManager", () => {
  test("records usage and sums spend", () => {
    const budget = new BudgetManager(db, apiConfig);
    budget.record({
      taskId: 1,
      role: "engineer",
      model: "claude-sonnet-5",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 2.5,
    });
    expect(budget.spentToday()).toEqual({ costUsd: 2.5, tokens: 1500 });
    expect(budget.remainingFraction()).toBeCloseTo(0.75);
    expect(budget.isDegraded()).toBe(false);
  });

  test("degraded below threshold, ceiling pauses to midnight", () => {
    const budget = new BudgetManager(db, apiConfig);
    const spend = (costUsd: number) =>
      budget.record({
        taskId: null, role: "engineer", model: "m",
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUsd,
      });
    spend(8.5);
    expect(budget.isDegraded()).toBe(true);
    expect(budget.enforceDailyCeiling()).toBeNull();
    spend(2);
    const until = budget.enforceDailyCeiling();
    expect(until).toBeGreaterThan(Date.now());
    expect(budget.isPaused()).toBe(true);
    budget.clearPause();
    expect(budget.isPaused()).toBe(false);
  });

  test("pauseForLimit falls back to window boundary", () => {
    const budget = new BudgetManager(db, { ...DEFAULTS });
    const until = budget.pauseForLimit("usage limit reached, no timestamp here");
    expect(until).toBeGreaterThan(Date.now());
    expect(until - Date.now()).toBeLessThanOrEqual(DEFAULTS.windowHours * 3600_000 + 3 * 60_000);
    expect(budget.isPaused()).toBe(true);
  });

  test("consecutive limit strikes escalate the pause; success resets", () => {
    const budget = new BudgetManager(db, { ...DEFAULTS });
    const first = budget.pauseForLimit("usage limit reached");
    expect(budget.limitStrikes()).toBe(1);
    const second = budget.pauseForLimit("usage limit reached");
    expect(budget.limitStrikes()).toBe(2);
    expect(second - first).toBeGreaterThanOrEqual(30 * 60_000); // +30min escalation
    const third = budget.pauseForLimit("usage limit reached");
    expect(third - first).toBeGreaterThanOrEqual(120 * 60_000); // +2h escalation
    budget.noteSuccess();
    expect(budget.limitStrikes()).toBe(0);
  });

  test("weekly limit without timestamp pauses ~24h instead of next window", () => {
    const budget = new BudgetManager(db, { ...DEFAULTS });
    const until = budget.pauseForLimit("You have reached your weekly limit");
    expect(until - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(until - Date.now()).toBeLessThanOrEqual(25 * 3600_000);
  });

  test("soft window cap self-pauses before the hard limit", () => {
    const budget = new BudgetManager(db, { ...DEFAULTS, softWindowTokens: 1000 });
    budget.record({
      taskId: null, role: "engineer", model: "m",
      inputTokens: 900, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUsd: 0.1,
    });
    const capped = budget.enforceSoftCaps();
    expect(capped).not.toBeNull();
    expect(capped!.reason).toContain("soft window cap");
    expect(budget.isPaused()).toBe(true);
  });

  test("soft weekly cap pauses with hourly recheck", () => {
    const budget = new BudgetManager(db, { ...DEFAULTS, softWeeklyTokens: 500 });
    budget.record({
      taskId: null, role: "engineer", model: "m",
      inputTokens: 600, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUsd: 0.1,
    });
    const capped = budget.enforceSoftCaps();
    expect(capped!.reason).toContain("weekly");
    expect(capped!.until - Date.now()).toBeLessThanOrEqual(60 * 60_000 + 1000);
  });

  test("no soft caps configured → never self-pauses", () => {
    const budget = new BudgetManager(db, { ...DEFAULTS });
    budget.record({
      taskId: null, role: "engineer", model: "m",
      inputTokens: 1e9, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUsd: 0.1,
    });
    expect(budget.enforceSoftCaps()).toBeNull();
  });
});

describe("limit parsing", () => {
  test("isLimitError matches common phrasings", () => {
    expect(isLimitError("Claude AI usage limit reached")).toBe(true);
    expect(isLimitError("429 rate limit exceeded")).toBe(true);
    expect(isLimitError("syntax error in foo.ts")).toBe(false);
  });

  test("parseResetTime handles ISO timestamps", () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(parseResetTime(`limit resets at ${future}`)).toBeCloseTo(Date.parse(future), -3);
  });

  test("parseResetTime handles clock times, rolling to tomorrow if past", () => {
    const t = parseResetTime("Your limit will reset at 3am");
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThan(Date.now());
    expect(new Date(t!).getHours()).toBe(3);
  });

  test("nextWindowBoundary lands on the 5h grid with jitter margin", () => {
    const now = new Date();
    now.setHours(7, 30, 0, 0); // inside the 05:00–10:00 window
    const next = nextWindowBoundary(now.getTime(), 5);
    const boundary = new Date(next - 2 * 60_000);
    expect(boundary.getHours()).toBe(10);
    expect(boundary.getMinutes()).toBe(0);
  });
});
