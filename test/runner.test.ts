import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config";
import type { Task } from "../src/queue";
import { loadRoles, packageRolesDir, parseRole } from "../src/roles";
import { buildPrompt, parseAgentResult } from "../src/runner";

describe("parseAgentResult", () => {
  test("extracts the last json block", () => {
    const text = `I did the thing.

\`\`\`json
{"status": "done", "summary": "implemented feature X", "followUpTasks": [], "memoryNotes": []}
\`\`\``;
    const parsed = parseAgentResult(text)!;
    expect(parsed.status).toBe("done");
    expect(parsed.summary).toBe("implemented feature X");
  });

  test("tolerates prose after earlier json blocks and missing arrays", () => {
    const text = `\`\`\`json
{"irrelevant": true}
\`\`\`
final answer:
\`\`\`json
{"status": "failed", "summary": "tests are red"}
\`\`\``;
    const parsed = parseAgentResult(text)!;
    expect(parsed.status).toBe("failed");
    expect(parsed.followUpTasks).toEqual([]);
    expect(parsed.memoryNotes).toEqual([]);
  });

  test("passes dependsOnIndex through on follow-up tasks", () => {
    const text = `\`\`\`json
{"status": "done", "summary": "planned", "followUpTasks": [
  {"role": "engineer", "title": "build", "spec": "…"},
  {"role": "reviewer", "title": "verify", "spec": "…", "dependsOnIndex": [0]}
]}
\`\`\``;
    const parsed = parseAgentResult(text)!;
    expect(parsed.followUpTasks[1].dependsOnIndex).toEqual([0]);
  });

  test("returns null for garbage", () => {
    expect(parseAgentResult("no block here")).toBeNull();
    expect(parseAgentResult("```json\n{not json}\n```")).toBeNull();
  });
});

describe("roles", () => {
  test("parses frontmatter and body", () => {
    const role = parseRole(
      `---\nname: engineer\nmodel: claude-sonnet-5\nmaxTurns: 12\npermissionMode: acceptEdits\nallowedTools: [Read, Grep]\n---\nBe an engineer.`,
      "fallback",
      DEFAULTS,
    );
    expect(role.name).toBe("engineer");
    expect(role.maxTurns).toBe(12);
    expect(role.allowedTools).toEqual(["Read", "Grep"]);
    expect(role.systemPrompt).toBe("Be an engineer.");
  });

  test("falls back to config models by role name", () => {
    const role = parseRole("just a prompt, no frontmatter", "triage", DEFAULTS);
    expect(role.model).toBe(DEFAULTS.models.triage);
    expect(role.systemPrompt).toContain("just a prompt");
  });

  test("loadRoles ships defaults and lets the project override by name", () => {
    const root = mkdtempSync(join(tmpdir(), "skeletoncrew-test-"));
    mkdirSync(join(root, "org", "roles"), { recursive: true });
    writeFileSync(
      join(root, "org", "roles", "engineer.md"),
      "---\nname: engineer\nmaxTurns: 5\n---\nCustom engineer.",
    );
    writeFileSync(
      join(root, "org", "roles", "marketer.md"),
      "---\nname: marketer\n---\nYou market things.",
    );
    writeFileSync(join(root, "org", "roles", "README.md"), "# not a role");
    const roles = loadRoles(root, DEFAULTS);
    expect(roles.has("README")).toBe(false);
    expect(roles.get("director")?.source).toBe("default"); // shipped, not copied
    expect(roles.get("engineer")?.source).toBe("project"); // overridden
    expect(roles.get("engineer")?.maxTurns).toBe(5);
    expect(roles.get("marketer")?.source).toBe("project"); // added
    expect(roles.get("engineer")?.systemPrompt).toBe("Custom engineer.");
  });

  test("loadRoles does not double-load when project root IS the package", () => {
    const pkgRoot = join(packageRolesDir(), "..", "..");
    const roles = loadRoles(pkgRoot, DEFAULTS);
    expect(roles.get("engineer")?.source).toBe("default");
    expect(roles.size).toBeGreaterThanOrEqual(4);
  });
});

describe("buildPrompt", () => {
  test("includes task, previous error, memory index, and contract", () => {
    const task = {
      id: 7, role: "engineer", title: "Fix login", spec: "the button 404s",
      error: "previous: could not reproduce", attempts: 2, max_attempts: 3,
    } as Task;
    const role = parseRole("prompt", "engineer", DEFAULTS);
    const prompt = buildPrompt(task, role, "- [db-quirk] sqlite is in WAL mode");
    expect(prompt).toContain("Fix login");
    expect(prompt).toContain("the button 404s");
    expect(prompt).toContain("could not reproduce");
    expect(prompt).toContain("db-quirk");
    expect(prompt).toContain('"status"');
  });
});
