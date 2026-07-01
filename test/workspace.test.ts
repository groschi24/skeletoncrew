import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config";
import type { Task } from "../src/queue";
import { parseRole } from "../src/roles";
import { branchName, prepareWorkspace, slugify } from "../src/workspace";

function fakeTask(id: number, title: string, cwd: string): Task {
  return { id, title, cwd } as Task;
}

const worktreeRole = parseRole(
  "---\nname: engineer\nisolation: worktree\n---\nprompt",
  "engineer",
  DEFAULTS,
);
const plainRole = parseRole("---\nname: triage\n---\nprompt", "triage", DEFAULTS);

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "skeletoncrew-ws-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repo });
  Bun.spawnSync(["git", "config", "user.email", "test@test"], { cwd: repo });
  Bun.spawnSync(["git", "config", "user.name", "test"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "hello");
  Bun.spawnSync(["git", "add", "."], { cwd: repo });
  Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: repo });
  return repo;
}

describe("naming", () => {
  test("slugify and branchName", () => {
    expect(slugify("Build single-file TODO app!")).toBe("build-single-file-todo-app");
    expect(branchName(7, "Fix the login button")).toBe("task/7-fix-the-login-button");
    expect(slugify("x".repeat(100)).length).toBeLessThanOrEqual(30);
  });
});

describe("prepareWorkspace", () => {
  test("plain role gets the base directory, no branch", () => {
    const repo = makeGitRepo();
    const ws = prepareWorkspace(fakeTask(1, "t", repo), plainRole, DEFAULTS);
    expect(ws.cwd).toBe(repo);
    expect(ws.branch).toBeUndefined();
  });

  test("worktree role in a non-git dir falls back with a note", () => {
    const dir = mkdtempSync(join(tmpdir(), "skeletoncrew-plain-"));
    const ws = prepareWorkspace(fakeTask(2, "t", dir), worktreeRole, DEFAULTS);
    expect(ws.cwd).toBe(dir);
    expect(ws.note).toContain("not a git repository");
  });

  test("worktree role gets an isolated checkout; commits survive cleanup", () => {
    const repo = makeGitRepo();
    const task = fakeTask(3, "Add feature", repo);
    const ws = prepareWorkspace(task, worktreeRole, DEFAULTS);
    expect(ws.branch).toBe("task/3-add-feature");
    expect(ws.cwd).not.toBe(repo);
    expect(existsSync(join(ws.cwd, "a.txt"))).toBe(true);

    writeFileSync(join(ws.cwd, "b.txt"), "new");
    Bun.spawnSync(["git", "add", "."], { cwd: ws.cwd });
    Bun.spawnSync(["git", "commit", "-m", "work"], { cwd: ws.cwd });
    ws.cleanup();

    expect(existsSync(ws.cwd)).toBe(false); // checkout removed
    const branches = Bun.spawnSync(["git", "branch", "--list", "task/*"], { cwd: repo })
      .stdout.toString();
    expect(branches).toContain("task/3-add-feature"); // branch survives
    // main working tree untouched
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
  });

  test("retry after crash resets a stale worktree instead of failing", () => {
    const repo = makeGitRepo();
    const task = fakeTask(4, "Retry me", repo);
    const first = prepareWorkspace(task, worktreeRole, DEFAULTS);
    expect(first.branch).toBeDefined();
    // no cleanup — simulate a crash, then a retry
    const second = prepareWorkspace(task, worktreeRole, DEFAULTS);
    expect(second.branch).toBe("task/4-retry-me");
    expect(second.note).toBeUndefined();
    second.cleanup();
  });
});
