#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BudgetManager } from "./budget";
import { DEFAULTS, loadConfig } from "./config";
import { openDb } from "./db";
import { Dispatcher } from "./dispatcher";
import { addTask, getTask, listTasks } from "./queue";

const root = process.cwd();
const [command, ...args] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function positional(): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) i++;
    else out.push(args[i]);
  }
  return out;
}

switch (command) {
  case "init": {
    const configPath = join(root, "autoagents.json");
    if (!existsSync(configPath)) {
      writeFileSync(configPath, JSON.stringify(DEFAULTS, null, 2) + "\n");
      console.log("wrote autoagents.json");
    }
    const rolesDir = join(root, "org", "roles");
    mkdirSync(rolesDir, { recursive: true });
    if (readdirSync(rolesDir).length === 0) {
      const defaults = join(dirname(import.meta.dir), "org", "roles");
      for (const file of readdirSync(defaults)) {
        copyFileSync(join(defaults, file), join(rolesDir, file));
      }
      console.log("seeded default roles: director, engineer, reviewer, triage");
    }
    mkdirSync(join(root, "memory", "entries"), { recursive: true });
    mkdirSync(loadConfig(root).workspace, { recursive: true });
    openDb(loadConfig(root).dbPath);
    console.log("initialized: autoagents.json, org/roles/, memory/, workspace/, database");
    console.log("next: add role files to org/roles/, then `autoagents goal \"…\"` and `autoagents daemon`");
    break;
  }

  case "add": {
    const [role, title] = positional();
    if (!role || !title) {
      console.error('usage: autoagents add <role> "<title>" [--spec "…"] [--priority N] [--cwd path]');
      process.exit(1);
    }
    const db = openDb(loadConfig(root).dbPath);
    const id = addTask(db, {
      role,
      title,
      spec: flag("spec"),
      priority: flag("priority") ? Number(flag("priority")) : undefined,
      cwd: flag("cwd"),
    });
    console.log(`task ${id} queued [${role}] "${title}"`);
    break;
  }

  case "goal": {
    const [text] = positional();
    if (!text) {
      console.error('usage: autoagents goal "<objective>"');
      process.exit(1);
    }
    const db = openDb(loadConfig(root).dbPath);
    const id = addTask(db, {
      role: "director",
      title: `Plan: ${text.slice(0, 80)}`,
      spec: `New objective from the human operator:\n\n${text}\n\nDecompose this into the smallest set of tasks that advances it. Queue them as followUpTasks.`,
      priority: 1,
    });
    console.log(`goal handed to director as task ${id}`);
    break;
  }

  case "status": {
    const config = loadConfig(root);
    const db = openDb(config.dbPath);
    const budget = new BudgetManager(db, config);
    const spent = budget.spentToday();
    const counts = new Map<string, number>();
    for (const t of listTasks(db, { limit: 10000 })) {
      counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
    }
    console.log(`queue: ${[...counts.entries()].map(([s, n]) => `${n} ${s}`).join(", ") || "empty"}`);
    console.log(`today: ${spent.tokens.toLocaleString()} tokens, $${spent.costUsd.toFixed(2)} (mode: ${config.billingMode})`);
    if (budget.isPaused()) {
      console.log(`PAUSED until ${new Date(budget.pausedUntil()).toISOString()}`);
    } else if (budget.isDegraded()) {
      console.log("DEGRADED: only priority-0 tasks dispatch");
    }
    for (const t of listTasks(db, { limit: 15 })) {
      console.log(
        `  #${t.id} [${t.status}] (${t.role}, p${t.priority}) ${t.title}` +
          (t.error && t.status !== "done" ? ` — ${t.error.slice(0, 80)}` : ""),
      );
    }
    break;
  }

  case "log": {
    const id = Number(positional()[0]);
    const db = openDb(loadConfig(root).dbPath);
    const task = getTask(db, id);
    if (!task) {
      console.error(`no task ${id}`);
      process.exit(1);
    }
    console.log(JSON.stringify(task, null, 2));
    if (task.session_id) {
      console.log(`\nfull transcript: claude --resume ${task.session_id}`);
    }
    break;
  }

  case "resume": {
    const config = loadConfig(root);
    const db = openDb(config.dbPath);
    new BudgetManager(db, config).clearPause();
    console.log("pause cleared");
    break;
  }

  case "daemon": {
    const config = loadConfig(root);
    const db = openDb(config.dbPath);
    const dispatcher = new Dispatcher(db, config, root);
    let signals = 0;
    const shutdown = () => {
      signals++;
      if (signals >= 2) {
        console.log("\nforce quit — interrupted tasks will be recovered on next start");
        process.exit(130);
      }
      dispatcher.stop();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await dispatcher.run();
    break;
  }

  default:
    console.log(`autoagents — token-aware agent organization runtime

usage:
  autoagents init                     scaffold config, roles dir, memory, database
  autoagents goal "<objective>"       hand the director a new objective
  autoagents add <role> "<title>"     queue a task directly (--spec, --priority, --cwd)
  autoagents daemon                   run the 24/7 dispatcher loop
  autoagents status                   queue, budget, pause state
  autoagents log <id>                 task detail + session transcript pointer
  autoagents resume                   clear a budget pause manually`);
}
