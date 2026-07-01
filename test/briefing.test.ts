import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { briefingSince, generateBriefing, markBriefed } from "../src/briefing";
import { BudgetManager } from "../src/budget";
import { DEFAULTS } from "../src/config";
import { openDb } from "../src/db";
import { addTask, addTaskCost, claimNext, completeTask, failTask } from "../src/queue";

let db: Database;
let budget: BudgetManager;
beforeEach(() => {
  db = openDb(":memory:");
  budget = new BudgetManager(db, DEFAULTS);
});

describe("generateBriefing", () => {
  test("reports done, failed, and open work with spend", () => {
    const since = Date.now() - 1000;
    const a = addTask(db, { role: "engineer", title: "Ship feature" });
    claimNext(db);
    addTaskCost(db, a, 5000, 0.25);
    completeTask(db, a, "Implemented and tested [branch: task/1-ship-feature]", "sess-1");

    addTask(db, { role: "engineer", title: "Broken thing", maxAttempts: 1 });
    const failing = claimNext(db)!;
    failTask(db, failing, "kaboom", "sess-2");

    addTask(db, { role: "reviewer", title: "Waiting work" });
    budget.record({
      taskId: a, role: "engineer", model: "m",
      inputTokens: 4000, outputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUsd: 0.25,
    });

    const report = generateBriefing(db, budget, since);
    expect(report).toContain("1 done, 1 failed, 1 still open");
    expect(report).toContain("Ship feature");
    expect(report).toContain("branch: task/1-ship-feature");
    expect(report).toContain("## Failed — needs your attention");
    expect(report).toContain("claude --resume sess-2");
    expect(report).toContain("Waiting work");
    expect(report).toContain("5,000 tokens ($0.25 est.)");
  });

  test("only includes tasks touched since the cutoff", () => {
    const old = addTask(db, { role: "engineer", title: "Ancient history" });
    claimNext(db);
    completeTask(db, old, "done long ago");
    const report = generateBriefing(db, budget, Date.now() + 1000);
    expect(report).not.toContain("Ancient history");
    expect(report).toContain("0 done, 0 failed");
  });

  test("briefingSince uses last briefing mark, falling back to 24h", () => {
    const fallback = briefingSince(db);
    expect(Date.now() - fallback).toBeGreaterThan(23 * 3600_000);
    markBriefed(db, 1234567);
    expect(briefingSince(db)).toBe(1234567);
  });

  test("surfaces pause state and limit strikes", () => {
    budget.pauseForLimit("usage limit reached");
    const report = generateBriefing(db, budget, Date.now() - 1000);
    expect(report).toContain("Queue is paused until");
    expect(report).toContain("limit strike");
  });
});
