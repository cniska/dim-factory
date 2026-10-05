import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_LABEL, agentPlist, agentPlistPath, bunPath, installAgent, planAgent } from "./ingest-launchd";
import type { Env } from "./paths";

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dim-agent-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function env(dir: string): Env {
  return { HOME: dir, XDG_STATE_HOME: join(dir, "state") };
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
    expect(plist).toContain(`<string>${join(dir, "state", "dim-factory", "sync.log")}</string>`);
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

  test("keeps the previous plists when overwriting one", async () => {
    const dir = newRoot();
    const e = env(dir);
    mkdirSync(join(dir, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(agentPlistPath(e), "<plist>old</plist>");
    installAgent(e);
    await expect(Bun.file(`${agentPlistPath(e)}.dim-backup`).text()).resolves.toBe("<plist>old</plist>");
    writeFileSync(agentPlistPath(e), "<plist>changed</plist>");
    installAgent(e);
    await expect(Bun.file(`${agentPlistPath(e)}.dim-backup`).text()).resolves.toBe("<plist>old</plist>");
    await expect(Bun.file(`${agentPlistPath(e)}.dim-backup-2`).text()).resolves.toBe(
      "<plist>changed</plist>",
    );
  });
});
