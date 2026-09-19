import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { integratedRepo, orderWorktree, repoWithoutTrunk } from "./fixtures.test-support";
import { type ShipRefusal, shipToTrunk } from "./ship";

function git(dir: string, args: string[]): { success: boolean; out: string } {
  const run = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  return { success: run.success, out: run.stdout.toString().trim() };
}

function commitFile(dir: string, name: string, contents: string): string {
  writeFileSync(join(dir, name), contents);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", `feat: add ${name}`]);
  return git(dir, ["rev-parse", "HEAD"]).out;
}

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

function repo(): { dir: string } {
  const { dir } = integratedRepo();
  cleanup.push(dir);
  return { dir };
}

function worktree(dir: string, branch: string): string {
  const path = orderWorktree(dir, branch);
  cleanup.push(path);
  return path;
}

describe("shipToTrunk", () => {
  test("a commit already on the trunk ships as already landed", () => {
    const { dir } = repo();
    const sha = git(dir, ["rev-parse", "HEAD"]).out;

    expect(shipToTrunk(dir, [sha])).toEqual({ landed: "already" });
  });

  test("a worktree ahead of the trunk with no divergence fast-forwards", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-a");
    const sha = commitFile(wt, "feat-a.txt", "a");

    expect(shipToTrunk(wt, [sha])).toEqual({ landed: "fast_forward" });
    expect(reachesNow(dir, sha)).toBe(true);
  });

  test("a worktree that diverged from a trunk that moved on gets a merge commit", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-b");
    const sha = commitFile(wt, "feat-b.txt", "b");
    commitFile(dir, "trunk-moved.txt", "moved");

    expect(shipToTrunk(wt, [sha])).toEqual({ landed: "merged" });
    expect(reachesNow(dir, sha)).toBe(true);
  });

  test("shipping never rewrites the commit it lands", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-c");
    const sha = commitFile(wt, "feat-c.txt", "c");
    commitFile(dir, "trunk-moved-2.txt", "moved");

    shipToTrunk(wt, [sha]);

    expect(git(dir, ["cat-file", "-e", `${sha}^{commit}`]).success).toBe(true);
  });

  test("a conflicting merge is refused and leaves the trunk clean", () => {
    const { dir } = repo();
    writeFileSync(join(dir, "shared.txt"), "trunk");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "feat: shared on trunk"]);
    const wt = worktree(dir, "feat-conflict");
    writeFileSync(join(wt, "shared.txt"), "order");
    git(wt, ["add", "."]);
    git(wt, ["commit", "-q", "-m", "feat: shared on the order"]);
    const sha = git(wt, ["rev-parse", "HEAD"]).out;
    writeFileSync(join(dir, "shared.txt"), "trunk moved on");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "feat: shared moved on the trunk"]);

    expect(() => shipToTrunk(wt, [sha])).toThrow(
      expect.objectContaining({ code: "ship_conflict" } satisfies Partial<ShipRefusal>),
    );
    expect(git(dir, ["status", "--porcelain"]).out).toBe("");
  });

  test("a repo that names no trunk is refused", () => {
    const { dir, sha } = repoWithoutTrunk();
    cleanup.push(dir);

    expect(() => shipToTrunk(dir, [sha])).toThrow(
      expect.objectContaining({ code: "ship_no_trunk" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a trunk checkout with its own uncommitted changes is refused", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-d");
    const sha = commitFile(wt, "feat-d.txt", "d");
    writeFileSync(join(dir, "dirty.txt"), "uncommitted");

    expect(() => shipToTrunk(wt, [sha])).toThrow(
      expect.objectContaining({ code: "ship_dirty_trunk" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a primary checkout not sitting on the trunk is refused", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-f");
    const sha = commitFile(wt, "feat-f.txt", "f");
    git(dir, ["checkout", "-q", "-b", "not-trunk"]);

    expect(() => shipToTrunk(wt, [sha])).toThrow(
      expect.objectContaining({ code: "ship_wrong_head" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a worktree with no branch checked out cannot be shipped", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-e");
    const sha = commitFile(wt, "feat-e.txt", "e");
    git(wt, ["checkout", "-q", "--detach", "HEAD"]);

    expect(() => shipToTrunk(wt, [sha])).toThrow(
      expect.objectContaining({ code: "ship_detached" } satisfies Partial<ShipRefusal>),
    );
  });
});

function reachesNow(dir: string, sha: string): boolean {
  return git(dir, ["merge-base", "--is-ancestor", sha, "HEAD"]).success;
}
