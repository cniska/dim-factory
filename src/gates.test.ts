import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isRefusal } from "./coded-error";
import { GATES, installGates, planGates } from "./gates";

const CANONICAL = resolve(import.meta.dir, "..", "gates");
const CHECK = { Makefile: "check:\n\ttrue\n" };
const repos: string[] = [];

function repo(files: Record<string, string> = CHECK): string {
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

function every(state: string): Record<string, string> {
  return { "commit-msg": state, commits: state, "pre-commit": state };
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

function commit(dir: string, subject: string): number | null {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  return spawnSync(
    "git",
    ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", subject],
    { stdio: "pipe" },
  ).status;
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
      "pre-commit": {
        version: 1,
        sha256: "85b1d93ca7399adeaf0dfe92341978363c635f394471f2d3180e9150c72b2cb1",
      },
    });
  });

  test("installs at the paths the gates run from", () => {
    expect(GATES.map((gate) => gate.target)).toEqual([
      ".githooks/commit-msg",
      ".github/workflows/commits.yml",
      ".githooks/pre-commit",
    ]);
  });

  test("dim-factory runs the canonical gates on itself", () => {
    expect(states(resolve(import.meta.dir, ".."))).toEqual(every("installed"));
  });
});

describe("gate install", () => {
  test("installs every missing gate and wires the hooks", () => {
    const dir = repo();
    expect(states(dir)).toEqual(every("missing"));
    installGates(dir);
    expect(states(dir)).toEqual(every("installed"));
    expect(readFileSync(join(dir, ".githooks/commit-msg"), "utf8")).toBe(canonical("commit-msg"));
    expect(statSync(join(dir, ".githooks/commit-msg")).mode & 0o777).toBe(0o755);
    expect(hooksPath(dir)).toBe(".githooks");
  });

  test("the pre-commit gate runs the check the project declares", () => {
    const dir = repo();
    installGates(dir);
    expect(readFileSync(join(dir, ".githooks/pre-commit"), "utf8")).toEndWith("\nexec make check\n");
  });

  test("a commit is refused while the project's check fails", () => {
    const dir = repo({ Makefile: "check:\n\tfalse\n" });
    installGates(dir);
    expect(commit(dir, "feat: add the gates")).not.toBe(0);
    writeFileSync(join(dir, "Makefile"), "check:\n\ttrue\n");
    expect(commit(dir, "feat: add the gates")).toBe(0);
  });

  test("refuses a project that declares no check, writing nothing", () => {
    const dir = repo({});
    expect(refusalOf(() => installGates(dir))).toBe("no_check");
    expect(existsSync(join(dir, ".githooks"))).toBe(false);
    expect(hooksPath(dir)).toBe("");
  });

  test("installing again changes nothing", () => {
    const dir = repo();
    installGates(dir);
    const result = installGates(dir);
    expect(result.written).toEqual([]);
    expect(result.backups).toEqual([]);
  });

  test("replaces a gate behind the canonical one, keeping no copy", () => {
    const dir = repo({ ...CHECK, ".githooks/commit-msg": "#!/bin/sh\n# dim-gate:0\nexit 0\n" });
    expect(states(dir)["commit-msg"]).toBe("behind");
    const result = installGates(dir);
    expect(result.written).toEqual([
      ".githooks/commit-msg",
      ".github/workflows/commits.yml",
      ".githooks/pre-commit",
    ]);
    expect(result.backups).toEqual([]);
    expect(readFileSync(join(dir, ".githooks/commit-msg"), "utf8")).toBe(canonical("commit-msg"));
  });

  test("moves a gate changed in place aside before replacing it", () => {
    const edited = canonical("commit-msg").replace("-le 50", "-le 72");
    const dir = repo({ ...CHECK, ".githooks/commit-msg": edited });
    expect(states(dir)["commit-msg"]).toBe("changed");
    const result = installGates(dir);
    expect(result.backups).toEqual([".githooks/commit-msg.dim-backup"]);
    expect(readFileSync(join(dir, ".githooks/commit-msg.dim-backup"), "utf8")).toBe(edited);
    expect(readFileSync(join(dir, ".githooks/commit-msg"), "utf8")).toBe(canonical("commit-msg"));
  });

  test("treats a project's own file at a gate's path as changed", () => {
    const dir = repo({ ...CHECK, ".githooks/commit-msg": "#!/bin/sh\nexit 0\n" });
    expect(states(dir)["commit-msg"]).toBe("changed");
  });

  test("treats a pre-commit gate that runs another check as changed", () => {
    const dir = repo();
    installGates(dir);
    writeFileSync(join(dir, "Makefile"), "verify:\n\ttrue\n");
    expect(states(dir)["pre-commit"]).toBe("changed");
  });

  test("leaves a gate ahead of this dim as it is", () => {
    const ahead = "#!/bin/sh\n# dim-gate:99\nexit 0\n";
    const dir = repo({ ...CHECK, ".githooks/commit-msg": ahead });
    expect(states(dir)["commit-msg"]).toBe("ahead");
    installGates(dir);
    expect(readFileSync(join(dir, ".githooks/commit-msg"), "utf8")).toBe(ahead);
  });

  test("leaves a file the project added beside a gate as it is", () => {
    const dir = repo({ ...CHECK, ".githooks/pre-push": "#!/bin/sh\nexit 0\n" });
    installGates(dir);
    expect(readFileSync(join(dir, ".githooks/pre-push"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
  });

  test("adds the hook wiring to a package.json so a fresh clone runs the gates", () => {
    const dir = repo({
      ...CHECK,
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
    const dir = repo({ ...CHECK, "package.json": '{ "scripts": { "prepare": "husky" } }\n' });
    expect(refusalOf(() => installGates(dir))).toBe("prepare_occupied");
    expect(states(dir)).toEqual(every("missing"));
  });

  test("refuses a checkout whose hooks run from another directory, writing nothing", () => {
    const dir = repo();
    execFileSync("git", ["-C", dir, "config", "core.hooksPath", ".husky"]);
    expect(refusalOf(() => installGates(dir))).toBe("hooks_path_occupied");
    expect(states(dir)).toEqual(every("missing"));
    expect(hooksPath(dir)).toBe(".husky");
  });
});
