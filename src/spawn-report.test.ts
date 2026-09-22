import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnProfilePath } from "./spawn-profile";
import { spawnReport } from "./spawn-report";

function machine(): { DIM_HOME: string } {
  const home = mkdtempSync(join(tmpdir(), "dim-spawn-report-"));
  writeFileSync(join(home, "routing.json"), '{ "cheap": "small", "standard": "middling", "deep": "large" }');
  writeFileSync(
    join(home, "spawn.json"),
    JSON.stringify({
      argv: ["claude", "-p", "{brief}", "--model", "{model}", "--allowedTools", "{tools}"],
      slots: { tools: { join: "," } },
      grants: {
        "bootstrap-worker": { tools: ["Bash(dim worker bootstrap:*)"] },
        "read-files": { tools: ["Read", "Grep", "Glob"] },
        "read-history": { tools: ["Bash(git diff:*)"] },
        "ask-dim": { tools: ["Bash(dim q:*)"] },
        "raise-finding": { tools: ["Bash(dim order finding:*)"] },
      },
    }),
  );
  return { DIM_HOME: home };
}

describe("what a station would be started with", () => {
  test("elides the brief and names the profile it read", () => {
    const env = machine();

    const line = spawnReport("planner", env)[0] as string;

    expect(line).toBe(
      "claude -p <brief> --model large --allowedTools Bash(dim worker bootstrap:*),Read,Grep,Glob,Bash(git diff:*),Bash(dim q:*)",
    );
  });

  test("prints every role a station has declared capabilities for, with no argument", () => {
    const env = machine();

    const report = spawnReport(undefined, env).join("\n");

    expect(report).toContain("planner\tclaude -p <brief> --model large");
    expect(report).toContain(
      "reviewer\tclaude -p <brief> --model middling --allowedTools Bash(dim worker bootstrap:*),Read,Grep,Glob,Bash(git diff:*),Bash(dim q:*),Bash(dim order finding:*)",
    );
    expect(report).toContain(spawnProfilePath(env));
  });

  test("refuses a role no station has declared a capability set for", () => {
    const env = machine();

    expect(() => spawnReport("builder", env)).toThrow(/no capability set is declared/);
  });
});
