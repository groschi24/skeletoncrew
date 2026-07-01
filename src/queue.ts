import type { Database } from "bun:sqlite";

export type TaskStatus = "pending" | "running" | "done" | "failed" | "blocked";

export interface Task {
  id: number;
  role: string;
  title: string;
  spec: string;
  cwd: string | null;
  priority: number;
  status: TaskStatus;
  depends_on: string;
  attempts: number;
  max_attempts: number;
  not_before: number;
  created_by: string;
  result: string | null;
  error: string | null;
  session_id: string | null;
  tokens_spent: number;
  cost_usd: number;
  created_at: number;
  updated_at: number;
}

export interface NewTask {
  role: string;
  title: string;
  spec?: string;
  cwd?: string;
  priority?: number;
  dependsOn?: number[];
  createdBy?: string;
  maxAttempts?: number;
}

export function addTask(db: Database, t: NewTask): number {
  const now = Date.now();
  const res = db
    .query(
      `INSERT INTO tasks (role, title, spec, cwd, priority, depends_on, created_by, max_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      t.role,
      t.title,
      t.spec ?? "",
      t.cwd ?? null,
      t.priority ?? 2,
      JSON.stringify(t.dependsOn ?? []),
      t.createdBy ?? "human",
      t.maxAttempts ?? 3,
      now,
      now,
    );
  return Number(res.lastInsertRowid);
}

/**
 * Atomically claim the next dispatchable task: pending, past its backoff time,
 * all dependencies done, best priority first. In degraded mode only priority-0
 * tasks are eligible.
 */
export function claimNext(db: Database, opts: { degraded?: boolean } = {}): Task | null {
  const now = Date.now();
  const maxPriority = opts.degraded ? 0 : 999;
  const claim = db.transaction((): Task | null => {
    const candidates = db
      .query(
        `SELECT * FROM tasks
         WHERE status = 'pending' AND not_before <= ? AND priority <= ?
         ORDER BY priority ASC, created_at ASC LIMIT 20`,
      )
      .all(now, maxPriority) as Task[];
    for (const task of candidates) {
      const deps: number[] = JSON.parse(task.depends_on);
      const unmet = deps.filter((id) => {
        const dep = db.query("SELECT status FROM tasks WHERE id = ?").get(id) as
          | { status: string }
          | null;
        return dep !== null && dep.status !== "done";
      });
      if (unmet.length > 0) continue;
      db.query(
        "UPDATE tasks SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?",
      ).run(now, task.id);
      return { ...task, status: "running", attempts: task.attempts + 1 };
    }
    return null;
  });
  return claim();
}

export function completeTask(db: Database, id: number, result: string, sessionId?: string): void {
  db.query(
    "UPDATE tasks SET status = 'done', result = ?, session_id = ?, updated_at = ? WHERE id = ?",
  ).run(result, sessionId ?? null, Date.now(), id);
}

/** Fail a task: retries with exponential backoff until max_attempts, then marks failed. */
export function failTask(db: Database, task: Task, error: string, sessionId?: string): TaskStatus {
  const now = Date.now();
  if (task.attempts >= task.max_attempts) {
    db.query(
      "UPDATE tasks SET status = 'failed', error = ?, session_id = ?, updated_at = ? WHERE id = ?",
    ).run(error, sessionId ?? null, now, task.id);
    return "failed";
  }
  const backoffMs = Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** (task.attempts - 1));
  db.query(
    "UPDATE tasks SET status = 'pending', error = ?, not_before = ?, session_id = ?, updated_at = ? WHERE id = ?",
  ).run(error, now + backoffMs, sessionId ?? null, now, task.id);
  return "pending";
}

/** Return a running task to pending without consuming an attempt's backoff (e.g. limit pause). */
export function releaseTask(db: Database, id: number, notBefore: number): void {
  db.query(
    "UPDATE tasks SET status = 'pending', attempts = attempts - 1, not_before = ?, updated_at = ? WHERE id = ?",
  ).run(notBefore, Date.now(), id);
}

export function addTaskCost(db: Database, id: number, tokens: number, costUsd: number): void {
  db.query(
    "UPDATE tasks SET tokens_spent = tokens_spent + ?, cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?",
  ).run(tokens, costUsd, Date.now(), id);
}

export function getTask(db: Database, id: number): Task | null {
  return (db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Task) ?? null;
}

export function listTasks(db: Database, opts: { status?: string; limit?: number } = {}): Task[] {
  if (opts.status) {
    return db
      .query("SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, created_at ASC LIMIT ?")
      .all(opts.status, opts.limit ?? 100) as Task[];
  }
  return db
    .query("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?")
    .all(opts.limit ?? 100) as Task[];
}

/** Recovery on daemon start: any task stuck in 'running' from a crashed run goes back to pending. */
export function recoverOrphans(db: Database): number {
  const res = db
    .query(
      "UPDATE tasks SET status = 'pending', attempts = attempts - 1, updated_at = ? WHERE status = 'running'",
    )
    .run(Date.now());
  return res.changes;
}
