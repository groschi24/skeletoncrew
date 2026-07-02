#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { briefingSince, generateBriefing, markBriefed } from "./briefing";
import { BudgetManager } from "./budget";
import { DEFAULTS, loadConfig } from "./config";
import { openDb } from "./db";
import { Dispatcher } from "./dispatcher";
import { fetchUsage, formatUsage } from "./limits";
import { addTask, getTask, listTasks } from "./queue";
import { loadRoles } from "./roles";

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
    const configPath = join(root, "skeletoncrew.json");
    if (!existsSync(configPath)) {
      writeFileSync(configPath, JSON.stringify(DEFAULTS, null, 2) + "\n");
      console.log("wrote skeletoncrew.json");
    }
    const rolesDir = join(root, "org", "roles");
    mkdirSync(rolesDir, { recursive: true });
    const rolesReadme = join(rolesDir, "README.md");
    if (!existsSync(rolesReadme)) {
      writeFileSync(
        rolesReadme,
        `# Role overrides

Default roles (director, engineer, reviewer, triage) ship with SkeletonCrew and load
automatically — run \`skeletoncrew roles\` to see them. Drop a \`<name>.md\` file here
to override a default (matched by role name) or to add a new role.
`,
      );
    }
    mkdirSync(join(root, "memory", "entries"), { recursive: true });
    mkdirSync(loadConfig(root).workspace, { recursive: true });
    openDb(loadConfig(root).dbPath);
    console.log("initialized: skeletoncrew.json, org/roles/ (overrides), memory/, workspace/, database");
    console.log("default roles load from the package — see `skeletoncrew roles`");
    console.log("next: `skeletoncrew goal \"…\"` and `skeletoncrew daemon`");
    break;
  }

  case "add": {
    const [role, title] = positional();
    if (!role || !title) {
      console.error('usage: skeletoncrew add <role> "<title>" [--spec "…"] [--priority N] [--cwd path]');
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
      console.error('usage: skeletoncrew goal "<objective>"');
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
    if (config.billingMode === "subscription") {
      const usage = await fetchUsage();
      if (usage) for (const line of formatUsage(usage)) console.log(line);
      else console.log("live usage: unavailable (no Claude Code OAuth credentials found)");
    }
    const spent = budget.spentToday();
    const counts = new Map<string, number>();
    for (const t of listTasks(db, { limit: 10000 })) {
      counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
    }
    console.log(`queue: ${[...counts.entries()].map(([s, n]) => `${n} ${s}`).join(", ") || "empty"}`);
    console.log(`today: ${spent.tokens.toLocaleString()} tokens, $${spent.costUsd.toFixed(2)} (mode: ${config.billingMode})`);
    const win = budget.spentThisWindow();
    const week = budget.spentThisWeek();
    const winCap = config.softWindowTokens > 0 ? `/${config.softWindowTokens.toLocaleString()}` : "";
    const weekCap = config.softWeeklyTokens > 0 ? `/${config.softWeeklyTokens.toLocaleString()}` : "";
    console.log(
      `this ${config.windowHours}h window: ${win.tokens.toLocaleString()}${winCap} tokens · rolling 7d: ${week.tokens.toLocaleString()}${weekCap} tokens` +
        (budget.limitStrikes() > 0 ? ` · limit strikes: ${budget.limitStrikes()}` : ""),
    );
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

  case "briefing": {
    const config = loadConfig(root);
    const db = openDb(config.dbPath);
    const budget = new BudgetManager(db, config);
    const since = flag("since") ? Date.now() - Number(flag("since")) * 3600_000 : briefingSince(db);
    const usage = config.billingMode === "subscription" ? await fetchUsage() : null;
    const report = generateBriefing(db, budget, since, Date.now(), usage);
    console.log(report);
    mkdirSync(join(root, "briefings"), { recursive: true });
    const file = join(root, "briefings", `${new Date().toISOString().slice(0, 10)}.md`);
    writeFileSync(file, report);
    markBriefed(db, Date.now());
    console.log(`saved to ${file}`);
    break;
  }

  case "roles": {
    const config = loadConfig(root);
    for (const role of loadRoles(root, config).values()) {
      console.log(
        `${role.name.padEnd(12)} ${role.model.padEnd(28)} maxTurns=${String(role.maxTurns).padEnd(4)} ${role.permissionMode.padEnd(13)} [${role.source}]`,
      );
    }
    break;
  }

  case "retry": {
    const id = Number(positional()[0]);
    const db = openDb(loadConfig(root).dbPath);
    const task = getTask(db, id);
    if (!task) {
      console.error(`no task ${id}`);
      process.exit(1);
    }
    db.query(
      "UPDATE tasks SET status = 'pending', attempts = 0, not_before = 0, updated_at = ? WHERE id = ?",
    ).run(Date.now(), id);
    console.log(`task ${id} reset to pending (attempts cleared, previous error kept as context)`);
    break;
  }

  case "resume": {
    const config = loadConfig(root);
    const db = openDb(config.dbPath);
    new BudgetManager(db, config).clearPause();
    console.log("pause cleared");
    break;
  }

  case "service": {
    if (process.platform !== "darwin") {
      console.error("service generation currently supports macOS (launchd) only");
      process.exit(1);
    }
    const { homedir } = await import("node:os");
    const { basename } = await import("node:path");
    const label = `com.skeletoncrew.${basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${import.meta.path}</string>
    <string>daemon</string>
  </array>
  <key>WorkingDirectory</key><string>${root}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(root, "daemon.log")}</string>
  <key>StandardErrorPath</key><string>${join(root, "daemon.log")}</string>
</dict>
</plist>
`;
    writeFileSync(plistPath, plist);
    console.log(`wrote ${plistPath}`);
    console.log(`\nstart 24/7:  launchctl load ${plistPath}`);
    console.log(`stop:        launchctl unload ${plistPath}`);
    console.log(`logs:        tail -f ${join(root, "daemon.log")}`);
    break;
  }

  case "daemon": {
    const config = loadConfig(root);
    const db = openDb(config.dbPath);
    const dispatcher = new Dispatcher(db, config, root);
    // A 24/7 daemon must survive SDK-internal async crashes (e.g. Bun's readline
    // shim throwing during subprocess-error cleanup). The affected session still
    // resolves as a failed task through the normal path.
    process.on("uncaughtException", (err) => {
      console.error(`[daemon] uncaught exception (continuing): ${err?.message ?? err}`);
    });
    process.on("unhandledRejection", (err) => {
      console.error(`[daemon] unhandled rejection (continuing): ${err instanceof Error ? err.message : err}`);
    });
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
    console.log(`skeletoncrew — token-aware agent organization runtime

usage:
  skeletoncrew init                     scaffold config, roles dir, memory, database
  skeletoncrew goal "<objective>"       hand the director a new objective
  skeletoncrew add <role> "<title>"     queue a task directly (--spec, --priority, --cwd)
  skeletoncrew daemon                   run the 24/7 dispatcher loop
  skeletoncrew service                  write a launchd plist so the daemon runs 24/7 (macOS)
  skeletoncrew status                   queue, budget, pause state
  skeletoncrew roles                    active roles and whether default or project override
  skeletoncrew briefing [--since h]     what the crew did since the last briefing (saved to briefings/)
  skeletoncrew log <id>                 task detail + session transcript pointer
  skeletoncrew retry <id>               reset a failed task to pending with fresh attempts
  skeletoncrew resume                   clear a budget pause manually`);
}
