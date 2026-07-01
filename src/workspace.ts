import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Config } from "./config";
import type { Task } from "./queue";
import type { Role } from "./roles";

/**
 * Workspace preparation for a task. Roles with `isolation: worktree` get a
 * fresh git worktree on a task branch, so concurrent agents never trample
 * each other's working tree. The branch survives cleanup; the reviewer
 * merges or deletes it.
 */

export interface Workspace {
  cwd: string;
  /** Task branch when worktree isolation is active. */
  branch?: string;
  /** Why isolation was skipped, if it was requested but not possible. */
  note?: string;
  cleanup: () => void;
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");
}

export function branchName(taskId: number, title: string): string {
  return `task/${taskId}-${slugify(title)}`;
}

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  return {
    ok: proc.exitCode === 0,
    out: (proc.stdout.toString() + proc.stderr.toString()).trim(),
  };
}

function isGitRepo(dir: string): boolean {
  return existsSync(dir) && git(["rev-parse", "--is-inside-work-tree"], dir).ok;
}

export function prepareWorkspace(task: Task, role: Role, config: Config): Workspace {
  const base = resolve(task.cwd ?? config.workspace);
  const plain: Workspace = { cwd: base, cleanup: () => {} };
  if (role.isolation !== "worktree") return plain;
  if (!isGitRepo(base)) {
    return { ...plain, note: "worktree isolation skipped: workspace is not a git repository" };
  }

  const branch = branchName(task.id, task.title);
  // Keep worktrees outside the repo so they never dirty the main working tree.
  const dir = join(dirname(base), ".skeletoncrew-worktrees", String(task.id));
  // A previous attempt may have left the worktree/branch behind — reset both.
  git(["worktree", "remove", "--force", dir], base);
  const added = git(["worktree", "add", "-B", branch, dir], base);
  if (!added.ok) {
    return { ...plain, note: `worktree isolation skipped: ${added.out.slice(0, 200)}` };
  }
  return {
    cwd: dir,
    branch,
    cleanup: () => {
      // Commits live on the branch; only the checkout directory goes away.
      git(["worktree", "remove", "--force", dir], base);
    },
  };
}
