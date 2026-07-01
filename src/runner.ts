import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config";
import type { MemoryStore } from "./memory";
import type { Task } from "./queue";
import type { Role } from "./roles";

export interface AgentOutcome {
  ok: boolean;
  /** True when the failure was a usage/rate limit — dispatcher pauses instead of retrying. */
  limitHit: boolean;
  sessionId?: string;
  summary: string;
  followUpTasks: Array<{
    role: string;
    title: string;
    spec: string;
    priority?: number;
    /** Indices of earlier entries in this same array that must finish first. */
    dependsOnIndex?: number[];
  }>;
  memoryNotes: Array<{ slug: string; description: string; body: string }>;
  usage: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
  }>;
  totalTokens: number;
  totalCostUsd: number;
}

const RESULT_CONTRACT = `
When you are completely finished, end your final message with a fenced json block:

\`\`\`json
{
  "status": "done" | "failed" | "blocked",
  "summary": "1-3 sentences: what you did and the outcome",
  "followUpTasks": [
    {"role": "engineer", "title": "…", "spec": "…", "priority": 2},
    {"role": "reviewer", "title": "…", "spec": "…", "dependsOnIndex": [0]}
  ],
  "memoryNotes": [{"slug": "kebab-case-slug", "description": "one-line hook", "body": "the durable fact"}]
}
\`\`\`

Tasks run CONCURRENTLY unless ordered: use dependsOnIndex (indices of earlier entries in
followUpTasks) whenever one task needs another's output — e.g. a reviewer must depend on
the engineer task it reviews. followUpTasks and memoryNotes may be empty arrays. Only record memoryNotes for durable,
non-obvious facts a future agent would need — never restate what the code already shows.`;

export function buildPrompt(
  task: Task,
  role: Role,
  memoryIndex: string,
  branch?: string,
): string {
  return `You are the ${role.name} agent in the SkeletonCrew organization.

## Your task (id ${task.id}, attempt ${task.attempts}/${task.max_attempts})
**${task.title}**

${task.spec || "(no further spec — use your judgment)"}
${task.error ? `\n## Previous attempt failed with\n${task.error}\n` : ""}${
    branch
      ? `\n## Workspace\nYou are in an isolated git worktree on branch \`${branch}\` (already checked out).\nCommit your work to this branch. Do NOT switch branches, merge, or push.\n`
      : ""
  }
## Memory index
The organization's memory index is below. If an entry looks relevant, read it from memory/entries/<slug>.md before starting.

${memoryIndex}

## Result contract
${RESULT_CONTRACT}`;
}

/** Pull the trailing \`\`\`json block out of an agent's final message. */
export function parseAgentResult(text: string): {
  status: "done" | "failed" | "blocked";
  summary: string;
  followUpTasks: AgentOutcome["followUpTasks"];
  memoryNotes: AgentOutcome["memoryNotes"];
} | null {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (!last) return null;
  try {
    const parsed = JSON.parse(last);
    if (!parsed.status || !parsed.summary) return null;
    return {
      status: parsed.status,
      summary: String(parsed.summary),
      followUpTasks: Array.isArray(parsed.followUpTasks) ? parsed.followUpTasks : [],
      memoryNotes: Array.isArray(parsed.memoryNotes) ? parsed.memoryNotes : [],
    };
  } catch {
    return null;
  }
}

export async function runTask(
  task: Task,
  role: Role,
  config: Config,
  memory: MemoryStore,
  workspace?: { cwd: string; branch?: string; extraDirs?: string[] },
): Promise<AgentOutcome> {
  const prompt = buildPrompt(task, role, memory.readIndex(), workspace?.branch);
  const outcome: AgentOutcome = {
    ok: false,
    limitHit: false,
    summary: "",
    followUpTasks: [],
    memoryNotes: [],
    usage: [],
    totalTokens: 0,
    totalCostUsd: 0,
  };

  try {
    const session = query({
      prompt,
      options: {
        model: role.model,
        cwd: workspace?.cwd ?? task.cwd ?? config.workspace,
        ...(workspace?.extraDirs ? { additionalDirectories: workspace.extraDirs } : {}),
        // Headless sessions have no interactive approver, so un-allowed Bash
        // calls would be silently denied. OS-sandboxed commands are auto-approved
        // instead: full shell autonomy inside cwd + additionalDirectories, and
        // anything the sandbox can't contain still gets denied.
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          failIfUnavailable: false,
        },
        maxTurns: role.maxTurns,
        permissionMode: role.permissionMode,
        ...(role.allowedTools ? { allowedTools: role.allowedTools } : {}),
        systemPrompt: role.systemPrompt,
      },
    });

    for await (const message of session) {
      if (message.type !== "result") continue;
      outcome.sessionId = message.session_id;
      outcome.totalCostUsd = message.total_cost_usd ?? 0;
      for (const [model, u] of Object.entries(message.modelUsage ?? {})) {
        const usage = u as Record<string, number>;
        const rec = {
          model,
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cacheReadTokens: usage.cacheReadInputTokens ?? 0,
          cacheCreationTokens: usage.cacheCreationInputTokens ?? 0,
          costUsd: usage.costUSD ?? 0,
        };
        outcome.usage.push(rec);
        outcome.totalTokens += rec.inputTokens + rec.outputTokens;
      }

      if (message.subtype === "success") {
        const parsed = parseAgentResult(message.result);
        if (parsed) {
          outcome.ok = parsed.status === "done";
          outcome.summary = parsed.summary;
          outcome.followUpTasks = parsed.followUpTasks;
          outcome.memoryNotes = parsed.memoryNotes;
        } else {
          // No structured block — trust a non-error success but flag the contract miss.
          outcome.ok = !message.is_error;
          outcome.summary = message.result.slice(0, 2000);
        }
      } else {
        const errors = message.errors.length > 0 ? message.errors.join("; ") : message.subtype;
        outcome.summary = `session error (${message.subtype}): ${errors}`.slice(0, 2000);
        outcome.limitHit = isLimitText(errors);
      }
    }
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    outcome.summary = `runner exception: ${text}`.slice(0, 2000);
    outcome.limitHit = isLimitText(text);
  }
  return outcome;
}

function isLimitText(text: string): boolean {
  return /usage limit|rate limit|limit reached|overloaded|429|out of credits|credit balance/i.test(
    text,
  );
}
