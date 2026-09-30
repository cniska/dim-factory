import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTask, formatTask } from "./workspace-tasks";

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
    });
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

  test("survives a manifest that does not parse", () => {
    expect(checkTask(repo({ "package.json": "{ not json", "bun.lock": "" }))).toBeNull();
  });

  test("finds this repo's own check task", () => {
    expect(checkTask(new URL("..", import.meta.url).pathname)?.commandLine).toBe("bun run verify");
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
        `import {checkTask} from "${join(import.meta.dir, "workspace-tasks.ts")}"; checkTask("${root}")`,
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
