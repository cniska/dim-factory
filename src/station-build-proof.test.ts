import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SandboxedCheck } from "./check-sandbox";
import { integratedRepo } from "./fixtures.test-support";
import { proveTests } from "./station-build-proof";

const repo = integratedRepo();
afterAll(() => rmSync(repo.dir, { recursive: true, force: true }));

function git(args: string[]): string {
  return Bun.spawnSync(["git", "-C", repo.dir, ...args], { stdout: "pipe" })
    .stdout.toString()
    .trim();
}

test("checks the commit's parent with only the named tests laid over it, then puts the commit back", () => {
  writeFileSync(join(repo.dir, "fix.ts"), "export const fixed = true;\n");
  writeFileSync(join(repo.dir, "fix.test.sh"), "test -f fix.ts\n");
  git(["add", "-A"]);
  git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "fix: add the fix"]);
  const committed = git(["rev-parse", "HEAD"]);
  let seen: { fix: boolean; test: boolean } | undefined;

  const { check, refusal } = proveTests({
    worktree: repo.dir,
    tests: ["fix.test.sh"],
    check: () => {
      seen = { fix: existsSync(join(repo.dir, "fix.ts")), test: existsSync(join(repo.dir, "fix.test.sh")) };
      const ran: SandboxedCheck = {
        command: "sh fix.test.sh",
        exitCode: 1,
        output: "",
        startedAt: "2026-09-29T10:00:00.000Z",
        finishedAt: "2026-09-29T10:00:01.000Z",
      };
      return ran;
    },
  });

  expect(seen).toEqual({ fix: false, test: true });
  expect(check.exitCode).toBe(1);
  expect(refusal).toBeNull();
  expect(git(["rev-parse", "HEAD"])).toBe(committed);
  expect(git(["status", "--porcelain"])).toBe("");
  expect(readFileSync(join(repo.dir, "fix.ts"), "utf8")).toBe("export const fixed = true;\n");
});
