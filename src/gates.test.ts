import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isRefusal } from "./coded-error";
import { readGateChoice } from "./config";
import { GATES, installGates, planGates } from "./gates";
import { GATE_NAMES, type GateName } from "./gates-contract";

const CANONICAL = resolve(import.meta.dir, "..", "gates");
const CHECK = { Makefile: "check:\n\ttrue\n" };
const EVERY: readonly GateName[] = ["commit-subject", "check"];
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

function states(dir: string, chosen: readonly GateName[] = EVERY): Record<string, string> {
  return Object.fromEntries(planGates(dir, chosen).map((plan) => [plan.target, plan.state]));
}

function every(state: string): Record<string, string> {
  return {
    ".githooks/commit-msg": state,
    ".github/workflows/commits.yml": state,
    ".githooks/pre-commit": state,
  };
}

function canonical(source: string): string {
  return readFileSync(join(CANONICAL, source), "utf8");
}

function read(dir: string, path: string): string {
  return readFileSync(join(dir, path), "utf8");
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
  test("a gate file's bytes change only with its version", () => {
    const pinned = Object.fromEntries(
      Object.values(GATES)
        .flat()
        .map((file) => [
          file.source,
          {
            version: Number(canonical(file.source).match(/dim-gate:(\d+)/)?.[1]),
            sha256: createHash("sha256").update(canonical(file.source)).digest("hex"),
          },
        ]),
    );
    expect(pinned).toEqual({
      "commit-msg": {
        version: 1,
        sha256: "b6592c9af038117c77548f84925b96ad78a2053a5fd92dd63e50786cd752d128",
      },
      "commits.yml": {
        version: 1,
        sha256: "7e83f8486cfc7bbd1adb6782b3b4fd759d833f5919b12eae4bcb0b4470755a47",
      },
      "pre-commit": {
        version: 1,
        sha256: "85b1d93ca7399adeaf0dfe92341978363c635f394471f2d3180e9150c72b2cb1",
      },
    });
  });

  test("names each gate for its rule, installing the files it runs from", () => {
    expect(GATE_NAMES).toEqual(["commit-subject", "check"]);
    expect(
      Object.fromEntries(GATE_NAMES.map((gate) => [gate, GATES[gate].map((file) => file.target)])),
    ).toEqual({
      "commit-subject": [".githooks/commit-msg", ".github/workflows/commits.yml"],
      check: [".githooks/pre-commit"],
    });
  });

  test("dim-factory chose every canonical gate and runs each", () => {
    const root = resolve(import.meta.dir, "..");
    expect(readGateChoice(root)).toEqual(EVERY);
    expect(states(root)).toEqual(every("installed"));
  });
});

