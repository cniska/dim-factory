import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integratedRepo, orderWorktree, repoWithoutTrunk } from "./fixtures.test-support";
import { rebaseState } from "./git-rebase";
import type { Rewrite } from "./git-rebase-contract";
import { RebaseConflict, type RebaseVerdict, shipBranch } from "./ship";
import { ShipRefusal } from "./ship-refusal";

const landRebased = (rewrite: Rewrite): RebaseVerdict => ({ land: rewrite.commits.map((c) => c.to) });

function ship(cwd: string, branch: string, shas: string[], onRebased = landRebased) {
  return shipBranch(cwd, branch, shas, onRebased);
}

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

function nestedAtGitlink(dir: string): string {
  const nested = join(dir, "sub");
  mkdirSync(nested);
  git(nested, ["init", "-q", "-b", "main"]);
  git(nested, ["config", "user.email", "t@example.com"]);
  git(nested, ["config", "user.name", "Test"]);
  git(nested, ["config", "commit.gpgsign", "false"]);
  git(nested, ["commit", "-q", "--allow-empty", "-m", "nested"]);
  const head = git(nested, ["rev-parse", "HEAD"]).out;
  git(dir, ["update-index", "--add", "--cacheinfo", `160000,${head},sub`]);
  git(dir, ["commit", "-q", "-m", "chore: add sub"]);
  expect(git(dir, ["ls-tree", "HEAD", "sub"]).out).toStartWith("160000 commit");
  return nested;
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

    ship(dir, "feat-a", [sha]);

    expect(reachesNow(dir, sha)).toBe(true);
  });

  test("a repo that declares no ship method is refused from either checkout, leaving the trunk as it was", () => {
    const { dir } = repo();
    git(dir, ["config", "--unset", "dim.ship"]);
    const wt = worktree(dir, "feat-undeclared");
    const sha = commitFile(wt, "feat-undeclared.txt", "u");
    const trunkBefore = git(dir, ["rev-parse", "HEAD"]).out;

    for (const from of [dir, wt]) {
      expect(() => ship(from, "feat-undeclared", [sha])).toThrow(
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
      expect(() => ship(from, "feat-pr", [sha])).toThrow(
        expect.objectContaining({ code: "ship_pull_request_unbuilt" } satisfies Partial<ShipRefusal>),
      );
    }
    expect(git(dir, ["rev-parse", "HEAD"]).out).toBe(trunkBefore);
  });

  test("a commit already on the trunk is still refused where the repo declares no ship method", () => {
    const { dir } = repo();
    git(dir, ["config", "--unset", "dim.ship"]);
    const sha = git(dir, ["rev-parse", "HEAD"]).out;

    expect(() => ship(dir, "main", [sha])).toThrow(
      expect.objectContaining({ code: "ship_no_method" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a repo that declares no ship method is refused for that before its trunk is looked for", () => {
    const { dir, sha } = repoWithoutTrunk();
    cleanup.push(dir);

    expect(() => ship(dir, "main", [sha])).toThrow(
      expect.objectContaining({ code: "ship_no_method" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a ship method outside the vocabulary is refused rather than read as trunk", () => {
    const { dir } = repo();
    git(dir, ["config", "dim.ship", "Trunk"]);
    const wt = worktree(dir, "feat-typo");
    const sha = commitFile(wt, "feat-typo.txt", "typo");

    for (const from of [dir, wt]) {
      expect(() => ship(from, "feat-typo", [sha])).toThrow(
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

    expect(() => ship(wt, "feat-local", [sha])).toThrow(
      expect.objectContaining({ code: "ship_no_method" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a ship method set only in the global config is not the repo's declaration", () => {
    const { dir } = repo();
    git(dir, ["config", "--unset", "dim.ship"]);
    const globalConfig = join(dir, "..", `global-${Date.now()}.gitconfig`);
    cleanup.push(globalConfig);
    git(dir, ["config", "--file", globalConfig, "dim.ship", "trunk"]);

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

    expect(ship(dir, "main", [sha])).toEqual({ landed: "already" });
  });

  test("a worktree ahead of the trunk with no divergence fast-forwards", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-a");
    const sha = commitFile(wt, "feat-a.txt", "a");

    expect(ship(wt, "feat-a", [sha])).toEqual({ landed: "fast_forward" });
    expect(reachesNow(dir, sha)).toBe(true);
  });

  test("a branch the trunk has moved past is rebased onto it, one replayed commit per commit it carried", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-b");
    const first = commitFile(wt, "feat-b.txt", "b");
    const second = commitFile(wt, "feat-b2.txt", "b2");
    const trunkAhead = commitFile(dir, "trunk-moved.txt", "moved");
    let seen: Rewrite | undefined;

    const outcome = ship(wt, "feat-b", [first, second], (rewrite) => {
      seen = rewrite;
      return landRebased(rewrite);
    });

    expect(outcome).toEqual({ landed: "rebased" });
    expect(seen?.commits.map((c) => c.from)).toEqual([first, second]);
    expect(seen?.newBase).toBe(trunkAhead);
    expect(seen?.patchEqual).toBe(true);
    expect(git(dir, ["rev-parse", "HEAD"]).out).toBe(seen?.newHead as string);
    expect(git(dir, ["rev-list", "--merges", "--count", "HEAD"]).out).toBe("0");
    for (const { from, to } of seen?.commits ?? []) {
      expect(reachesNow(dir, to)).toBe(true);
      expect(reachesNow(dir, from)).toBe(false);
      expect(git(dir, ["verify-commit", to]).success).toBe(false);
      expect(git(dir, ["log", "-1", "--format=%cn", to]).out).toBe("dim");
    }
  });

  test("a rebase the caller refuses is taken back, leaving the trunk and the branch where they were", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-refused");
    const sha = commitFile(wt, "feat-refused.txt", "r");
    const trunkAhead = commitFile(dir, "trunk-moved.txt", "moved");

    expect(() =>
      ship(wt, "feat-refused", [sha], () => {
        throw new ShipRefusal("ship_check_failed", "red");
      }),
    ).toThrow(expect.objectContaining({ code: "ship_check_failed" } satisfies Partial<ShipRefusal>));
    expect(git(dir, ["rev-parse", "HEAD"]).out).toBe(trunkAhead);
    expect(git(dir, ["rev-parse", "refs/heads/feat-refused"]).out).toBe(sha);
    expect(git(wt, ["status", "--porcelain"]).out).toBe("");
  });

  test("a rebase the caller holds keeps the rewritten branch and lands nothing", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-held");
    const sha = commitFile(wt, "feat-held.txt", "h");
    const trunkAhead = commitFile(dir, "trunk-moved.txt", "moved");
    let seen: Rewrite | undefined;

    expect(() =>
      ship(wt, "feat-held", [sha], (rewrite) => {
        seen = rewrite;
        return { hold: new ShipRefusal("ship_patch_changed", "changed") };
      }),
    ).toThrow(expect.objectContaining({ code: "ship_patch_changed" } satisfies Partial<ShipRefusal>));
    expect(git(dir, ["rev-parse", "HEAD"]).out).toBe(trunkAhead);
    expect(git(dir, ["rev-parse", "refs/heads/feat-held"]).out).toBe(seen?.newHead as string);
  });

  test("a conflict is refused with the rebase it stopped, leaving the worktree mid-rebase and the trunk and branch where they were", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-clash");
    const base = git(dir, ["rev-parse", "HEAD"]).out;
    const sha = commitFile(wt, "clash.txt", "branch side");
    const trunkAhead = commitFile(dir, "clash.txt", "trunk side");

    let refused: unknown;
    try {
      ship(wt, "feat-clash", [sha]);
    } catch (error) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(RebaseConflict);
    expect(refused).toMatchObject({
      code: "ship_rebase_conflict",
      paths: ["clash.txt"],
      replay: { worktree: realpathSync(wt), oldBase: base, newBase: trunkAhead, oldHead: sha },
    });
    expect(git(dir, ["rev-parse", "HEAD"]).out).toBe(trunkAhead);
    expect(git(dir, ["rev-parse", "refs/heads/feat-clash"]).out).toBe(sha);
    expect(rebaseState(wt)).toEqual({ origHead: sha, onto: trunkAhead, headName: "refs/heads/feat-clash" });
  });

  test("a hook the builder committed into the tree does not run when its branch is rebased", () => {
    const { dir } = repo();
    git(dir, ["config", "core.hooksPath", ".githooks"]);
    const wt = worktree(dir, "feat-hooked");
    const marker = join(mkdtempSync(join(tmpdir(), "dim-hook-marker-")), "ran");
    cleanup.push(marker);
    mkdirSync(join(wt, ".githooks"));
    for (const hook of ["pre-rebase", "post-rewrite", "post-checkout"]) {
      writeFileSync(join(wt, ".githooks", hook), `#!/bin/sh\necho ${hook} >> "${marker}"\n`);
      chmodSync(join(wt, ".githooks", hook), 0o755);
    }
    git(wt, ["add", "."]);
    git(wt, ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "feat: add hooks"]);
    const sha = git(wt, ["rev-parse", "HEAD"]).out;
    commitFile(dir, "trunk-moved.txt", "moved");

    expect(ship(wt, "feat-hooked", [sha])).toEqual({ landed: "rebased" });
    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
  });

  test("a branch whose rebase would drop a commit is refused rather than paired by guess", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-merged");
    const side = worktree(dir, "feat-side");
    commitFile(side, "side.txt", "side");
    const own = commitFile(wt, "own.txt", "own");
    git(wt, ["merge", "-q", "--no-edit", "feat-side"]);
    const tip = git(wt, ["rev-parse", "HEAD"]).out;
    commitFile(dir, "trunk-moved.txt", "moved");

    expect(() => ship(wt, "feat-merged", [own, tip])).toThrow(
      expect.objectContaining({ code: "rebase_unpaired" }),
    );
    expect(git(dir, ["rev-parse", "refs/heads/feat-merged"]).out).toBe(tip);
  });

  test("a branch whose tip the order never recorded is refused before the trunk moves", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-extra");
    const recorded = commitFile(wt, "feat-extra.txt", "x");
    commitFile(wt, "unchecked.txt", "never recorded");
    const trunkBefore = git(dir, ["rev-parse", "HEAD"]).out;

    expect(() => ship(wt, "feat-extra", [recorded])).toThrow(
      expect.objectContaining({ code: "ship_unrecorded_head" } satisfies Partial<ShipRefusal>),
    );
    expect(git(dir, ["rev-parse", "HEAD"]).out).toBe(trunkBefore);
  });

  for (const trunk of ["behind", "moved on"] as const) {
    test(`a branch reset to an earlier recorded commit is refused before the trunk moves, with the trunk ${trunk}`, () => {
      const { dir } = repo();
      const wt = worktree(dir, "feat-reset");
      const first = commitFile(wt, "feat-reset.txt", "first");
      const last = commitFile(wt, "feat-reset2.txt", "last");
      git(wt, ["reset", "-q", "--hard", first]);
      if (trunk === "moved on") commitFile(dir, "trunk-moved.txt", "moved");
      const trunkBefore = git(dir, ["rev-parse", "HEAD"]).out;

      expect(() => ship(wt, "feat-reset", [first, last])).toThrow(
        expect.objectContaining({ code: "ship_unrecorded_head" } satisfies Partial<ShipRefusal>),
      );
      expect(git(dir, ["rev-parse", "HEAD"]).out).toBe(trunkBefore);
      expect(git(dir, ["rev-parse", "refs/heads/feat-reset"]).out).toBe(first);
    });
  }

  test("a rebase git refuses without a conflict is refused as failed, leaving the branch where it was", () => {
    const { dir } = repo();
    const hooks = mkdtempSync(join(tmpdir(), "dim-outside-hooks-"));
    cleanup.push(hooks);
    writeFileSync(join(hooks, "pre-rebase"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(hooks, "pre-rebase"), 0o755);
    git(dir, ["config", "core.hooksPath", hooks]);
    const wt = worktree(dir, "feat-vetoed");
    const sha = commitFile(wt, "feat-vetoed.txt", "v");
    commitFile(dir, "trunk-moved.txt", "moved");

    expect(() => ship(wt, "feat-vetoed", [sha])).toThrow(expect.objectContaining({ code: "rebase_failed" }));
    expect(git(dir, ["rev-parse", "refs/heads/feat-vetoed"]).out).toBe(sha);
  });

  test("a worktree with uncommitted changes is refused before its branch is rebased", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-unsaved");
    const sha = commitFile(wt, "feat-unsaved.txt", "u");
    commitFile(dir, "trunk-moved.txt", "moved");
    writeFileSync(join(wt, "unsaved.txt"), "unsaved");

    expect(() => ship(wt, "feat-unsaved", [sha])).toThrow(
      expect.objectContaining({ code: "ship_dirty_worktree" } satisfies Partial<ShipRefusal>),
    );
    expect(git(dir, ["rev-parse", "refs/heads/feat-unsaved"]).out).toBe(sha);
  });

  test("a worktree carrying a nested repository is refused before git runs in it", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-nested");
    const trunkSha = git(dir, ["rev-parse", "HEAD"]).out;
    git(wt, ["update-index", "--add", "--cacheinfo", `160000,${trunkSha},vendored`]);
    git(wt, ["commit", "-q", "-m", "feat: vendor a repository"]);
    const sha = git(wt, ["rev-parse", "HEAD"]).out;
    commitFile(dir, "trunk-moved.txt", "moved");

    expect(() => ship(wt, "feat-nested", [sha])).toThrow(
      expect.objectContaining({ code: "ship_nested_repository" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a branch checked out in no worktree is refused, since there is nowhere to rebase it", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-loose");
    const sha = commitFile(wt, "feat-loose.txt", "l");
    git(dir, ["worktree", "remove", "--force", wt]);
    commitFile(dir, "trunk-moved.txt", "moved");

    expect(() => ship(dir, "feat-loose", [sha])).toThrow(
      expect.objectContaining({ code: "ship_no_worktree" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a tag named like the branch cannot stand in for it", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-tagged");
    const sha = commitFile(wt, "feat-tagged.txt", "tagged");
    const other = worktree(dir, "elsewhere");
    const planted = commitFile(other, "planted.txt", "planted");
    git(dir, ["tag", "feat-tagged", planted]);

    expect(ship(wt, "feat-tagged", [sha])).toEqual({ landed: "fast_forward" });
    expect(git(dir, ["rev-parse", "HEAD"]).out).toBe(sha);
  });

  test("a repository that does not sign its commits ships them unsigned", () => {
    const { dir } = repo();
    git(dir, ["config", "commit.gpgsign", "false"]);
    const wt = worktree(dir, "feat-plain");
    const sha = commitFile(wt, "feat-plain.txt", "plain");

    expect(ship(wt, "feat-plain", [sha])).toEqual({ landed: "fast_forward" });
    expect(git(dir, ["verify-commit", sha]).success).toBe(false);
  });

  test("a repo that names no trunk is refused", () => {
    const { dir, sha } = repoWithoutTrunk();
    cleanup.push(dir);
    git(dir, ["config", "dim.ship", "trunk"]);

    expect(() => ship(dir, "main", [sha])).toThrow(
      expect.objectContaining({ code: "ship_no_trunk" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a branch the moved trunk already carries is refused for a recorded sha it never carried, with nothing rebased", () => {
    const { dir } = repo();
    const behind = git(dir, ["rev-parse", "HEAD"]).out;
    const wt = worktree(dir, "feat-behind");
    const stray = commitFile(worktree(dir, "stray-3"), "stray-3.txt", "stray");
    commitFile(dir, "trunk-moved.txt", "moved");

    expect(() => ship(wt, "feat-behind", [stray, behind])).toThrow(
      expect.objectContaining({ code: "ship_not_landed" } satisfies Partial<ShipRefusal>),
    );
    expect(git(dir, ["rev-parse", "refs/heads/feat-behind"]).out).toBe(behind);
  });

  test("a trunk checkout with its own uncommitted changes is refused", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-d");
    const sha = commitFile(wt, "feat-d.txt", "d");
    writeFileSync(join(dir, "dirty.txt"), "uncommitted");

    expect(() => ship(wt, "feat-d", [sha])).toThrow(
      expect.objectContaining({ code: "ship_dirty_trunk" } satisfies Partial<ShipRefusal>),
    );
  });

  test("checking the trunk runs no command a repository nested at a gitlink configured", () => {
    const { dir } = repo();
    const nested = nestedAtGitlink(dir);
    const hooks = mkdtempSync(join(tmpdir(), "dim-ship-fsmonitor-"));
    cleanup.push(hooks);
    const marker = join(hooks, "ran");
    writeFileSync(join(hooks, "fsmonitor.sh"), `#!/bin/sh\ntouch ${marker}\necho 0\n`);
    chmodSync(join(hooks, "fsmonitor.sh"), 0o755);
    git(nested, ["config", "core.fsmonitor", join(hooks, "fsmonitor.sh")]);
    const wt = worktree(dir, "feat-nested");
    const sha = commitFile(wt, "feat-nested.txt", "nested");

    expect(ship(wt, "feat-nested", [sha])).toEqual({ landed: "fast_forward" });
    expect(existsSync(marker)).toBe(false);
  });

  test("a trunk whose submodule moved without a commit recording it is refused", () => {
    const { dir } = repo();
    const nested = nestedAtGitlink(dir);
    const wt = worktree(dir, "feat-moved");
    const sha = commitFile(wt, "feat-moved.txt", "moved");
    git(nested, ["commit", "-q", "--allow-empty", "-m", "moved"]);

    expect(() => ship(wt, "feat-moved", [sha])).toThrow(
      expect.objectContaining({ code: "ship_dirty_trunk" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a primary checkout not sitting on the trunk is refused", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-f");
    const sha = commitFile(wt, "feat-f.txt", "f");
    git(dir, ["checkout", "-q", "-b", "not-trunk"]);

    expect(() => ship(wt, "feat-f", [sha])).toThrow(
      expect.objectContaining({ code: "ship_wrong_head" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a branch that names no ref cannot be shipped", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-e");
    const sha = commitFile(wt, "feat-e.txt", "e");

    expect(() => ship(wt, "no-such-branch", [sha])).toThrow(
      expect.objectContaining({ code: "ship_no_branch" } satisfies Partial<ShipRefusal>),
    );
  });

  test("a recorded sha the shipped branch never carried is refused before the trunk moves", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-g");
    const tipSha = commitFile(wt, "feat-g.txt", "g");
    const strayWt = worktree(dir, "stray");
    const strayShaOffBranch = commitFile(strayWt, "stray.txt", "stray");
    const trunkBefore = git(dir, ["rev-parse", "HEAD"]).out;

    expect(() => ship(wt, "feat-g", [strayShaOffBranch, tipSha])).toThrow(
      expect.objectContaining({ code: "ship_not_landed" } satisfies Partial<ShipRefusal>),
    );
    expect(git(dir, ["rev-parse", "HEAD"]).out).toBe(trunkBefore);
  });

  test("in a repository that signs, a factory commit lands unsigned", () => {
    const { dir } = repo();
    const wt = worktree(dir, "feat-unsigned");
    writeFileSync(join(wt, "unsigned.txt"), "unsigned");
    git(wt, ["add", "."]);
    git(wt, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "feat: add unsigned.txt"]);
    const unsigned = git(wt, ["rev-parse", "HEAD"]).out;

    expect(ship(wt, "feat-unsigned", [unsigned])).toEqual({ landed: "fast_forward" });
    expect(git(dir, ["rev-parse", "HEAD"]).out).toBe(unsigned);
  });

  test("shipping is refused if only some of the recorded shas already reached the trunk", () => {
    const { dir } = repo();
    const alreadyLandedSha = git(dir, ["rev-parse", "HEAD"]).out;
    const wt = worktree(dir, "feat-h");
    const strayWt = worktree(dir, "stray-2");
    const strayShaOffBranch = commitFile(strayWt, "stray-2.txt", "stray");

    expect(() => ship(wt, "feat-h", [strayShaOffBranch, alreadyLandedSha])).toThrow(
      expect.objectContaining({ code: "ship_not_landed" } satisfies Partial<ShipRefusal>),
    );
  });
});

function reachesNow(dir: string, sha: string): boolean {
  return git(dir, ["merge-base", "--is-ancestor", sha, "HEAD"]).success;
}
