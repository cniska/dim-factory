import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planCodexTrust } from "./codex-trust";
import { ConfigError } from "./config-error";
import { hookCommand } from "./hooks";
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
  // A hook whose position cannot be read has no trust key, which reads as a hook
  // Codex will not run — so a comment in the file has to not cost it one.
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

  // Reporting an unreadable file as three untrusted hooks sends the reader to
  // approve a hook in Codex, which is not what is wrong with it.
  test("raises the parse failure rather than reporting every hook untrusted", () => {
    const env = codexEnv(() => '{ "hooks": ');
    expect(() => planCodexTrust(env)).toThrow(ConfigError);
  });
});
