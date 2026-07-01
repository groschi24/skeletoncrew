import type { Database } from "bun:sqlite";
import { BudgetManager, isLimitError } from "./budget";
import type { Config } from "./config";
import { fetchUsage, formatUsage, type UsageSnapshot } from "./limits";
import { MemoryStore } from "./memory";
import {
  addTask,
  addTaskCost,
  claimNext,
  completeTask,
  failTask,
  findDuplicate,
  recoverOrphans,
  releaseTask,
  type Task,
} from "./queue";
import { loadRoles, type Role } from "./roles";
import { runTask } from "./runner";
import { prepareWorkspace } from "./workspace";

export class Dispatcher {
  private budget: BudgetManager;
  private memory: MemoryStore;
  private roles: Map<string, Role>;
  private inFlight = new Set<Promise<void>>();
  private stopping = false;
  private wake: (() => void) | null = null;
  private usage: UsageSnapshot | null = null;

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
    await this.refreshUsage();
    if (this.usage) for (const line of formatUsage(this.usage)) this.log(line);

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
      const softCap = this.budget.enforceSoftCaps();
      if (softCap) {
        this.log(`${softCap.reason} — paused until ${new Date(softCap.until).toISOString()}`);
        continue;
      }
      await this.refreshUsage();
      if (await this.enforceLiveUtilization()) continue;

      if (this.inFlight.size >= this.config.concurrency) {
        await Promise.race(this.inFlight);
        continue;
      }

      const degraded = this.budget.isDegraded() || this.weeklyDegraded();
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

  /** Refresh the live usage snapshot at most every 5 minutes; best-effort. */
  private async refreshUsage(): Promise<void> {
    if (this.config.billingMode !== "subscription") return;
    if (this.usage && Date.now() - this.usage.fetchedAt < 5 * 60 * 1000) return;
    const fresh = await fetchUsage();
    if (fresh) this.usage = fresh;
  }

  /** Pause proactively when the live 5h window is nearly exhausted. Returns true if paused. */
  private async enforceLiveUtilization(): Promise<boolean> {
    const threshold = this.config.pauseAtUtilization;
    const fiveHour = this.usage?.fiveHour;
    if (!threshold || !fiveHour || fiveHour.utilization < threshold) return false;
    const resetMs = fiveHour.resetsAt ? Date.parse(fiveHour.resetsAt) : NaN;
    const until = Number.isNaN(resetMs) || resetMs <= Date.now()
      ? Date.now() + 15 * 60 * 1000
      : resetMs + 60 * 1000;
    this.budget.pauseUntil(until);
    this.log(
      `live 5h utilization at ${fiveHour.utilization.toFixed(0)}% (≥${threshold}%) — pausing until ${new Date(until).toISOString()} to protect the account`,
    );
    return true;
  }

  private weeklyDegraded(): boolean {
    const threshold = this.config.degradeAtWeeklyUtilization;
    const sevenDay = this.usage?.sevenDay;
    return Boolean(threshold && sevenDay && sevenDay.utilization >= threshold);
  }

  private async execute(task: Task, degraded: boolean): Promise<void> {
    const role = this.roles.get(task.role);
    if (!role) {
      failTask(this.db, { ...task, attempts: task.max_attempts }, `unknown role: ${task.role}`);
      this.log(`task ${task.id} failed: unknown role '${task.role}'`);
      return;
    }
    const workspace = prepareWorkspace(task, role, this.config);
    if (workspace.note) this.log(`task ${task.id}: ${workspace.note}`);
    this.log(
      `task ${task.id} [${task.role}] "${task.title}" started${workspace.branch ? ` on ${workspace.branch}` : ""}${degraded ? " (degraded mode)" : ""}`,
    );

    let outcome: Awaited<ReturnType<typeof runTask>>;
    try {
      outcome = await runTask(task, role, this.config, this.memory, workspace);
    } finally {
      workspace.cleanup();
    }

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
      const strikes = this.budget.limitStrikes();
      this.log(
        `task ${task.id} hit a usage limit (strike ${strikes}) — queue paused until ${new Date(until).toISOString()}`,
      );
      return;
    }
    this.budget.noteSuccess();

    if (outcome.ok) {
      if (workspace.branch) outcome.summary += ` [branch: ${workspace.branch}]`;
      completeTask(this.db, task.id, outcome.summary, outcome.sessionId);
      for (const note of outcome.memoryNotes) {
        this.memory.addEntry(note.slug, note.description, note.body);
      }
      const createdIds: Array<number | null> = [];
      outcome.followUpTasks.forEach((follow, index) => {
        if (!this.roles.has(follow.role)) {
          this.log(`task ${task.id} proposed follow-up with unknown role '${follow.role}' — skipped`);
          createdIds.push(null);
          return;
        }
        const dupe = findDuplicate(this.db, follow.role, follow.title);
        if (dupe) {
          this.log(
            `task ${task.id} proposed follow-up duplicating open task #${dupe.id} ("${dupe.title}") — skipped`,
          );
          createdIds.push(dupe.id);
          return;
        }
        // Map dependsOnIndex (positions in this batch) to the real ids created above.
        const dependsOn = (follow.dependsOnIndex ?? [])
          .filter((i) => Number.isInteger(i) && i >= 0 && i < index)
          .map((i) => createdIds[i])
          .filter((id): id is number => id !== null);
        const id = addTask(this.db, {
          role: follow.role,
          title: follow.title,
          spec: follow.spec,
          priority: follow.priority,
          cwd: task.cwd ?? undefined,
          dependsOn,
          createdBy: `task:${task.id}`,
        });
        createdIds.push(id);
        this.log(
          `task ${task.id} → spawned follow-up ${id} [${follow.role}] "${follow.title}"` +
            (dependsOn.length ? ` (after ${dependsOn.map((d) => `#${d}`).join(", ")})` : ""),
        );
      });
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
