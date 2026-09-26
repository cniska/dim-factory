import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./config-error";
import { hookCommand, planHooks } from "./hooks";
import { planCodexTrust } from "./hooks-codex-trust";
import type { Env } from "./paths";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function codexEnv(hooksJson: (env: Env) => string): Env {
  const root = mkdtempSync(join(tmpdir(), "dim-codex-trust-"));
  roots.push(root);
  const codexDir = join(root, ".codex");
  const env: Env = { DIM_HOME: join(root, "home"), DIM_CODEX_DIR: codexDir };
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, "hooks.json"), hooksJson(env));
  return env;
}

describe("reading the codex hooks a trust key points at", () => {
  test("finds the hook's position in a hooks.json carrying comments", () => {
    const env = codexEnv(
      (e) => `{
  // written by dim install-hooks
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": ${JSON.stringify(hookCommand("codex", e))} }] }],
  }
}
`,
    );
    const start = planCodexTrust(env).find((t) => t.command === hookCommand("codex", env));
    expect(start?.key).toEndWith(":session_start:0:0");
  });

  test("reports every codex hook the installer plans", () => {
    const env = codexEnv(() => "{}");
    const planned = planHooks(env)
      .filter((p) => p.tool === "codex")
      .map((p) => `${p.event} ${p.command}`);
    const trust = planCodexTrust(env);
    expect(trust.map((t) => `${t.event} ${t.command}`)).toEqual(planned);
    expect(trust.map((t) => t.event)).toEqual([
      "SessionStart",
      "SessionStart",
      "SessionEnd",
      "PostToolUse",
      "PostToolUse",
    ]);
  });

  test("raises the parse failure rather than reporting every hook untrusted", () => {
    const env = codexEnv(() => '{ "hooks": ');
    expect(() => planCodexTrust(env)).toThrow(ConfigError);
  });
});