describe("gate install", () => {
  test("installs every chosen gate, records the choice and wires the hooks", () => {
    const dir = repo();
    expect(states(dir)).toEqual(every("missing"));
    expect(installGates(dir, EVERY).gates).toEqual(EVERY);
    expect(states(dir)).toEqual(every("installed"));
    expect(readGateChoice(dir)).toEqual(EVERY);
    expect(read(dir, ".githooks/commit-msg")).toBe(canonical("commit-msg"));
    expect(statSync(join(dir, ".githooks/commit-msg")).mode & 0o777).toBe(0o755);
    expect(hooksPath(dir)).toBe(".githooks");
  });

  test("installs only the chosen gates", () => {
    const dir = repo();
    installGates(dir, ["commit-subject"]);
    expect(existsSync(join(dir, ".githooks/commit-msg"))).toBe(true);
    expect(existsSync(join(dir, ".githooks/pre-commit"))).toBe(false);
  });

  test("installs the recorded choice when none is named", () => {
    const dir = repo();
    installGates(dir, ["check"]);
    rmSync(join(dir, ".githooks/pre-commit"));
    expect(installGates(dir, null)).toMatchObject({ gates: ["check"], written: [".githooks/pre-commit"] });
  });

  test("refuses to install with no choice named or recorded, writing nothing", () => {
    const dir = repo();
    expect(refusalOf(() => installGates(dir, null))).toBe("no_gates_chosen");
    expect(existsSync(join(dir, ".githooks"))).toBe(false);
    expect(existsSync(join(dir, ".dim"))).toBe(false);
  });

  test("removes a gate no longer chosen, leaving the rest", () => {
    const dir = repo();
    installGates(dir, EVERY);
    expect(installGates(dir, ["commit-subject"]).removed).toEqual([".githooks/pre-commit"]);
    expect(existsSync(join(dir, ".githooks/pre-commit"))).toBe(false);
    expect(states(dir, ["commit-subject"])).toEqual({
      ".githooks/commit-msg": "installed",
      ".github/workflows/commits.yml": "installed",
    });
  });

  test("reports an installed gate that is not chosen", () => {
    const dir = repo();
    installGates(dir, EVERY);
    expect(states(dir, ["commit-subject"])[".githooks/pre-commit"]).toBe("unchosen");
  });

  test("the check gate runs the check the project declares", () => {
    const dir = repo();
    installGates(dir, ["check"]);
    expect(read(dir, ".githooks/pre-commit")).toEndWith("\nexec make check\n");
  });

  test("a commit is refused while the project's check fails", () => {
    const dir = repo({ Makefile: "check:\n\tfalse\n" });
    installGates(dir, EVERY);
    expect(commit(dir, "feat: add the gates")).not.toBe(0);
    writeFileSync(join(dir, "Makefile"), "check:\n\ttrue\n");
    expect(commit(dir, "feat: add the gates")).toBe(0);
  });

  test("refuses the check gate in a project that declares no check, writing nothing", () => {
    const dir = repo({});
    expect(refusalOf(() => installGates(dir, EVERY))).toBe("no_check");
    expect(existsSync(join(dir, ".githooks"))).toBe(false);
    expect(existsSync(join(dir, ".dim"))).toBe(false);
    expect(hooksPath(dir)).toBe("");
  });

  test("installs the commit-subject gate in a project that declares no check", () => {
    const dir = repo({});
    installGates(dir, ["commit-subject"]);
    expect(states(dir, ["commit-subject"])[".githooks/commit-msg"]).toBe("installed");
  });

  test("installing again changes nothing", () => {
    const dir = repo();
    installGates(dir, EVERY);
    expect(installGates(dir, null)).toEqual({ gates: EVERY, written: [], removed: [], backups: [] });
  });

  test("replaces a gate behind the canonical one, keeping no copy", () => {
    const dir = repo({ ...CHECK, ".githooks/commit-msg": "#!/bin/sh\n# dim-gate:0\nexit 0\n" });
    expect(states(dir)[".githooks/commit-msg"]).toBe("behind");
    const result = installGates(dir, ["commit-subject"]);
    expect(result.written).toEqual([".githooks/commit-msg", ".github/workflows/commits.yml"]);
    expect(result.backups).toEqual([]);
    expect(read(dir, ".githooks/commit-msg")).toBe(canonical("commit-msg"));
  });

  test("moves a gate changed in place aside before replacing it", () => {
    const edited = canonical("commit-msg").replace("-le 50", "-le 72");
    const dir = repo({ ...CHECK, ".githooks/commit-msg": edited });
    expect(states(dir)[".githooks/commit-msg"]).toBe("changed");
    const result = installGates(dir, EVERY);
    expect(result.backups).toEqual([".githooks/commit-msg.dim-backup"]);
    expect(read(dir, ".githooks/commit-msg.dim-backup")).toBe(edited);
    expect(read(dir, ".githooks/commit-msg")).toBe(canonical("commit-msg"));
  });

  test("treats a project's own file at a gate's path as changed when chosen, and leaves it when not", () => {
    const own = "#!/bin/sh\nexit 0\n";
    const dir = repo({ ...CHECK, ".githooks/pre-commit": own });
    expect(states(dir)[".githooks/pre-commit"]).toBe("changed");
    installGates(dir, ["commit-subject"]);
    expect(read(dir, ".githooks/pre-commit")).toBe(own);
  });

  test("treats a check gate that runs another check as changed", () => {
    const dir = repo();
    installGates(dir, EVERY);
    writeFileSync(join(dir, "Makefile"), "verify:\n\ttrue\n");
    expect(states(dir)[".githooks/pre-commit"]).toBe("changed");
  });

  test("leaves a gate ahead of this dim as it is", () => {
    const ahead = "#!/bin/sh\n# dim-gate:99\nexit 0\n";
    const dir = repo({ ...CHECK, ".githooks/commit-msg": ahead });
    expect(states(dir)[".githooks/commit-msg"]).toBe("ahead");
    installGates(dir, EVERY);
    expect(read(dir, ".githooks/commit-msg")).toBe(ahead);
  });

  test("leaves a file the project added beside a gate as it is", () => {
    const dir = repo({ ...CHECK, ".githooks/pre-push": "#!/bin/sh\nexit 0\n" });
    installGates(dir, EVERY);
    expect(read(dir, ".githooks/pre-push")).toBe("#!/bin/sh\nexit 0\n");
  });

  test("adds the hook wiring to a package.json so a fresh clone runs the gates", () => {
    const dir = repo({
      ...CHECK,
      "package.json": '{\n  "name": "p",\n  "scripts": {\n    "test": "bun test"\n  }\n}\n',
    });
    installGates(dir, EVERY);
    expect(JSON.parse(read(dir, "package.json")).scripts).toEqual({
      test: "bun test",
      prepare: "git config core.hooksPath .githooks",
    });
  });

  test("adds no package.json to a project without one", () => {
    const dir = repo();
    installGates(dir, EVERY);
    expect(existsSync(join(dir, "package.json"))).toBe(false);
  });

  test("refuses a package.json whose prepare script does something else, writing nothing", () => {
    const dir = repo({ ...CHECK, "package.json": '{ "scripts": { "prepare": "husky" } }\n' });
    expect(refusalOf(() => installGates(dir, EVERY))).toBe("prepare_occupied");
    expect(states(dir)).toEqual(every("missing"));
    expect(existsSync(join(dir, ".dim"))).toBe(false);
  });

  test("refuses a checkout whose hooks run from another directory, writing nothing", () => {
    const dir = repo();
    execFileSync("git", ["-C", dir, "config", "core.hooksPath", ".husky"]);
    expect(refusalOf(() => installGates(dir, EVERY))).toBe("hooks_path_occupied");
    expect(states(dir)).toEqual(every("missing"));
    expect(hooksPath(dir)).toBe(".husky");
  });
});
