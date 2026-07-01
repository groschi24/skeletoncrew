import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";

export interface Role {
  name: string;
  model: string;
  maxTurns: number;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  allowedTools?: string[];
  systemPrompt: string;
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
    model: front.model ?? config.models[name] ?? config.defaultModel,
    maxTurns: front.maxTurns ? Number(front.maxTurns) : ROLE_DEFAULTS.maxTurns,
    permissionMode: (front.permissionMode as Role["permissionMode"]) ?? ROLE_DEFAULTS.permissionMode,
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

export function loadRoles(root: string, config: Config): Map<string, Role> {
  const dir = join(root, "org", "roles");
  const roles = new Map<string, Role>();
  if (!existsSync(dir)) return roles;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const source = readFileSync(join(dir, file), "utf-8");
    const role = parseRole(source, file.replace(/\.md$/, ""), config);
    roles.set(role.name, role);
  }
  return roles;
}
