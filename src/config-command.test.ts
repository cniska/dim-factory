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
      env: { PATH: process.env.PATH, HOME: join(dir, ".home") },
    });
  return { dir, run };
}

describe("dim config", () => {
  test("sets a project setting, which resolves once HEAD commits it", () => {
    const { dir, run } = config(["set", "ship", "default-branch", "--project"]);
    const out = run([]);
    expect(out.status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, ".dim", "config.json"), "utf8"))).toEqual({
      ship: "default-branch",
    });
    expect(JSON.parse(String(out.stdout)).result).toMatchObject({
      user: { config: {} },
      project: { config: { ship: "default-branch" }, committed: {} },
      resolved: {},
      settings: { ship: ["user", "project"], "tasks.check": ["project"], "models.default": ["user"] },
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
      "chore: ship",
    ]);
    const listed = spawnSync(process.execPath, [join(import.meta.dir, "cli.ts"), "config"], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: join(dir, ".home") },
    });
    expect(JSON.parse(listed.stdout).result).toMatchObject({ resolved: { ship: "default-branch" } });
  });

  test("leaves no file beside the one it edits", () => {
    const { dir, run } = config(["set", "ship", "default-branch", "--project"]);
    run([]);
    run([]);
    expect(readdirSync(join(dir, ".dim"))).toEqual(["config.json"]);
  });

  test("unsets a setting, and writes nothing where there is no file", () => {
    const { dir, run } = config(["unset", "ship", "--project"]);
    expect(run([]).status).toBe(0);
    expect(existsSync(join(dir, ".dim"))).toBe(false);
  });

  test("refuses an argument beyond the value", () => {
    expect(config(["set", "ship", "default-branch", "extra"]).run([]).status).not.toBe(0);
  });

  test("sets the user layer without --project", () => {
    const { dir, run } = config(["set", "ship", "default-branch"]);
    expect(run([]).status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, ".home", ".config", "dim", "config.json"), "utf8"))).toEqual({
      ship: "default-branch",
    });
  });

  test("sets a dotted key in its section", () => {
    const { dir, run } = config(["set", "tasks.check", "verify", "--project"]);
    expect(run([]).status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, ".dim", "config.json"), "utf8"))).toEqual({
      tasks: { check: "verify" },
    });
  });

  test("refuses a key no setting has", () => {
    const out = config(["set", "shipp", "default-branch"]).run([]);
    expect(out.status).not.toBe(0);
    expect(String(out.stderr)).toContain("the settings are ship");
  });
});
