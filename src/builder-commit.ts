import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { BuildTurn } from "./build-turn";
import {
  latestOrderCommit,
  orderStatus,
  recordOrderBuild,
  recordOrderCheck,
  recordOrderCommit,
  recordOrderFile,
} from "./factory-order";
import { dataDir, type Env } from "./paths";
import { CHECK_SANDBOX, runSandboxedCheck } from "./sandboxed-check";
import { trunkBranch } from "./trunk";
import { checkCommand } from "./workspace-commands";

export class BuildTurnRefused extends Error {
  constructor(
    readonly code:
      | "no_declared_check"
      | "empty_artifact"
      | "builder_committed"
      | "nested_repository"
      | "check_failed"
      | "check_changed_tree"
      | "no_change"
      | "order_not_building"
      | "commit_refused",
    message: string,
  ) {
    super(message);
  }
}

function git(worktree: string, args: string[], options: { env?: Env; stdin?: string } = {}) {
  const run = Bun.spawnSync(["git", "-C", worktree, ...args], {
    env: options.env,
    stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: run.success, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() };
}

function head(worktree: string): string {
  const read = git(worktree, ["rev-parse", "HEAD"]);
  if (!read.ok) throw new Error(`cannot read HEAD of ${worktree}: ${read.err}`);
  return read.out;
}

/** Where the worktree left the trunk, which is where HEAD stands before the order's first commit. */
function trunkForkPoint(worktree: string): string {
  const trunk = trunkBranch(worktree);
  if ("why" in trunk) throw new Error(trunk.why);
  const base = git(worktree, ["merge-base", "HEAD", `refs/heads/${trunk.name}`]);
  if (!base.ok) throw new Error(`cannot place ${worktree} against ${trunk.name}: ${base.err}`);
  return base.out;
}

function containsGitDir(dir: string): string | null {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    // Git takes `.GIT` for `.git` on a filesystem that ignores case, as macOS's does by default.
    if (entry.toLowerCase() === ".git") return path;
    const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const found = containsGitDir(path);
      if (found) return found;
    }
  }
  return null;
}

/**
 * A repository nested in the tree is one the runner would stage as a gitlink, and the operator's
 * next `git status` would then run inside it, obeying that repository's config — its fsmonitor,
 * its filters — outside any sandbox. Found without entering one: tracked gitlinks from the index, and every untracked
 * directory git lists whole, walked for a `.git` without following links.
 */
export function nestedRepository(worktree: string): string | null {
  // NUL-separated, so a path git would otherwise quote comes back as itself.
  const tracked = git(worktree, ["ls-files", "-s", "-z"]);
  if (!tracked.ok) throw new Error(`cannot read the index of ${worktree}: ${tracked.err}`);
  const gitlink = tracked.out.split("\0").find((line) => line.startsWith("160000 "));
  if (gitlink) return gitlink.split("\t")[1] ?? gitlink;
  const untracked = git(worktree, ["ls-files", "-o", "--exclude-standard", "--directory", "-z"]);
  if (!untracked.ok) throw new Error(`cannot list what ${worktree} leaves untracked: ${untracked.err}`);
  for (const dir of untracked.out.split("\0").filter((path) => path.endsWith("/"))) {
    const found = containsGitDir(join(worktree, dir));
    if (found) return found.slice(worktree.length + 1);
  }
  return null;
}

function stagedTree(worktree: string): string {
  const staged = git(worktree, ["add", "-A"]);
  if (!staged.ok) throw new Error(`cannot stage ${worktree}: ${staged.err}`);
  const tree = git(worktree, ["write-tree"]);
  if (!tree.ok) throw new Error(`cannot read the staged tree of ${worktree}: ${tree.err}`);
  return tree.out;
}

function refuseNested(worktree: string): void {
  const nested = nestedRepository(worktree);
  if (nested) {
    throw new BuildTurnRefused(
      "nested_repository",
      `${nested} is a git repository inside the worktree, which the runner does not stage`,
    );
  }
}

function lineCount(value: string | undefined): number | undefined {
  return value === undefined || value === "-" ? undefined : Number(value);
}

/**
 * Turns what a builder left in its worktree into the order's record: runs the declared check in
 * the check sandbox, commits the worktree the way the repository's git config commits, and records
 * the commit and its files under the builder and the check under the operator. A red check is recorded and thrown, so the next turn's brief carries it.
 */
