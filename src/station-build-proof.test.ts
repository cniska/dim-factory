import { afterAll, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { integratedRepo } from "./fixtures.test-support";
import { proveTests } from "./station-build-proof";

const repo = integratedRepo();
afterAll(() => rmSync(repo.dir, { recursive: true, force: true }));

function git(args: string[]): string {
  return Bun.spawnSync(["git", "-C", repo.dir, ...args], { stdout: "pipe" })
    .stdout.toString()
    .trim();
}

test("refuses to pin over a pin a proof left behind, before touching the worktree", () => {
  writeFileSync(join(repo.dir, "new.test.sh"), "true\n");
  git(["add", "-A"]);
  const tree = git(["write-tree"]);
  git(["update-ref", "refs/dim/proof/stale-order", tree]);

  expect(() =>
    proveTests({
      worktree: repo.dir,
      orderId: "stale-order",
      tree,
      tests: ["new.test.sh"],
      check: () => {
        throw new Error("the check ran");
      },
    }),
  ).toThrow("cannot pin the slice's tree");
  expect(git(["diff", "--cached", "--name-only"])).toBe("new.test.sh");
});
