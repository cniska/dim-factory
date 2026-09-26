import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_LABEL, agentPlist, agentPlistPath, bunPath, installAgent, planAgent } from "./agent";
import { LockHeldError, withLock } from "./lock";
import type { Env } from "./paths";

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dim-agent-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function env(dir: string): Env {
  return { HOME: dir, DIM_HOME: join(dir, "data") };
}

describe("launchd agent", () => {
  test("runs bun by absolute path, because launchd has no PATH to look it up on", () => {
    const plist = agentPlist("/opt/homebrew/bin/bun", "/Users/x/code/dim-factory", env(newRoot()));
    expect(plist).toContain("<string>/opt/homebrew/bin/bun</string>");
    expect(plist).toContain("<string>/Users/x/code/dim-factory/src/cli.ts</string>");
    expect(plist).toContain("<string>sync</string>");
  });

  test("syncs on a fifteen minute interval and at load", () => {
    const plist = agentPlist("/bin/bun", "/repo", env(newRoot()));
    expect(plist).toContain("<key>StartInterval</key>\n  <integer>900</integer>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
  });

  test("captures output, since nobody is watching an unattended run", () => {
    const dir = newRoot();
    const plist = agentPlist("/bin/bun", "/repo", env(dir));
    expect(plist).toContain(`<string>${join(dir, "data", "sync.log")}</string>`);
  });

  test("picks a bun path that survives an upgrade", () => {
    expect(bunPath()).not.toContain("/Cellar/");
  });

  test("writes the plist where launchd looks, and reports when it already matches", () => {
    const dir = newRoot();
    const e = env(dir);
    expect(agentPlistPath(e)).toBe(join(dir, "Library", "LaunchAgents", `${AGENT_LABEL}.plist`));
    installAgent(e);
    expect(planAgent(e).unchanged).toBe(true);
  });

  test("keeps the previous plist when overwriting one", () => {
    const dir = newRoot();
    const e = env(dir);
    mkdirSync(join(dir, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(agentPlistPath(e), "<plist>old</plist>");
    installAgent(e);
    expect(Bun.file(`${agentPlistPath(e)}.dim-backup`).text()).resolves.toBe("<plist>old</plist>");
  });
});

describe("lock", () => {
  test("refuses to run while another run holds it", () => {
    const e = env(newRoot());
    withLock(() => {
      expect(() => withLock(() => 0, e)).toThrow(LockHeldError);
    }, e);
  });

  test("takes over a lock left behind by a killed run", () => {
    const dir = newRoot();
    const e = env(dir);
    const lock = join(dir, "data", "lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), "2147483646");
    expect(withLock(() => "ran", e)).toBe("ran");
  });

  test("takes over a lock directory with no pid file at all", () => {
    const dir = newRoot();
    const e = env(dir);
    mkdirSync(join(dir, "data", "lock"), { recursive: true });
    expect(withLock(() => "ran", e)).toBe("ran");
  });

  test("releases the lock when the work throws", () => {
    const e = env(newRoot());
    expect(() =>
      withLock(() => {
        throw new Error("boom");
      }, e),
    ).toThrow("boom");
    expect(withLock(() => "ran", e)).toBe("ran");
  });
});
