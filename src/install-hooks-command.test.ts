import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { harnessesOnPath, scratchEnv } from "./fixtures.test-support";

function installHooks(root: string, ...args: string[]) {
  const run = Bun.spawnSync(
    [process.execPath, resolve(import.meta.dir, "cli.ts"), "install-hooks", ...args],
    {
      env: { ...process.env, ...scratchEnv(root), HOME: root },
    },
  );
  expect(run.exitCode).toBe(0);
  return JSON.parse(run.stdout.toString()).result;
}

test("install-hooks --write reports the hooks it wrote as installed", () => {
  const root = mkdtempSync(join(tmpdir(), "dim-hooks-write-"));
  try {
    const written = installHooks(root, "--write");
    const after = installHooks(root);
    expect(after.pending).toEqual([]);
    expect({ installed: written.installed, pending: written.pending }).toEqual(after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-hooks --write reports a refreshed matcher as installed", () => {
  const root = mkdtempSync(join(tmpdir(), "dim-hooks-refresh-"));
  try {
    installHooks(root, "--write");
    const settings = join(root, "settings.json");
    const config = JSON.parse(readFileSync(settings, "utf8"));
    config.hooks.PostToolUse.find((entry: { matcher?: string }) => entry.matcher).matcher = "Stale";
    writeFileSync(settings, JSON.stringify(config));
    const written = installHooks(root, "--write");
    const after = installHooks(root);
    expect(written.refreshed).toBe(1);
    expect(written.pending).toEqual([]);
    expect(written.installed).toBe(after.installed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-hooks preview leaves the data directory untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "dim-hooks-preview-"));
  const data = join(root, "data");
  try {
    const run = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "cli.ts"), "install-hooks"], {
      env: {
        ...process.env,
        HOME: root,
        DIM_HOME: data,
        PATH: `${harnessesOnPath(root, ["claude", "codex"])}:${process.env.PATH}`,
      },
    });
    expect(run.exitCode).toBe(0);
    expect(existsSync(data)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
