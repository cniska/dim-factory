import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(args: string[]): { dir: string; run: (more: string[]) => ReturnType<typeof spawnSync> } {
  const dir = mkdtempSync(join(tmpdir(), "dim-config-command-"));
  roots.push(dir);
  execFileSync("git", ["init", "-q", dir]);
  const run = (more: string[]) =>
    spawnSync(process.execPath, [join(import.meta.dir, "cli.ts"), "config", ...args, ...more], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, HOME: join(dir, ".home") },
    });
  return { dir, run };
}

describe("dim config", () => {
  test("sets a project setting, which resolves once HEAD commits it", () => {
    const { dir, run } = config(["set", "comments", "banned", "--project"]);
    const out = run([]);
    expect(out.status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, ".dim", "config.json"), "utf8"))).toEqual({
      comments: "banned",
    });
    expect(JSON.parse(String(out.stdout))).toMatchObject({
      user: { config: {} },
      project: { config: { comments: "banned" }, committed: {} },
      resolved: {},
      settings: { comments: ["banned", "allowed"] },
    });
    execFileSync("git", ["-C", dir, "add", ".dim/config.json"]);
    execFileSync("git", [
      "-C",
      dir,
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "--no-verify",
      "-m",
      "chore: ban",
    ]);
    const listed = spawnSync(process.execPath, [join(import.meta.dir, "cli.ts"), "config"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, HOME: join(dir, ".home") },
    });
    expect(JSON.parse(listed.stdout)).toMatchObject({ resolved: { comments: "banned" } });
  });

  test("leaves no file beside the one it edits", () => {
    const { dir, run } = config(["set", "comments", "allowed", "--project"]);
    run([]);
    run([]);
    expect(readdirSync(join(dir, ".dim"))).toEqual(["config.json"]);
  });

  test("unsets a setting, and writes nothing where there is no file", () => {
    const { dir, run } = config(["unset", "comments", "--project"]);
    expect(run([]).status).toBe(0);
    expect(existsSync(join(dir, ".dim"))).toBe(false);
  });

  test("refuses an argument beyond the value", () => {
    expect(config(["set", "comments", "banned", "extra"]).run([]).status).not.toBe(0);
  });

  test("sets the user layer without --project", () => {
    const { dir, run } = config(["set", "comments", "banned"]);
    expect(run([]).status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, ".home", ".config", "dim", "config.json"), "utf8"))).toEqual({
      comments: "banned",
    });
  });

  test("refuses a key no setting has", () => {
    const out = config(["set", "commentz", "banned"]).run([]);
    expect(out.status).not.toBe(0);
    expect(String(out.stderr)).toContain("the settings are comments");
  });
});