export function commitBuildTurn(options: {
  db: Database;
  orderId: string;
  builder: string;
  operator: string;
  worktree: string;
  turn: BuildTurn;
  finalSlice: boolean;
  env?: Env;
  checkSandbox?: string[];
}): { sha: string } {
  const { db, orderId, builder, operator, worktree, turn } = options;
  const env = options.env ?? process.env;
  const declared = checkCommand(worktree);
  if (!declared) {
    throw new BuildTurnRefused(
      "no_declared_check",
      `${worktree} declares no check, so the builder's turn cannot be verified`,
    );
  }
  if (options.finalSlice && turn.artifact === "") {
    throw new BuildTurnRefused("empty_artifact", "the final slice's turn returned an empty Build artifact");
  }
  const recorded = latestOrderCommit(db, orderId);
  const before = head(worktree);
  const base = recorded ? recorded.sha.toLowerCase() : trunkForkPoint(worktree);
  const branch = git(worktree, ["symbolic-ref", "-q", "HEAD"]).out;
  if (branch !== `refs/heads/${orderId}` || !before.startsWith(base)) {
    throw new BuildTurnRefused(
      "builder_committed",
      `worktree HEAD is ${branch || "detached"} at ${before}, not refs/heads/${orderId} at ${base}; the runner commits a turn, so leave changes uncommitted`,
    );
  }

  refuseNested(worktree);
  // The check runs the builder's code with the worktree writable, so what it passed is the tree
  // staged before it ran, and a tree it changed is refused rather than committed unchecked.
  const checked = stagedTree(worktree);
  const check = runSandboxedCheck({
    worktree,
    command: declared.command,
    canary: join(dataDir(env), `check-canary-${randomUUID()}`),
    sandbox: options.checkSandbox ?? CHECK_SANDBOX,
    // PATH alone: the caller's env carries the operator's factory identity, which the builder's
    // code must not run with.
    env: env.PATH === undefined ? {} : { PATH: env.PATH },
  });
  const checkRow = {
    command: check.command,
    exitCode: check.exitCode,
    startedAt: check.startedAt,
    finishedAt: check.finishedAt,
    result: check.output,
  };
  if (check.exitCode !== 0) {
    git(worktree, ["reset", "-q"]);
    recordOrderCheck(db, orderId, checkRow, operator);
    throw new BuildTurnRefused(
      "check_failed",
      `${check.command} exited ${check.exitCode} in the check sandbox:\n${check.output}`,
    );
  }

  refuseNested(worktree);
  if (stagedTree(worktree) !== checked) {
    git(worktree, ["reset", "-q"]);
    throw new BuildTurnRefused(
      "check_changed_tree",
      `the check changed the worktree while it ran, so what it passed is not what would be committed: ${check.command}`,
    );
  }
  const changed = !git(worktree, ["diff", "--cached", "--quiet"]).ok;
  if (!changed && !recorded) {
    throw new BuildTurnRefused("no_change", "the turn left no change in the worktree to commit");
  }
  // A long check leaves time for the order to be stopped or moved; committing now would leave a
  // commit no record can take.
  if (orderStatus(db, orderId) !== "working") {
    git(worktree, ["reset", "-q"]);
    throw new BuildTurnRefused("order_not_building", `order ${orderId} stopped building while its check ran`);
  }

  if (!changed) {
    recordOrderCheck(db, orderId, checkRow, operator);
    if (options.finalSlice) recordOrderBuild(db, orderId, turn.artifact, before, builder);
    return { sha: before };
  }
  const commit = git(
    worktree,
    // Author, committer and whether to sign all come from the repository's own git config, so an
    // order commit is made the way that user's other commits are.
    ["-c", `core.hooksPath=${hooksOutsideTree(worktree)}`, "commit", "-q", "-F", "-"],
    {
      // The check the pre-commit hook would run is the one just run and recorded in the sandbox;
      // the hook would run the builder's code again, unconfined, as the operator.
      env: { ...process.env, DIM_SKIP_CHECK: "1" },
      stdin: `${turn.subject}\n`,
    },
  );
  if (!commit.ok) {
    git(worktree, ["reset", "-q"]);
    throw new BuildTurnRefused("commit_refused", `git refused the commit: ${commit.err || commit.out}`);
  }
  try {
    const sha = head(worktree);
    const numstat = git(worktree, [
      "-c",
      "core.quotePath=false",
      "show",
      "--numstat",
      "--no-renames",
      "-z",
      "--format=",
      sha,
    ]);
    if (!numstat.ok) throw new Error(`cannot list the files of ${sha}: ${numstat.err}`);
    db.transaction(() => {
      recordOrderCommit(db, orderId, sha, builder, turn.subject);
      for (const entry of numstat.out.split("\0").filter(Boolean)) {
        const [added, removed, ...path] = entry.split("\t");
        recordOrderFile(
          db,
          orderId,
          { path: path.join("\t"), added: lineCount(added), removed: lineCount(removed) },
          builder,
        );
      }
      recordOrderCheck(db, orderId, checkRow, operator);
      if (options.finalSlice) recordOrderBuild(db, orderId, turn.artifact, sha, builder);
    })();
    return { sha };
  } catch (error) {
    // Unrecorded, the commit would read as the builder's own on the next turn; taking it back
    // leaves the change in the worktree for that turn to commit again.
    const undone = git(worktree, ["reset", "-q", "--soft", before]);
    if (!undone.ok) {
      throw new Error(`the commit was not recorded and could not be taken back: ${undone.err}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * The hooks git runs for the commit. Where the repository keeps them in its tree — `.husky` and
 * the like — the worktree's copy is one the builder wrote, so the primary checkout's copy of the
 * same path runs instead; hooks kept anywhere else are the ones the repository already runs.
 */
function hooksOutsideTree(worktree: string): string {
  const hooks = git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
  const top = git(worktree, ["rev-parse", "--show-toplevel"]);
  if (!hooks.ok || !top.ok)
    throw new Error(`cannot resolve the hooks of ${worktree}: ${hooks.err || top.err}`);
  const inTree = relative(top.out, hooks.out);
  if (inTree === "" || inTree.startsWith("..") || isAbsolute(inTree)) return hooks.out;
  const common = git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) throw new Error(`cannot find the primary checkout of ${worktree}: ${common.err}`);
  return join(dirname(common.out), inTree);
}
