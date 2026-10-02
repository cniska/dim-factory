import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scratchEnv } from "./fixtures.test-support";

function installHooks(root: string) {
  const run = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "cli.ts"), "hooks", "install"], {
    env: { ...process.env, ...scratchEnv(root), HOME: root },
  });
  expect(run.exitCode).toBe(0);
  return JSON.parse(run.stdout.toString()).result;
}

test("hooks install reports the hooks it added, and none on a second run", () => {
  const root = mkdtempSync(join(tmpdir(), "dim-hooks-write-"));
  try {
    expect(installHooks(root)).toMatchObject({ added: 8, alreadyPresent: 0 });
    expect(installHooks(root)).toMatchObject({ written: [], added: 0, alreadyPresent: 8 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hooks install reports a refreshed matcher", () => {
  const root = mkdtempSync(join(tmpdir(), "dim-hooks-refresh-"));
  try {
    installHooks(root);
    const settings = join(root, ".claude", "settings.json");
    const config = JSON.parse(readFileSync(settings, "utf8"));
    config.hooks.PostToolUse.find((entry: { matcher?: string }) => entry.matcher).matcher = "Stale";
    writeFileSync(settings, JSON.stringify(config));
    expect(installHooks(root)).toMatchObject({ added: 0, refreshed: 1, alreadyPresent: 7 });
    expect(installHooks(root)).toMatchObject({ written: [], refreshed: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
