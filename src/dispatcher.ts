import type { Database } from "bun:sqlite";
import { BudgetManager, isLimitError } from "./budget";
import type { Config } from "./config";
import { MemoryStore } from "./memory";
import {
  addTask,
  addTaskCost,
  claimNext,
  completeTask,
  failTask,
  recoverOrphans,
  releaseTask,
  type Task,
} from "./queue";
import { loadRoles, type Role } from "./roles";
import { runTask } from "./runner";

export class Dispatcher {
  private budget: BudgetManager;
  private memory: MemoryStore;
  private roles: Map<string, Role>;
  private inFlight = new Set<Promise<void>>();
  private stopping = false;
  private wake: (() => void) | null = null;

  constructor(
    private db: Database,
    private config: Config,
    private root: string = process.cwd(),
    private log: (msg: string) => void = (msg) =>
      console.log(`[${new Date().toISOString()}] ${msg}`),
  ) {
    this.budget = new BudgetManager(db, config);
    this.memory = new MemoryStore(root);
    this.roles = loadRoles(root, config);
  }

  stop(): void {
    this.stopping = true;
    this.wake?.();
  }

  /** Sleep that returns immediately when stop() is called. */
  private idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      this.wake = done;
      function done() {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  async run(): Promise<void> {
    const orphans = recoverOrphans(this.db);
    if (orphans > 0) this.log(`recovered ${orphans} orphaned running task(s) → pending`);
    this.log(
      `dispatcher up: roles=[${[...this.roles.keys()].join(", ")}] concurrency=${this.config.concurrency} billing=${this.config.billingMode}`,
    );

    while (!this.stopping) {
      if (this.budget.isPaused()) {
        const until = this.budget.pausedUntil();
        this.log(`budget paused until ${new Date(until).toISOString()} — sleeping`);
        await this.idle(Math.min(until - Date.now() + 1000, 10 * 60 * 1000));
        continue;
      }
      const ceiling = this.budget.enforceDailyCeiling();
      if (ceiling) {
        this.log(`daily budget ceiling hit — paused until ${new Date(ceiling).toISOString()}`);
        continue;
      }

      if (this.inFlight.size >= this.config.concurrency) {
        await Promise.race(this.inFlight);
        continue;
      }

      const degraded = this.budget.isDegraded();
      const task = claimNext(this.db, { degraded });
      if (!task) {
        await this.idle(this.config.pollIntervalSec * 1000);
        continue;
      }

      const job = this.execute(task, degraded).finally(() => this.inFlight.delete(job));
      this.inFlight.add(job);
    }
    if (this.inFlight.size > 0) {
      this.log(`draining ${this.inFlight.size} running task(s) — Ctrl-C again to force quit`);
    }
    await Promise.allSettled([...this.inFlight]);
    this.log("dispatcher stopped");
  }

  private async execute(task: Task, degraded: boolean): Promise<void> {
    const role = this.roles.get(task.role);
    if (!role) {
      failTask(this.db, { ...task, attempts: task.max_attempts }, `unknown role: ${task.role}`);
      this.log(`task ${task.id} failed: unknown role '${task.role}'`);
      return;
    }
    this.log(
      `task ${task.id} [${task.role}] "${task.title}" started${degraded ? " (degraded mode)" : ""}`,
    );

    const outcome = await runTask(task, role, this.config, this.memory);

    for (const u of outcome.usage) {
      this.budget.record({
        taskId: task.id,
        role: task.role,
        model: u.model,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheCreationTokens: u.cacheCreationTokens,
        costUsd: u.costUsd,
      });
    }
    addTaskCost(this.db, task.id, outcome.totalTokens, outcome.totalCostUsd);

    if (outcome.limitHit || isLimitError(outcome.summary)) {
      const until = this.budget.pauseForLimit(outcome.summary);
      releaseTask(this.db, task.id, until);
      this.log(
        `task ${task.id} hit a usage limit — queue paused until ${new Date(until).toISOString()}`,
      );
      return;
    }

    if (outcome.ok) {
      completeTask(this.db, task.id, outcome.summary, outcome.sessionId);
      for (const note of outcome.memoryNotes) {
        this.memory.addEntry(note.slug, note.description, note.body);
      }
      for (const follow of outcome.followUpTasks) {
        if (!this.roles.has(follow.role)) {
          this.log(`task ${task.id} proposed follow-up with unknown role '${follow.role}' — skipped`);
          continue;
        }
        const id = addTask(this.db, {
          role: follow.role,
          title: follow.title,
          spec: follow.spec,
          priority: follow.priority,
          cwd: task.cwd ?? undefined,
          createdBy: `task:${task.id}`,
        });
        this.log(`task ${task.id} → spawned follow-up ${id} [${follow.role}] "${follow.title}"`);
      }
      this.log(
        `task ${task.id} done (${outcome.totalTokens} tokens, $${outcome.totalCostUsd.toFixed(4)}): ${outcome.summary.slice(0, 120)}`,
      );
    } else {
      const status = failTask(this.db, task, outcome.summary, outcome.sessionId);
      this.log(
        `task ${task.id} attempt ${task.attempts} failed → ${status}: ${outcome.summary.slice(0, 160)}`,
      );
    }
  }
}
