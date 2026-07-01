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
  /**
   * Extra directories the session needs access to. A git worktree's commits
   * write metadata into the parent repo's .git — without this the sandbox
   * blocks `git commit` inside the worktree.
   */
  extraDirs?: string[];
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

/** Extract the task-branch tag a completed task's result carries. */
export function branchFromResult(result: string | null): string | null {
  return result?.match(/\[branch: ([^\]]+)\]/)?.[1] ?? null;
}

export function prepareWorkspace(
  task: Task,
  role: Role,
  config: Config,
  /** Branch to base the new worktree on (e.g. the unmerged branch of a dependency task). */
  baseBranch?: string,
): Workspace {
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
  const startPoint =
    baseBranch && git(["rev-parse", "--verify", baseBranch], base).ok ? [baseBranch] : [];
  const added = git(["worktree", "add", "-B", branch, dir, ...startPoint], base);
  if (!added.ok) {
    return { ...plain, note: `worktree isolation skipped: ${added.out.slice(0, 200)}` };
  }
  return {
    cwd: dir,
    branch,
    extraDirs: [base],
    cleanup: () => {
      // Commits live on the branch; only the checkout directory goes away.
      git(["worktree", "remove", "--force", dir], base);
    },
  };
}
