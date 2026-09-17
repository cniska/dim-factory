import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTask, declaredTasks, packageManager } from "./tasks";

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

describe("declared tasks", () => {
  test("names the script as the repo declares it, through its own package manager", () => {
    const root = repo({
      "package.json": JSON.stringify({ scripts: { verify: "biome check && bun test" } }),
      "bun.lock": "",
    });
    expect(declaredTasks(root)).toEqual([
      { name: "verify", command: "bun run verify", source: "package.json" },
    ]);
  });

  // The lock file is what names the manager; a manifest alone cannot.
  test("reads the package manager from the lock file", () => {
    expect(packageManager(repo({ "pnpm-lock.yaml": "" }))).toBe("pnpm");
    expect(packageManager(repo({ "yarn.lock": "" }))).toBe("yarn");
    expect(packageManager(repo({}))).toBe("npm");
  });

  test("reads mise tasks and Makefile targets", () => {
    const root = repo({
      "mise.toml": '[tasks.lint]\nrun = "biome check"\n',
      Makefile: ".PHONY: build\nbuild:\n\tgo build ./...\nVAR := x\n",
    });
    const names = declaredTasks(root).map((t) => [t.name, t.command]);
    expect(names).toContainEqual(["lint", "mise run lint"]);
    expect(names).toContainEqual(["build", "make build"]);
    // `VAR := x` is an assignment, not a target.
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
  // A repo declaring both means the wider one: gating on `test` alone passes a
  // change that does not compile.
  test("prefers the widest declared check over a narrower one", () => {
    const root = repo({
      "package.json": JSON.stringify({ scripts: { test: "bun test", verify: "bun run lint && bun test" } }),
      "bun.lock": "",
    });
    expect(checkTask(root)?.name).toBe("verify");
  });

  test("falls back to test where that is all the repo declares", () => {
    const root = repo({ "package.json": JSON.stringify({ scripts: { test: "bun test" } }), "bun.lock": "" });
    expect(checkTask(root)?.command).toBe("bun run test");
  });

  test("finds this repo's own check task", () => {
    expect(checkTask(new URL("..", import.meta.url).pathname)?.command).toBe("bun run verify");
  });
});
