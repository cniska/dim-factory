import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isRefusal } from "./coded-error";
import { readGateChoice } from "./config";
import { bundleGates, GATE_BUNDLES_DIR } from "./gate-bundles";
import { GATES, installGates, planGates } from "./gates";
import { GATE_NAMES, type GateName } from "./gates-contract";

const CANONICAL = resolve(import.meta.dir, "..", "gates");
const PROJECT = { Makefile: "check:\n\ttrue\n", "package.json": "{}\n", "src/a.ts": "export const a = 1;\n" };
const EVERY: readonly GateName[] = ["commit-subject", "check", "no-comments"];
const repos: string[] = [];

function repo(files: Record<string, string> = PROJECT): string {
  const dir = mkdtempSync(join(tmpdir(), "dim-gates-"));
  repos.push(dir);
  execFileSync("git", ["init", "-q", dir]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  execFileSync("git", ["-C", dir, "add", "-A"]);
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
  return Object.fromEntries(
    [
      ".githooks/commit-msg",
      ".github/workflows/commits.yml",
      ".githooks/pre-commit",
      ".githooks/pre-commit.d/check",
      ".github/workflows/check.yml",
      ".githooks/pre-commit.d/no-comments",
      ".githooks/no-comments/scan.cjs",
      ".githooks/no-comments/javascript.cjs",
      ".github/workflows/no-comments.yml",
    ].map((target) => [target, state]),
  );
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

function commit(dir: string, subject: string): { status: number | null; stderr: string } {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  const run = spawnSync(
    "git",
    ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", subject],
    { encoding: "utf8" },
  );
  return { status: run.status, stderr: run.stderr };
}

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("canonical gates", () => {
  test("a gate file's bytes change only with its version", () => {
    const pinned = Object.fromEntries(
      [...new Set(Object.values(GATES).flat())].map((file) => [
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
        version: 2,
        sha256: "723dfbd4bcc5e6378326f2726cd1e1a0864ecefbd47041f032c5f13774880f61",
      },
      "check-hook": {
        version: 1,
        sha256: "2d3ca1deb17c3b1acdb9b78437cb2c57023faeab12e15164add4d264a8e8015d",
      },
      "no-comments-hook": {
        version: 1,
        sha256: "0b60b0b3b902a635beecb80294ff4c0c603c9a0a2306e780c6859462238b5039",
      },
      "no-comments/scan.cjs": {
        version: 2,
        sha256: "5913ef9ce1cb519c8d4a700ddd84ecbab04f87c4caada53dab7cfc4432622d39",
      },
      "no-comments/javascript.cjs": {
        version: 2,
        sha256: "cf285be5e9a12d636586771818ff20a5f805c57ed59d3442f3a7fb33f152ce6d",
      },
      "check.yml": { version: 1, sha256: "1ceaedac6bf370dcc7782bbae1099d85562d6ab5795fac12fb9939a1a8d570b1" },
      "no-comments.yml": {
        version: 1,
        sha256: "3d38d68feae1d5182aa613a855b88f702b903d0dcffd288c0ee7ae8beca10422",
      },
    });
  });

  test("the comment scanner's bundles are built from the code dim purges with", async () => {
    const built = await bundleGates();
    for (const [file, text] of Object.entries(built)) {
      expect(text, `gates/no-comments/${file} is stale; run bun run gates:bundle`).toBe(
        readFileSync(join(GATE_BUNDLES_DIR, file), "utf8"),
      );
    }
  });

  test("a project's own linter and formatter leave the installed scanner alone", () => {
    const dir = repo({ ...PROJECT, "biome.json": "{}\n" });
    installGates(dir, ["no-comments"]);
    const biome = resolve(import.meta.dir, "..", "node_modules", ".bin", "biome");
    const ran = spawnSync(biome, ["check", ".githooks/no-comments"], { cwd: dir, encoding: "utf8" });
    expect(`${ran.stdout}${ran.stderr}`).toContain("Checked 2 files");
    expect(ran.status).toBe(0);
  });

  test("names each gate for its rule, installing the files it runs from", () => {
    expect(GATE_NAMES).toEqual(["commit-subject", "check", "no-comments"]);
    expect(
      Object.fromEntries(GATE_NAMES.map((gate) => [gate, GATES[gate].map((file) => file.target)])),
    ).toEqual({
      "commit-subject": [".githooks/commit-msg", ".github/workflows/commits.yml"],
      check: [".githooks/pre-commit", ".githooks/pre-commit.d/check", ".github/workflows/check.yml"],
      "no-comments": [
        ".githooks/pre-commit",
        ".githooks/pre-commit.d/no-comments",
        ".githooks/no-comments/scan.cjs",
        ".githooks/no-comments/javascript.cjs",
        ".github/workflows/no-comments.yml",
      ],
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

  test("installs only the chosen gates, and the pre-commit runner only for a gate that needs it", () => {
    const dir = repo();
    installGates(dir, ["commit-subject"]);
    expect(existsSync(join(dir, ".githooks/commit-msg"))).toBe(true);
    expect(existsSync(join(dir, ".githooks/pre-commit"))).toBe(false);
    expect(existsSync(join(dir, ".githooks/no-comments"))).toBe(false);
  });

  test("installs the recorded choice when none is named", () => {
    const dir = repo();
    installGates(dir, ["check"]);
    rmSync(join(dir, ".githooks/pre-commit.d/check"));
    expect(installGates(dir, null)).toMatchObject({
      gates: ["check"],
      written: [".githooks/pre-commit.d/check"],
    });
  });

  test("refuses to install with no choice named or recorded, writing nothing", () => {
    const dir = repo();
    expect(refusalOf(() => installGates(dir, null))).toBe("no_gates_chosen");
    expect(existsSync(join(dir, ".githooks"))).toBe(false);
    expect(existsSync(join(dir, ".dim"))).toBe(false);
  });

  test("removes a gate no longer chosen, keeping a file another chosen gate still runs", () => {
    const dir = repo();
    installGates(dir, EVERY);
    expect(installGates(dir, ["commit-subject", "check"]).removed).toEqual([
      ".githooks/pre-commit.d/no-comments",
      ".githooks/no-comments/scan.cjs",
      ".githooks/no-comments/javascript.cjs",
      ".github/workflows/no-comments.yml",
    ]);
    expect(existsSync(join(dir, ".githooks/pre-commit"))).toBe(true);
  });

  test("reports an installed gate that is not chosen", () => {
    const dir = repo();
    installGates(dir, EVERY);
    expect(states(dir, ["commit-subject", "no-comments"])[".githooks/pre-commit.d/check"]).toBe("unchosen");
  });

  test("the check gate runs the check the project declares", () => {
    const dir = repo();
    installGates(dir, ["check"]);
    expect(read(dir, ".githooks/pre-commit.d/check")).toEndWith("\nexec make check\n");
  });

  test("the check gate's workflow runs the check on Linux after the project's pinned tools and frozen install", () => {
    const plain = repo({ Makefile: "check:\n\ttrue\n" });
    installGates(plain, ["check"]);
    expect(read(plain, ".github/workflows/check.yml")).toContain("    runs-on: ubuntu-latest\n");
    expect(read(plain, ".github/workflows/check.yml")).toEndWith(
      "|| github.sha }}\n      - run: make check\n",
    );

    const pinned = repo({
      "mise.toml": '[tools]\nbun = "1"\n',
      "package.json": '{ "scripts": { "check": "true" } }\n',
      "bun.lock": "",
    });
    installGates(pinned, ["check"]);
    expect(read(pinned, ".github/workflows/check.yml")).toEndWith(
      [
        "      - uses: jdx/mise-action@v5",
        "      - run: bun install --frozen-lockfile --ignore-scripts",
        "      - run: bun run check",
        "",
      ].join("\n"),
    );
  });

  test("a commit is refused while the project's check fails", () => {
    const dir = repo({ ...PROJECT, Makefile: "check:\n\tfalse\n" });
    installGates(dir, EVERY);
    expect(commit(dir, "feat: add the gates").status).not.toBe(0);
    writeFileSync(join(dir, "Makefile"), "check:\n\ttrue\n");
    expect(commit(dir, "feat: add the gates").status).toBe(0);
  });

  test("a commit is refused while a tracked file carries a comment", () => {
    const dir = repo();
    installGates(dir, EVERY);
    writeFileSync(join(dir, "src/a.ts"), "export const a = 1; // why\n");
    const refused = commit(dir, "feat: add the gates");
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("no-comments: src/a.ts holds 1 comment(s)");
    writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
    expect(commit(dir, "feat: add the gates").status).toBe(0);
  });

  test("installs a language's scanner only where the project uses that language", () => {
    const dir = repo();
    installGates(dir, EVERY);
    rmSync(join(dir, "package.json"));
    execFileSync("git", ["-C", dir, "rm", "-q", "--cached", "package.json"]);
    writeFileSync(join(dir, "deno.json"), "{}\n");
    execFileSync("git", ["-C", dir, "add", "deno.json"]);
    expect(states(dir)[".githooks/no-comments/javascript.cjs"]).toBe("installed");
  });

  test("refuses the comment ban in a project with no language it reads, writing nothing", () => {
    const dir = repo({ Makefile: "check:\n\ttrue\n" });
    expect(refusalOf(() => installGates(dir, EVERY))).toBe("no_ecosystem");
    expect(existsSync(join(dir, ".githooks"))).toBe(false);
    expect(existsSync(join(dir, ".dim"))).toBe(false);
  });

  test("refuses the check gate in a project that declares no check, writing nothing", () => {
    const dir = repo({ "package.json": "{}\n" });
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
    expect(installGates(dir, null)).toEqual({
      gates: EVERY,
      written: [],
      removed: [],
      backups: [],
      format: null,
    });
  });

  test("naming the same gates again leaves the project's own formatting of its settings alone", () => {
    const dir = repo();
    installGates(dir, EVERY);
    const formatted = `{ "gates": ${JSON.stringify(EVERY)} }\n`;
    writeFileSync(join(dir, ".dim/config.json"), formatted);
    expect(installGates(dir, EVERY).format).toBeNull();
    expect(read(dir, ".dim/config.json")).toBe(formatted);
  });

  test("runs the project's format task after writing its settings", () => {
    const dir = repo({ ...PROJECT, Makefile: "check:\n\ttrue\nformat:\n\ttouch formatted\n" });
    expect(installGates(dir, EVERY).format).toMatchObject({ command: "make format", exitCode: 0 });
    expect(existsSync(join(dir, "formatted"))).toBe(true);
  });

  test("replaces a gate behind the canonical one, keeping no copy", () => {
    const dir = repo({ ...PROJECT, ".githooks/commit-msg": "#!/bin/sh\n# dim-gate:0\nexit 0\n" });
    expect(states(dir)[".githooks/commit-msg"]).toBe("behind");
    const result = installGates(dir, ["commit-subject"]);
    expect(result.written).toEqual([".githooks/commit-msg", ".github/workflows/commits.yml"]);
    expect(result.backups).toEqual([]);
    expect(read(dir, ".githooks/commit-msg")).toBe(canonical("commit-msg"));
  });

  test("moves a gate changed in place aside before replacing it", () => {
    const edited = canonical("commit-msg").replace("-le 50", "-le 72");
    const dir = repo({ ...PROJECT, ".githooks/commit-msg": edited });
    expect(states(dir)[".githooks/commit-msg"]).toBe("changed");
    const result = installGates(dir, EVERY);
    expect(result.backups).toEqual([".githooks/commit-msg.dim-backup"]);
    expect(read(dir, ".githooks/commit-msg.dim-backup")).toBe(edited);
    expect(read(dir, ".githooks/commit-msg")).toBe(canonical("commit-msg"));
  });

  test("treats a project's own file at a gate's path as changed when chosen, and leaves it when not", () => {
    const own = "#!/bin/sh\nexit 0\n";
    const dir = repo({ ...PROJECT, ".githooks/pre-commit": own });
    expect(states(dir)[".githooks/pre-commit"]).toBe("changed");
    installGates(dir, ["commit-subject"]);
    expect(read(dir, ".githooks/pre-commit")).toBe(own);
  });

  test("rewrites a check gate after the project names another check, keeping no copy, but not one edited in place", () => {
    const dir = repo();
    installGates(dir, EVERY);
    writeFileSync(join(dir, "Makefile"), "check:\n\ttrue\nci:\n\ttrue\n");
    mkdirSync(join(dir, ".dim"), { recursive: true });
    writeFileSync(
      join(dir, ".dim/config.json"),
      `{ "gates": ${JSON.stringify(EVERY)}, "tasks": { "check": "ci" } }\n`,
    );
    expect(states(dir)[".githooks/pre-commit.d/check"]).toBe("behind");
    expect(installGates(dir, null).backups).toEqual([]);
    expect(read(dir, ".githooks/pre-commit.d/check")).toEndWith("\nexec make ci\n");

    writeFileSync(join(dir, ".githooks/pre-commit.d/check"), "#!/bin/sh\n# dim-gate:1\nexit 0\n");
    expect(states(dir)[".githooks/pre-commit.d/check"]).toBe("changed");
  });

  test("leaves a gate ahead of this dim as it is", () => {
    const ahead = "#!/bin/sh\n# dim-gate:99\nexit 0\n";
    const dir = repo({ ...PROJECT, ".githooks/commit-msg": ahead });
    expect(states(dir)[".githooks/commit-msg"]).toBe("ahead");
    installGates(dir, EVERY);
    expect(read(dir, ".githooks/commit-msg")).toBe(ahead);
  });

  test("runs a pre-commit step the project adds beside the gates", () => {
    const dir = repo();
    installGates(dir, EVERY);
    mkdirSync(join(dir, ".githooks/pre-commit.d"), { recursive: true });
    writeFileSync(join(dir, ".githooks/pre-commit.d/own"), "#!/bin/sh\necho own step failed >&2\nexit 1\n", {
      mode: 0o755,
    });
    expect(commit(dir, "feat: add the gates").stderr).toContain("own step failed");
    installGates(dir, null);
    expect(existsSync(join(dir, ".githooks/pre-commit.d/own"))).toBe(true);
  });

  test("adds the hook wiring to a package.json so a fresh clone runs the gates", () => {
    const dir = repo({
      ...PROJECT,
      "package.json": '{\n  "name": "p",\n  "scripts": {\n    "test": "bun test"\n  }\n}\n',
    });
    installGates(dir, EVERY);
    expect(JSON.parse(read(dir, "package.json")).scripts).toEqual({
      test: "bun test",
      prepare: "git config core.hooksPath .githooks",
    });
  });

  test("adds no package.json to a project without one", () => {
    const dir = repo({ Makefile: "check:\n\ttrue\n" });
    installGates(dir, ["commit-subject", "check"]);
    expect(existsSync(join(dir, "package.json"))).toBe(false);
  });

  test("refuses a package.json whose prepare script does something else, writing nothing", () => {
    const dir = repo({ ...PROJECT, "package.json": '{ "scripts": { "prepare": "husky" } }\n' });
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
