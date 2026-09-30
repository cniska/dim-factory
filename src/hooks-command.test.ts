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

test("hooks install reports the hooks it wrote as installed", () => {
  const root = mkdtempSync(join(tmpdir(), "dim-hooks-write-"));
  try {
    const written = installHooks(root);
    expect(written.pending).toEqual([]);
    expect(installHooks(root).installed).toBe(written.installed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hooks install reports a refreshed matcher as installed", () => {
  const root = mkdtempSync(join(tmpdir(), "dim-hooks-refresh-"));
  try {
    installHooks(root);
    const settings = join(root, "settings.json");
    const config = JSON.parse(readFileSync(settings, "utf8"));
    config.hooks.PostToolUse.find((entry: { matcher?: string }) => entry.matcher).matcher = "Stale";
    writeFileSync(settings, JSON.stringify(config));
    const written = installHooks(root);
    expect(written.refreshed).toBe(1);
    expect(written.pending).toEqual([]);
    expect(written.installed).toBe(installHooks(root).installed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
