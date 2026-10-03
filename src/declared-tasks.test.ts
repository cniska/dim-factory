import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDeclared, checkTask, formatTask, installCommand, manifestsAt } from "./declared-tasks";

const roots: string[] = [];

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "dim-tasks-"));
  roots.push(root);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("the check task", () => {
  test("names the script as the repo declares it, through its own package manager", () => {
    const root = repo({
      "package.json": JSON.stringify({ scripts: { verify: "biome check && bun test" } }),
      "bun.lock": "",
    });
    expect(checkTask(root)).toEqual({
      name: "verify",
      commandLine: "bun run verify",
      source: "package.json",
      body: '{"verify":"biome check && bun test"}',
    });
  });

  test("carries the whole section that declares the check, so a change to a task it calls shows too", () => {
    const scripts = { lint: "biome check", verify: "bun run lint && bun test" };
    const before = checkTask(repo({ "package.json": JSON.stringify({ scripts }), "bun.lock": "" }));
    const lintChanged = { scripts: { ...scripts, lint: "true" } };
    const after = checkTask(repo({ "package.json": JSON.stringify(lintChanged), "bun.lock": "" }));
    expect(before?.body).not.toBe(after?.body);
    expect(checkTask(repo({ Makefile: "verify:\n\tbun test\n" }))?.body).toBe("verify:\n\tbun test\n");
  });

  test("reads a revision's declaration from git, not the working tree", () => {
    const root = repo({
      "package.json": JSON.stringify({ scripts: { verify: "bun test" } }),
      "bun.lock": "",
    });
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "add", "-A"]);
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@e",
      "commit",
      "-qm",
      "x",
      "--no-verify",
    ]);
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { verify: "true" } }));
    const at = manifestsAt(root, "HEAD");
    expect(at === null ? null : checkDeclared(at)?.body).toBe('{"verify":"bun test"}');
    expect(checkTask(root)?.body).toBe('{"verify":"true"}');
  });

  test("runs through the package manager the lock file names", () => {
    const scripts = JSON.stringify({ scripts: { verify: "vitest" } });
    expect(checkTask(repo({ "package.json": scripts, "pnpm-lock.yaml": "" }))?.commandLine).toBe(
      "pnpm run verify",
    );
    expect(checkTask(repo({ "package.json": scripts, "yarn.lock": "" }))?.commandLine).toBe(
      "yarn run verify",
    );
  });

  test("names no task where no lock file names a manager", () => {
    expect(checkTask(repo({ "package.json": JSON.stringify({ scripts: { verify: "vitest" } }) }))).toBeNull();
  });

  test("reads mise tasks and Makefile targets", () => {
    expect(checkTask(repo({ "mise.toml": '[tasks.check]\nrun = "biome check"\n' }))?.commandLine).toBe(
      "mise run check",
    );
    const make = repo({ Makefile: ".PHONY: verify\nverify:\n\tgo test ./...\nVAR := x\n" });
    expect(checkTask(make)?.commandLine).toBe("make verify");
  });

  test("prefers the widest declared check over a narrower one", () => {
    const root = repo({
      "package.json": JSON.stringify({ scripts: { test: "bun test", verify: "bun run lint && bun test" } }),
      "bun.lock": "",
    });
    expect(checkTask(root)?.name).toBe("verify");
  });

  test("falls back to test where that is all the repo declares", () => {
    const root = repo({ "package.json": JSON.stringify({ scripts: { test: "bun test" } }), "bun.lock": "" });
    expect(checkTask(root)?.commandLine).toBe("bun run test");
  });

  test("returns nothing for a repo that declares nothing, rather than guessing", () => {
    expect(checkTask(repo({}))).toBeNull();
  });

  test("names a manifest that does not parse, rather than reading it as a repo that declares nothing", () => {
    const root = repo({ "package.json": "{ not json", "bun.lock": "" });
    expect(() => checkTask(root)).toThrow(
      expect.objectContaining({
        code: "manifest_unparseable",
        meta: expect.objectContaining({ file: "package.json" }),
      }),
    );
    expect(() => checkTask(repo({ "mise.toml": "[tasks\nverify" }))).toThrow(
      expect.objectContaining({ code: "manifest_unparseable" }),
    );
  });

  test("names a manifest it cannot read, rather than reading it as a repo that declares nothing", () => {
    const root = repo({ "package.json": JSON.stringify({ scripts: { verify: "true" } }), "bun.lock": "" });
    chmodSync(join(root, "package.json"), 0o000);
    try {
      expect(() => checkTask(root)).toThrow(
        expect.objectContaining({ code: "manifest_unreadable", meta: { path: join(root, "package.json") } }),
      );
    } finally {
      chmodSync(join(root, "package.json"), 0o644);
    }
  });

  test("finds this repo's own check task", () => {
    expect(checkTask(new URL("..", import.meta.url).pathname)?.commandLine).toBe("bun run verify");
  });
});

describe("the install command", () => {
  test("installs exactly what the committed lockfile pins, through the package manager it names", () => {
    const installs: readonly (readonly [string, string])[] = [
      ["bun.lock", "bun install --frozen-lockfile --ignore-scripts"],
      ["bun.lockb", "bun install --frozen-lockfile --ignore-scripts"],
      ["pnpm-lock.yaml", "pnpm install --frozen-lockfile --ignore-scripts"],
      ["yarn.lock", "yarn install --frozen-lockfile --ignore-scripts"],
      ["package-lock.json", "npm ci --ignore-scripts"],
    ];
    for (const [lock, commandLine] of installs) {
      expect(installCommand(repo({ "package.json": "{}", [lock]: "" }))).toEqual({
        commandLine,
        source: lock,
      });
    }
  });

  test("is nothing for a repo with no lockfile", () => {
    expect(installCommand(repo({ "package.json": "{}" }))).toBeNull();
  });
});

describe("the format task", () => {
  test("names format or fmt as the repo declares it", () => {
    const root = repo({
      "package.json": JSON.stringify({ scripts: { fmt: "biome format" } }),
      "bun.lock": "",
    });
    expect(formatTask(root)?.commandLine).toBe("bun run fmt");
  });
});

describe("a manifest that is not a manifest", () => {
  test("reads nothing from a path that is a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "dim-tasks-"));
    roots.push(root);
    mkdirSync(join(root, "Makefile"));
    expect(checkTask(root)).toBeNull();
  });

  test("does not block on a path that never delivers", async () => {
    const root = mkdtempSync(join(tmpdir(), "dim-tasks-"));
    roots.push(root);
    execFileSync("mkfifo", [join(root, "Makefile")]);

    const child = Bun.spawn(
      [
        "bun",
        "-e",
        `import {checkTask} from "${join(import.meta.dir, "declared-tasks.ts")}"; checkTask("${root}")`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    const outcome = await Promise.race([
      child.exited.then(() => "returned"),
      new Promise((r) => setTimeout(() => r("still reading"), 4000)),
    ]);
    child.kill();
    expect(outcome).toBe("returned");
  }, 10_000);
});
