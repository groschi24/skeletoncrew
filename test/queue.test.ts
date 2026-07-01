import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import {
  addTask,
  claimNext,
  completeTask,
  failTask,
  findDuplicate,
  getTask,
  recoverOrphans,
  releaseTask,
} from "../src/queue";

let db: Database;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("queue", () => {
  test("claims by priority then age", () => {
    addTask(db, { role: "engineer", title: "later", priority: 2 });
    const urgent = addTask(db, { role: "engineer", title: "urgent", priority: 0 });
    expect(claimNext(db)?.id).toBe(urgent);
  });

  test("respects dependencies", () => {
    const a = addTask(db, { role: "engineer", title: "a", priority: 1 });
    const b = addTask(db, { role: "reviewer", title: "b", priority: 0, dependsOn: [a] });
    expect(claimNext(db)?.id).toBe(a);
    expect(claimNext(db)).toBeNull(); // b blocked, a running
    completeTask(db, a, "done");
    expect(claimNext(db)?.id).toBe(b);
  });

  test("degraded mode only dispatches priority 0", () => {
    addTask(db, { role: "engineer", title: "normal", priority: 1 });
    expect(claimNext(db, { degraded: true })).toBeNull();
    const critical = addTask(db, { role: "engineer", title: "critical", priority: 0 });
    expect(claimNext(db, { degraded: true })?.id).toBe(critical);
  });

  test("failTask retries with backoff then fails permanently", () => {
    const id = addTask(db, { role: "engineer", title: "flaky", maxAttempts: 2 });
    let task = claimNext(db)!;
    expect(failTask(db, task, "boom")).toBe("pending");
    // backoff: not claimable immediately
    expect(claimNext(db)).toBeNull();
    db.query("UPDATE tasks SET not_before = 0 WHERE id = ?").run(id);
    task = claimNext(db)!;
    expect(task.attempts).toBe(2);
    expect(failTask(db, task, "boom again")).toBe("failed");
    expect(getTask(db, id)?.status).toBe("failed");
  });

  test("releaseTask returns task without consuming an attempt", () => {
    const id = addTask(db, { role: "engineer", title: "paused mid-run" });
    const task = claimNext(db)!;
    expect(task.attempts).toBe(1);
    releaseTask(db, task.id, 0);
    const again = claimNext(db)!;
    expect(again.id).toBe(id);
    expect(again.attempts).toBe(1);
  });

  test("excludeRoles defers those roles except at priority 0", () => {
    addTask(db, { role: "director", title: "plan things", priority: 1 });
    const cheap = addTask(db, { role: "triage", title: "sort inbox", priority: 2 });
    expect(claimNext(db, { excludeRoles: ["director"] })?.id).toBe(cheap);
    expect(claimNext(db, { excludeRoles: ["director"] })).toBeNull();
    const critical = addTask(db, { role: "director", title: "fix the fire", priority: 0 });
    expect(claimNext(db, { excludeRoles: ["director"] })?.id).toBe(critical);
  });

  test("findDuplicate matches open tasks by role and normalized title", () => {
    const id = addTask(db, { role: "reviewer", title: "Review todo.html implementation" });
    expect(findDuplicate(db, "reviewer", "review: todo.html  implementation!")?.id).toBe(id);
    expect(findDuplicate(db, "engineer", "Review todo.html implementation")).toBeNull();
    completeTask(db, id, "done");
    expect(findDuplicate(db, "reviewer", "Review todo.html implementation")).toBeNull();
  });

  test("recoverOrphans resets crashed running tasks", () => {
    addTask(db, { role: "engineer", title: "was running" });
    claimNext(db);
    expect(recoverOrphans(db)).toBe(1);
    expect(claimNext(db)?.attempts).toBe(1);
  });
});
