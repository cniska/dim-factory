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
  test("shipping from the primary checkout still lands the order's own branch", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-a");
    const sha = commitFile(wt, "feat-a.txt", "a");

    shipToTrunk(dir, "feat-a", [sha]);

    expect(reachesNow(dir, sha)).toBe(true);
  });

  test("a commit already on the trunk ships as already landed", () => {
    const { dir } = repo();
    const sha = git(dir, ["rev-parse", "HEAD"]).out;

    expect(shipToTrunk(dir, "main", [sha])).toEqual({ landed: "already" });
  });

  test("a worktree ahead of the trunk with no divergence fast-forwards", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-a");
    const sha = commitFile(wt, "feat-a.txt", "a");

    expect(shipToTrunk(wt, "feat-a", [sha])).toEqual({ landed: "fast_forward" });
    expect(reachesNow(dir, sha)).toBe(true);
  });

  test("a branch the trunk has moved past is refused rather than merged, leaving the trunk as it was", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-b");
    const sha = commitFile(wt, "feat-b.txt", "b");
    const trunkAhead = commitFile(dir, "trunk-moved.txt", "moved");

    expect(() => shipToTrunk(wt, "feat-b", [sha])).toThrow(
      expect.objectContaining({ code: "ship_not_fast_forward" } satisfies Partial<ShipRefusal>),
    );
    expect(git(dir, ["rev-parse", "HEAD"]).out).toBe(trunkAhead);
    expect(git(dir, ["rev-list", "--merges", "--count", "HEAD"]).out).toBe("0");
  });

  test("a tag named like the branch cannot stand in for it", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-tagged");
    const sha = commitFile(wt, "feat-tagged.txt", "tagged");
    const other = worktree(dir, "elsewhere");
    const planted = commitFile(other, "planted.txt", "planted");
    git(dir, ["tag", "feat-tagged", planted]);

    expect(shipToTrunk(wt, "feat-tagged", [sha])).toEqual({ landed: "fast_forward" });
    expect(git(dir, ["rev-parse", "HEAD"]).out).toBe(sha);
  });

  test("a repository that does not sign its commits ships them unsigned", () => {
    const { dir } = repo();
    git(dir, ["config", "commit.gpgsign", "false"]);
    const wt = worktree(dir, "feat-plain");
    const sha = commitFile(wt, "feat-plain.txt", "plain");

    expect(shipToTrunk(wt, "feat-plain", [sha])).toEqual({ landed: "fast_forward" });
    expect(git(dir, ["verify-commit", sha]).success).toBe(false);
  });

  test("a repo that names no trunk is refused", () => {
    const { dir, sha } = repoWithoutTrunk();
    cleanup.push(dir);

    expect(() => shipToTrunk(dir, "main", [sha])).toThrow(
      expect.objectContaining({ code: "ship_no_trunk" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a trunk checkout with its own uncommitted changes is refused", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-d");
    const sha = commitFile(wt, "feat-d.txt", "d");
    writeFileSync(join(dir, "dirty.txt"), "uncommitted");

    expect(() => shipToTrunk(wt, "feat-d", [sha])).toThrow(
      expect.objectContaining({ code: "ship_dirty_trunk" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a primary checkout not sitting on the trunk is refused", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-f");
    const sha = commitFile(wt, "feat-f.txt", "f");
    git(dir, ["checkout", "-q", "-b", "not-trunk"]);

    expect(() => shipToTrunk(wt, "feat-f", [sha])).toThrow(
      expect.objectContaining({ code: "ship_wrong_head" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a branch that names no ref cannot be shipped", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-e");
    const sha = commitFile(wt, "feat-e.txt", "e");

    expect(() => shipToTrunk(wt, "no-such-branch", [sha])).toThrow(
      expect.objectContaining({ code: "ship_no_branch" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a recorded sha the shipped branch never carried is refused after the branch lands", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-g");
    const landedSha = commitFile(wt, "feat-g.txt", "g");
    const strayWt = worktree(dir, "stray");
    const strayShaOffBranch = commitFile(strayWt, "stray.txt", "stray");

    expect(() => shipToTrunk(wt, "feat-g", [landedSha, strayShaOffBranch])).toThrow(
      expect.objectContaining({ code: "ship_not_landed" } satisfies Partial<ShipRefusal>),
    );
    expect(reachesNow(dir, landedSha)).toBe(true);
  });

  test("in a repository that signs, a commit that does not verify is refused before anything lands", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-unsigned");
    const signed = commitFile(wt, "signed.txt", "signed");
    writeFileSync(join(wt, "unsigned.txt"), "unsigned");
    git(wt, ["add", "."]);
    git(wt, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "feat: add unsigned.txt"]);
    const unsigned = git(wt, ["rev-parse", "HEAD"]).out;
    const trunkBefore = git(dir, ["rev-parse", "HEAD"]).out;

    expect(() => shipToTrunk(wt, "feat-unsigned", [signed, unsigned])).toThrow(
      expect.objectContaining({ code: "ship_unsigned" } satisfies Partial<ShipRefusal>),
    );
    expect(git(dir, ["rev-parse", "HEAD"]).out).toBe(trunkBefore);
  });

  test("shipping is refused if only some of the recorded shas already reached the trunk", () => {
    const { dir } = repo();
    const alreadyLandedSha = git(dir, ["rev-parse", "HEAD"]).out;
    const wt = worktree(dir, "feat-h");
    const strayWt = worktree(dir, "stray-2");
    const strayShaOffBranch = commitFile(strayWt, "stray-2.txt", "stray");

    expect(() => shipToTrunk(wt, "feat-h", [alreadyLandedSha, strayShaOffBranch])).toThrow(
      expect.objectContaining({ code: "ship_not_landed" } satisfies Partial<ShipRefusal>),
    );
  });
});

function reachesNow(dir: string, sha: string): boolean {
  return git(dir, ["merge-base", "--is-ancestor", sha, "HEAD"]).success;
}
