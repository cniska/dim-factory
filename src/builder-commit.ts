import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { BuildTurn } from "./build-turn";
import { hooksOutsideTree, nestedRepository } from "./builder-tree";
import {
  isActiveOrderRun,
  latestOrderCommit,
  recordOrderBuild,
  recordOrderCheck,
  recordOrderCommit,
  recordOrderFile,
} from "./factory-order";
import { dataDir, type Env } from "./paths";
import { rebaseInProgress } from "./rebase-onto-trunk";
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
      | "commit_refused"
      | "rebase_in_progress"
      | "rebase_mismatch"
      | "conflict_unresolved",
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
  runId: string;
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
  if (rebaseInProgress(worktree)) {
    throw new BuildTurnRefused(
      "rebase_in_progress",
      `${worktree} is mid-rebase, and a commit made there would land inside the rebase rather than on the order's branch`,
    );
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
  // A long check leaves time for the order to be stopped, moved or taken by another run; committing
  // now would leave a commit no record can take, or one recorded under the wrong run.
  if (!isActiveOrderRun(db, orderId, options.runId)) {
    git(worktree, ["reset", "-q"]);
    throw new BuildTurnRefused(
      "order_not_building",
      `order ${orderId} is no longer held by run ${options.runId} after its check ran`,
    );
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
