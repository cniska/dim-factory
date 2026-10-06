import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { languagesOf } from "./languages";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(tracked: readonly string[], untracked: readonly string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "dim-languages-"));
  roots.push(root);
  spawnSync("git", ["init", "-q"], { cwd: root });
  for (const path of [...tracked, ...untracked]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "");
  }
  if (tracked.length > 0) spawnSync("git", ["add", "--", ...tracked], { cwd: root });
  return root;
}

describe("a project's languages", () => {
  test("include TypeScript once the project tracks a TypeScript file", () => {
    expect(languagesOf(repo(["package.json", "src/app.tsx"]))).toEqual(["typescript"]);
    expect(languagesOf(repo(["scripts/build.mts"]))).toEqual(["typescript"]);
  });

  test("leave out TypeScript for a JavaScript project and for an untracked TypeScript file", () => {
    expect(languagesOf(repo(["package.json", "index.js"]))).toEqual([]);
    expect(languagesOf(repo(["index.js"], ["scratch.ts"]))).toEqual([]);
  });
});
