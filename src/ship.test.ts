import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { integratedRepo, orderWorktree, repoWithoutTrunk } from "./fixtures.test-support";
import { type ShipRefusal, shipBranch } from "./ship";

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

describe("shipBranch", () => {
  test("shipping from the primary checkout still lands the order's own branch", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-a");
    const sha = commitFile(wt, "feat-a.txt", "a");

    shipBranch(dir, "feat-a", [sha]);

    expect(reachesNow(dir, sha)).toBe(true);
  });

  test("a repo that declares no ship method is refused from either checkout, leaving the trunk as it was", () => {
    const { dir } = repo();
    git(dir, ["config", "--unset", "dim.ship"]);
    const wt = worktree(dir, "feat-undeclared");
    const sha = commitFile(wt, "feat-undeclared.txt", "u");
    const trunkBefore = git(dir, ["rev-parse", "HEAD"]).out;

    for (const from of [dir, wt]) {
      expect(() => shipBranch(from, "feat-undeclared", [sha])).toThrow(
        expect.objectContaining({ code: "ship_no_method" } satisfies Partial<ShipRefusal>),
      );
    }
    expect(git(dir, ["rev-parse", "HEAD"]).out).toBe(trunkBefore);
  });

  test("a repo that ships by pull request is refused as unbuilt from either checkout", () => {
    const { dir } = repo();
    git(dir, ["config", "dim.ship", "pull-request"]);
    const wt = worktree(dir, "feat-pr");
    const sha = commitFile(wt, "feat-pr.txt", "pr");
    const trunkBefore = git(dir, ["rev-parse", "HEAD"]).out;

    for (const from of [dir, wt]) {
      expect(() => shipBranch(from, "feat-pr", [sha])).toThrow(
        expect.objectContaining({ code: "ship_pull_request_unbuilt" } satisfies Partial<ShipRefusal>),
      );
    }
    expect(git(dir, ["rev-parse", "HEAD"]).out).toBe(trunkBefore);
  });

  test("a commit already on the trunk is still refused where the repo declares no ship method", () => {
    const { dir } = repo();
    git(dir, ["config", "--unset", "dim.ship"]);
    const sha = git(dir, ["rev-parse", "HEAD"]).out;

    expect(() => shipBranch(dir, "main", [sha])).toThrow(
      expect.objectContaining({ code: "ship_no_method" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a repo that declares no ship method is refused for that before its trunk is looked for", () => {
    const { dir, sha } = repoWithoutTrunk();
    cleanup.push(dir);

    expect(() => shipBranch(dir, "main", [sha])).toThrow(
      expect.objectContaining({ code: "ship_no_method" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a ship method outside the vocabulary is refused rather than read as trunk", () => {
    const { dir } = repo();
    git(dir, ["config", "dim.ship", "Trunk"]);
    const wt = worktree(dir, "feat-typo");
    const sha = commitFile(wt, "feat-typo.txt", "typo");

    for (const from of [dir, wt]) {
      expect(() => shipBranch(from, "feat-typo", [sha])).toThrow(
        expect.objectContaining({ code: "ship_invalid_method" } satisfies Partial<ShipRefusal>),
      );
    }
    expect(reachesNow(dir, sha)).toBe(false);
  });

  test("the method is read from the primary checkout, not a value only the worktree holds", () => {
    const { dir } = repo();
    git(dir, ["config", "--unset", "dim.ship"]);
    git(dir, ["config", "extensions.worktreeConfig", "true"]);
    const wt = worktree(dir, "feat-local");
    git(wt, ["config", "--worktree", "dim.ship", "trunk"]);
    const sha = commitFile(wt, "feat-local.txt", "local");

    expect(() => shipBranch(wt, "feat-local", [sha])).toThrow(
      expect.objectContaining({ code: "ship_no_method" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a ship method set only in the global config is not the repo's declaration", () => {
    const { dir } = repo();
    git(dir, ["config", "--unset", "dim.ship"]);
    const globalConfig = join(dir, "..", `global-${Date.now()}.gitconfig`);
    cleanup.push(globalConfig);
    git(dir, ["config", "--file", globalConfig, "dim.ship", "trunk"]);

    // A spawned git inherits the environment this process started with, not later
    // assignments to process.env, so the global config is set on a child of its own.
    const read = Bun.spawnSync(
      [
        "bun",
        "-e",
        `import { shipMethod } from ${JSON.stringify(join(import.meta.dir, "ship-method.ts"))}; console.log(JSON.stringify(shipMethod(${JSON.stringify(dir)})))`,
      ],
      { env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig }, stdout: "pipe", stderr: "pipe" },
    );

    expect(Object.keys(JSON.parse(read.stdout.toString()))).toEqual(["missing"]);
  });

  test("a commit already on the trunk ships as already landed", () => {
    const { dir } = repo();
    const sha = git(dir, ["rev-parse", "HEAD"]).out;

    expect(shipBranch(dir, "main", [sha])).toEqual({ landed: "already" });
  });

  test("a worktree ahead of the trunk with no divergence fast-forwards", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-a");
    const sha = commitFile(wt, "feat-a.txt", "a");

    expect(shipBranch(wt, "feat-a", [sha])).toEqual({ landed: "fast_forward" });
    expect(reachesNow(dir, sha)).toBe(true);
  });

  test("a branch the trunk has moved past is refused rather than merged, leaving the trunk as it was", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-b");
    const sha = commitFile(wt, "feat-b.txt", "b");
    const trunkAhead = commitFile(dir, "trunk-moved.txt", "moved");

    expect(() => shipBranch(wt, "feat-b", [sha])).toThrow(
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

    expect(shipBranch(wt, "feat-tagged", [sha])).toEqual({ landed: "fast_forward" });
    expect(git(dir, ["rev-parse", "HEAD"]).out).toBe(sha);
  });

  test("a repository that does not sign its commits ships them unsigned", () => {
    const { dir } = repo();
    git(dir, ["config", "commit.gpgsign", "false"]);
    const wt = worktree(dir, "feat-plain");
    const sha = commitFile(wt, "feat-plain.txt", "plain");

    expect(shipBranch(wt, "feat-plain", [sha])).toEqual({ landed: "fast_forward" });
    expect(git(dir, ["verify-commit", sha]).success).toBe(false);
  });

  test("a repo that names no trunk is refused", () => {
    const { dir, sha } = repoWithoutTrunk();
    cleanup.push(dir);
    git(dir, ["config", "dim.ship", "trunk"]);

    expect(() => shipBranch(dir, "main", [sha])).toThrow(
      expect.objectContaining({ code: "ship_no_trunk" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a trunk checkout with its own uncommitted changes is refused", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-d");
    const sha = commitFile(wt, "feat-d.txt", "d");
    writeFileSync(join(dir, "dirty.txt"), "uncommitted");

    expect(() => shipBranch(wt, "feat-d", [sha])).toThrow(
      expect.objectContaining({ code: "ship_dirty_trunk" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a primary checkout not sitting on the trunk is refused", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-f");
    const sha = commitFile(wt, "feat-f.txt", "f");
    git(dir, ["checkout", "-q", "-b", "not-trunk"]);

    expect(() => shipBranch(wt, "feat-f", [sha])).toThrow(
      expect.objectContaining({ code: "ship_wrong_head" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a branch that names no ref cannot be shipped", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-e");
    const sha = commitFile(wt, "feat-e.txt", "e");

    expect(() => shipBranch(wt, "no-such-branch", [sha])).toThrow(
      expect.objectContaining({ code: "ship_no_branch" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a recorded sha the shipped branch never carried is refused after the branch lands", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-g");
    const landedSha = commitFile(wt, "feat-g.txt", "g");
    const strayWt = worktree(dir, "stray");
    const strayShaOffBranch = commitFile(strayWt, "stray.txt", "stray");

    expect(() => shipBranch(wt, "feat-g", [landedSha, strayShaOffBranch])).toThrow(
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

    expect(() => shipBranch(wt, "feat-unsigned", [signed, unsigned])).toThrow(
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

    expect(() => shipBranch(wt, "feat-h", [alreadyLandedSha, strayShaOffBranch])).toThrow(
      expect.objectContaining({ code: "ship_not_landed" } satisfies Partial<ShipRefusal>),
    );
  });
});

function reachesNow(dir: string, sha: string): boolean {
  return git(dir, ["merge-base", "--is-ancestor", sha, "HEAD"]).success;
}
