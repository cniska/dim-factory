import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkChanged } from "./slice-effects";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function commit(root: string): string {
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
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim();
}

test("a commit that names another declared task as the check changes the check's definition", () => {
  const root = mkdtempSync(join(tmpdir(), "dim-slice-effects-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { check: "bun test", lenient: "true" } }),
  );
  writeFileSync(join(root, "bun.lock"), "");
  const tip = commit(root);
  writeFileSync(join(root, "notes.txt"), "x\n");
  const unrelated = commit(root);
  mkdirSync(join(root, ".dim"));
  writeFileSync(join(root, ".dim", "config.json"), '{ "tasks": { "check": "lenient" } }\n');
  const renamed = commit(root);

  expect(checkChanged(root, tip, unrelated)).toBe(false);
  expect(checkChanged(root, tip, renamed)).toBe(true);
});
