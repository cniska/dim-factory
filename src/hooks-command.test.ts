import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(installHooks(root)).toMatchObject({ added: 4, alreadyPresent: 0 });
    expect(installHooks(root)).toMatchObject({ written: [], added: 0, alreadyPresent: 4 });
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
    expect(installHooks(root)).toMatchObject({ added: 0, refreshed: 1, alreadyPresent: 3 });
    expect(installHooks(root)).toMatchObject({ written: [], refreshed: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hooks install refuses a settings file whose hooks hold the wrong shape", () => {
  const root = mkdtempSync(join(tmpdir(), "dim-hooks-invalid-"));
  try {
    mkdirSync(join(root, ".claude"), { recursive: true });
    const settings = join(root, ".claude", "settings.json");
    writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: "nope" } }));
    const run = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "cli.ts"), "hooks", "install"], {
      env: { ...process.env, ...scratchEnv(root), HOME: root },
    });
    expect(run.exitCode).not.toBe(0);
    expect(JSON.parse(run.stderr.toString()).error).toMatchObject({
      code: "config_invalid",
      meta: { path: settings, at: "hooks.SessionStart" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runHook(verb: string, payload: unknown, root: string) {
  return Bun.spawnSync([process.execPath, resolve(import.meta.dir, "cli.ts"), "hooks", verb], {
    env: { ...process.env, ...scratchEnv(root), HOME: root },
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
  });
}

test("hooks start gives the session its checkout's declared tasks", () => {
  const root = mkdtempSync(join(tmpdir(), "dim-hooks-start-"));
  try {
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { verify: "bun test" } }));
    writeFileSync(join(root, "bun.lock"), "");
    const run = runHook("start", { cwd: root }, root);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout.toString())).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "This repo declares: check `bun run verify`.",
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hooks start and edit refuse a payload with no session directory", () => {
  const root = mkdtempSync(join(tmpdir(), "dim-hooks-payload-"));
  try {
    for (const [verb, payload] of [
      ["start", { session_id: "s" }],
      ["edit", { tool_name: "Write", tool_input: { file_path: "/a.ts" } }],
    ] as const) {
      const run = runHook(verb, payload, root);
      expect({ verb, exitCode: run.exitCode, stderr: run.stderr.toString() }).toMatchObject({
        verb,
        exitCode: 1,
        stderr: expect.stringContaining('"code":"hook_payload_invalid"'),
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
