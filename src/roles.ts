import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Config } from "./config";

export interface Role {
  name: string;
  model: string;
  maxTurns: number;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  allowedTools?: string[];
  systemPrompt: string;
  /** "worktree" gives each task an isolated git worktree on its own branch. */
  isolation?: "worktree";
  /** Where this role definition came from: shipped default or project override. */
  source: "default" | "project";
}

const ROLE_DEFAULTS = {
  maxTurns: 50,
  permissionMode: "acceptEdits" as const,
};

/** Parse a role file: minimal YAML-ish frontmatter (key: value, flat) + markdown body. */
export function parseRole(source: string, fallbackName: string, config: Config): Role {
  let front: Record<string, string> = {};
  let body = source;
  const match = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (match) {
    body = source.slice(match[0].length);
    for (const line of match[1].split("\n")) {
      const kv = line.match(/^(\w+):\s*(.+)$/);
      if (kv) front[kv[1]] = kv[2].trim();
    }
  }
  const name = front.name ?? fallbackName;
  return {
    name,
    source: "default",
    model: front.model ?? config.models[name] ?? config.defaultModel,
    maxTurns: front.maxTurns ? Number(front.maxTurns) : ROLE_DEFAULTS.maxTurns,
    permissionMode: (front.permissionMode as Role["permissionMode"]) ?? ROLE_DEFAULTS.permissionMode,
    isolation: front.isolation === "worktree" ? "worktree" : undefined,
    allowedTools: front.allowedTools
      ? front.allowedTools
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    systemPrompt: body.trim(),
  };
}

/** The role definitions shipped with the SkeletonCrew package itself. */
export function packageRolesDir(): string {
  return join(dirname(import.meta.dir), "org", "roles");
}

function loadDir(
  dir: string,
  source: Role["source"],
  config: Config,
  into: Map<string, Role>,
): void {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md") || file.toLowerCase() === "readme.md") continue;
    const text = readFileSync(join(dir, file), "utf-8");
    const role = parseRole(text, file.replace(/\.md$/, ""), config);
    into.set(role.name, { ...role, source });
  }
}

/**
 * Shipped defaults first, then the project's org/roles/ as overrides (matched by
 * role name). Projects never hold copies of the defaults, so upgrading the
 * package upgrades every install's roles automatically.
 */
export function loadRoles(
  root: string,
  config: Config,
  defaultsDir: string = packageRolesDir(),
): Map<string, Role> {
  const roles = new Map<string, Role>();
  loadDir(defaultsDir, "default", config, roles);
  const projectDir = join(root, "org", "roles");
  if (resolve(projectDir) !== resolve(defaultsDir)) {
    loadDir(projectDir, "project", config, roles);
  }
  return roles;
}
