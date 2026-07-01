import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Live usage limits for the logged-in Claude Code account, from the same
 * endpoint the CLI's /usage screen uses. Read-only; degrades to null when
 * credentials or network are unavailable (e.g. API-key billing).
 */

export interface WindowUsage {
  /** Percent of the window consumed, 0-100. */
  utilization: number;
  /** ISO timestamp when the window resets, if known. */
  resetsAt: string | null;
}

export interface UsageSnapshot {
  fiveHour: WindowUsage | null;
  sevenDay: WindowUsage | null;
  fetchedAt: number;
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** Claude Code stores OAuth creds in the macOS Keychain, or ~/.claude/.credentials.json elsewhere. */
export async function getOAuthToken(): Promise<string | null> {
  try {
    if (process.platform === "darwin") {
      const proc = Bun.spawnSync([
        "security",
        "find-generic-password",
        "-s",
        "Claude Code-credentials",
        "-w",
      ]);
      if (proc.exitCode === 0) {
        const creds = JSON.parse(proc.stdout.toString());
        return creds?.claudeAiOauth?.accessToken ?? null;
      }
    }
    const file = join(homedir(), ".claude", ".credentials.json");
    if (existsSync(file)) {
      const creds = JSON.parse(readFileSync(file, "utf-8"));
      return creds?.claudeAiOauth?.accessToken ?? null;
    }
  } catch {
    // fall through — usage display is best-effort
  }
  return null;
}

export function parseUsagePayload(payload: unknown): UsageSnapshot {
  const data = payload as Record<string, { utilization?: number; resets_at?: string } | null>;
  const window = (key: string): WindowUsage | null => {
    const w = data?.[key];
    if (!w || typeof w.utilization !== "number") return null;
    return { utilization: w.utilization, resetsAt: w.resets_at ?? null };
  };
  return { fiveHour: window("five_hour"), sevenDay: window("seven_day"), fetchedAt: Date.now() };
}

export async function fetchUsage(): Promise<UsageSnapshot | null> {
  const token = await getOAuthToken();
  if (!token) return null;
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return parseUsagePayload(await res.json());
  } catch {
    return null;
  }
}

export function bar(percentLeft: number, width = 12): string {
  const filled = Math.round(Math.max(0, Math.min(100, percentLeft)) / (100 / width));
  return "[" + "=".repeat(filled) + "-".repeat(width - filled) + "]";
}

export function formatResetIn(resetsAt: string | null, now = Date.now()): string {
  if (!resetsAt) return "reset unknown";
  const ms = Date.parse(resetsAt) - now;
  if (Number.isNaN(ms) || ms <= 0) return "resets now";
  const totalMin = Math.round(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const minutes = totalMin % 60;
  const parts = [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`].filter(Boolean);
  return `resets in ${parts.join(" ") || "<1m"}`;
}

export function formatUsage(usage: UsageSnapshot): string[] {
  const line = (label: string, w: WindowUsage | null): string => {
    if (!w) return `${label}: unavailable`;
    const left = Math.max(0, 100 - w.utilization);
    return `${label}: ${left.toFixed(0)}% left ${bar(left)} ${formatResetIn(w.resetsAt, usage.fetchedAt)}`;
  };
  return [line("Session (5h)", usage.fiveHour), line("Weekly (7d) ", usage.sevenDay)];
}
