import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTask, declaredTasks, packageManager } from "./workspace-tasks";

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

describe("declared workspace tasks", () => {
  test("names the script as the repo declares it, through its own package manager", () => {
    const root = repo({
      "package.json": JSON.stringify({ scripts: { verify: "biome check && bun test" } }),
      "bun.lock": "",
    });
    expect(declaredTasks(root)).toEqual([
      { name: "verify", commandLine: "bun run verify", source: "package.json" },
    ]);
  });

  test("reads the package manager from the lock file", () => {
    expect(packageManager(repo({ "pnpm-lock.yaml": "" }))).toBe("pnpm");
    expect(packageManager(repo({ "yarn.lock": "" }))).toBe("yarn");
    expect(packageManager(repo({}))).toBeNull();
  });

  test("reads mise tasks and Makefile targets", () => {
    const root = repo({
      "mise.toml": '[tasks.lint]\nrun = "biome check"\n',
      Makefile: ".PHONY: build\nbuild:\n\tgo build ./...\nVAR := x\n",
    });
    const names = declaredTasks(root).map((t) => [t.name, t.commandLine]);
    expect(names).toContainEqual(["lint", "mise run lint"]);
    expect(names).toContainEqual(["build", "make build"]);
    expect(names.map((n) => n[0])).not.toContain("VAR");
  });

  test("returns nothing for a repo that declares nothing, rather than guessing", () => {
    expect(declaredTasks(repo({}))).toEqual([]);
    expect(checkTask(repo({}))).toBeNull();
  });

  test("survives a manifest that does not parse", () => {
    expect(declaredTasks(repo({ "package.json": "{ not json" }))).toEqual([]);
  });
});

describe("the check task", () => {
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

  test("finds this repo's own check task", () => {
    expect(checkTask(new URL("..", import.meta.url).pathname)?.commandLine).toBe("bun run verify");
  });
});

describe("a manifest that is not a manifest", () => {
  test("reads nothing from a path that is a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "dim-tasks-"));
    roots.push(root);
    mkdirSync(join(root, "Makefile"));
    expect(declaredTasks(root)).toEqual([]);
  });

  test("does not block on a path that never delivers", async () => {
    const root = mkdtempSync(join(tmpdir(), "dim-tasks-"));
    roots.push(root);
    execFileSync("mkfifo", [join(root, "Makefile")]);

    const child = Bun.spawn(
      [
        "bun",
        "-e",
        `import {declaredTasks} from "${join(import.meta.dir, "workspace-tasks.ts")}"; declaredTasks("${root}")`,
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

describe("the package manager", () => {
  test("names no task where no lock file names a manager", () => {
    const root = repo({ "package.json": JSON.stringify({ scripts: { verify: "vitest" } }) });
    expect(packageManager(root)).toBeNull();
    expect(declaredTasks(root)).toEqual([]);
  });
});
