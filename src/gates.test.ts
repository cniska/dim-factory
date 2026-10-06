import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isRefusal } from "./coded-error";
import { GATES, installGates, planGates } from "./gates";

const CANONICAL = resolve(import.meta.dir, "..", "gates");
const repos: string[] = [];

function repo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "dim-gates-"));
  repos.push(dir);
  execFileSync("git", ["init", "-q", dir]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function hooksPath(dir: string): string {
  try {
    return execFileSync("git", ["-C", dir, "config", "--get", "core.hooksPath"]).toString().trim();
  } catch {
    return "";
  }
}

function states(dir: string): Record<string, string> {
  return Object.fromEntries(planGates(dir).map((gate) => [gate.name, gate.state]));
}

function canonical(source: string): string {
  return readFileSync(join(CANONICAL, source), "utf8");
}

function refusalOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (!isRefusal(error)) throw error;
    return error.code;
  }
}

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("canonical gates", () => {
  test("a gate's bytes change only with its version", () => {
    const pinned = Object.fromEntries(
      GATES.map((gate) => [
        gate.name,
        {
          version: Number(canonical(gate.source).match(/dim-gate:(\d+)/)?.[1]),
          sha256: createHash("sha256").update(canonical(gate.source)).digest("hex"),
        },
      ]),
    );
    expect(pinned).toEqual({
      "commit-msg": {
        version: 1,
        sha256: "b6592c9af038117c77548f84925b96ad78a2053a5fd92dd63e50786cd752d128",
      },
      commits: { version: 1, sha256: "7e83f8486cfc7bbd1adb6782b3b4fd759d833f5919b12eae4bcb0b4470755a47" },
    });
  });

  test("installs at the paths the gates run from", () => {
    expect(GATES.map((gate) => gate.target)).toEqual([
      ".githooks/commit-msg",
      ".github/workflows/commits.yml",
    ]);
  });

  test("dim-factory runs the canonical gates on itself", () => {
    expect(states(resolve(import.meta.dir, ".."))).toEqual({
      "commit-msg": "installed",
      commits: "installed",
    });
  });
});

describe("gate install", () => {
  test("installs every missing gate and wires the hooks", () => {
    const dir = repo();
    expect(states(dir)).toEqual({ "commit-msg": "missing", commits: "missing" });
    installGates(dir);
    expect(states(dir)).toEqual({ "commit-msg": "installed", commits: "installed" });
    expect(readFileSync(join(dir, ".githooks/commit-msg"), "utf8")).toBe(canonical("commit-msg"));
    expect(statSync(join(dir, ".githooks/commit-msg")).mode & 0o777).toBe(0o755);
    expect(hooksPath(dir)).toBe(".githooks");
  });

  test("installing again changes nothing", () => {
    const dir = repo();
    installGates(dir);
    const result = installGates(dir);
    expect(result.written).toEqual([]);
    expect(result.backups).toEqual([]);
  });

  test("replaces a gate behind the canonical one, keeping no copy", () => {
    const dir = repo({ ".githooks/commit-msg": "#!/bin/sh\n# dim-gate:0\nexit 0\n" });
    expect(states(dir)["commit-msg"]).toBe("behind");
    const result = installGates(dir);
    expect(result.written).toEqual([".githooks/commit-msg", ".github/workflows/commits.yml"]);
    expect(result.backups).toEqual([]);
    expect(readFileSync(join(dir, ".githooks/commit-msg"), "utf8")).toBe(canonical("commit-msg"));
  });

  test("moves a gate changed in place aside before replacing it", () => {
    const edited = canonical("commit-msg").replace("-le 50", "-le 72");
    const dir = repo({ ".githooks/commit-msg": edited });
    expect(states(dir)["commit-msg"]).toBe("changed");
    const result = installGates(dir);
    expect(result.backups).toEqual([".githooks/commit-msg.dim-backup"]);
    expect(readFileSync(join(dir, ".githooks/commit-msg.dim-backup"), "utf8")).toBe(edited);
    expect(readFileSync(join(dir, ".githooks/commit-msg"), "utf8")).toBe(canonical("commit-msg"));
  });

  test("treats a project's own file at a gate's path as changed", () => {
    const dir = repo({ ".githooks/commit-msg": "#!/bin/sh\nexit 0\n" });
    expect(states(dir)["commit-msg"]).toBe("changed");
  });

  test("leaves a gate ahead of this dim as it is", () => {
    const ahead = "#!/bin/sh\n# dim-gate:99\nexit 0\n";
    const dir = repo({ ".githooks/commit-msg": ahead });
    expect(states(dir)["commit-msg"]).toBe("ahead");
    installGates(dir);
    expect(readFileSync(join(dir, ".githooks/commit-msg"), "utf8")).toBe(ahead);
  });

  test("leaves a file the project added beside a gate as it is", () => {
    const dir = repo({ ".githooks/pre-push": "#!/bin/sh\nexit 0\n" });
    installGates(dir);
    expect(readFileSync(join(dir, ".githooks/pre-push"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
  });

  test("adds the hook wiring to a package.json so a fresh clone runs the gates", () => {
    const dir = repo({
      "package.json": '{\n  "name": "p",\n  "scripts": {\n    "test": "bun test"\n  }\n}\n',
    });
    installGates(dir);
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts).toEqual({
      test: "bun test",
      prepare: "git config core.hooksPath .githooks",
    });
  });

  test("adds no package.json to a project without one", () => {
    const dir = repo();
    installGates(dir);
    expect(existsSync(join(dir, "package.json"))).toBe(false);
  });

  test("refuses a package.json whose prepare script does something else, writing nothing", () => {
    const dir = repo({ "package.json": '{ "scripts": { "prepare": "husky" } }\n' });
    expect(refusalOf(() => installGates(dir))).toBe("prepare_occupied");
    expect(states(dir)).toEqual({ "commit-msg": "missing", commits: "missing" });
  });

  test("refuses a checkout whose hooks run from another directory, writing nothing", () => {
    const dir = repo();
    execFileSync("git", ["-C", dir, "config", "core.hooksPath", ".husky"]);
    expect(refusalOf(() => installGates(dir))).toBe("hooks_path_occupied");
    expect(states(dir)).toEqual({ "commit-msg": "missing", commits: "missing" });
    expect(hooksPath(dir)).toBe(".husky");
  });
});
