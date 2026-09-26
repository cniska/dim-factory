import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CHECK_SANDBOX, runSandboxedCheck } from "./check-sandbox";
import { stagedComments } from "./comments-staged";
import { commentGateFor } from "./gate-commit";
import { trunkBranch } from "./git-trunk";
import { recordOrderBuild } from "./order-artifacts";
import { latestOrderCommit } from "./order-commits";
import { recordOrderCheck, recordOrderCommit, recordOrderFile } from "./order-evidence";
import { answerOrderFindings, assertFindingAnswersOwed, BuildTurnRefused } from "./order-finding";
import { isActiveOrderRun } from "./order-status";
import { dataDir, type Env } from "./paths";
import { rebaseInProgress } from "./ship-rebase";
import { hooksOutsideTree, nestedRepository } from "./station-build-tree";
import type { BuildTurn } from "./station-build-turn";
import { writeTrace } from "./trace-store";
import { checkTask } from "./workspace-tasks";

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

function trunkRef(worktree: string): string {
  const trunk = trunkBranch(worktree);
  if ("why" in trunk) throw new Error(trunk.why);
  return `refs/heads/${trunk.name}`;
}

function trunkForkPoint(worktree: string): string {
  const trunk = trunkRef(worktree);
  const base = git(worktree, ["merge-base", "HEAD", trunk]);
  if (!base.ok) throw new Error(`cannot place ${worktree} against ${trunk}: ${base.err}`);
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

function refuseAddedComments(worktree: string, label: string): { unparsed: string[] } {
  const { found, unparsed } = stagedComments(worktree);
  if (found.length === 0) return { unparsed };
  git(worktree, ["reset", "-q"]);
  throw new BuildTurnRefused(
    "comment_added",
    [
      `the turn adds a code comment, which ${label} bans:`,
      ...found.map(({ path, line }) => `  ${path}:${line}`),
      "put the why in a name, a test, or the doc that owns the subject",
    ].join("\n"),
  );
}

function lineCount(value: string | undefined): number | undefined {
  return value === undefined || value === "-" ? undefined : Number(value);
}

function assertTurnAnswersBrief(turn: BuildTurn, owed: readonly number[]): void {
  const answered = turn.answers.map((one) => one.finding);
  const extra = answered.filter((id, index) => !owed.includes(id) || answered.indexOf(id) !== index);
  if (extra.length > 0) {
    throw new BuildTurnRefused(
      "answer_not_owed",
      `the turn answers finding ${extra.join(", ")}, which its brief did not hand over as work or answers twice`,
    );
  }
  const missing = owed.filter((id) => !answered.includes(id));
  if (missing.length > 0) {
    throw new BuildTurnRefused(
      "finding_unanswered",
      `the turn leaves finding ${missing.join(", ")} unanswered; answer each finding the brief lists as work, fixed or refused`,
    );
  }
}

export function commitBuildTurn(options: {
  db: Database;
  orderId: string;
  runId: string;
  builder: string;
  operator: string;
  worktree: string;
  turn: BuildTurn;
  owed: readonly number[];
  finalSlice: boolean;
  env?: Env;
  checkSandbox?: string[];
}): { sha: string } {
  const { db, orderId, builder, operator, worktree, turn } = options;
  const env = options.env ?? process.env;
  const declared = checkTask(worktree);
  if (!declared) {
    throw new BuildTurnRefused(
      "no_declared_check",
      `${worktree} declares no check, so the builder's turn cannot be verified`,
    );
  }
  if (options.finalSlice && turn.artifact === "") {
    throw new BuildTurnRefused("empty_artifact", "the final slice's turn returned an empty Build artifact");
  }
  assertTurnAnswersBrief(turn, options.owed);
  assertFindingAnswersOwed(db, orderId, turn.answers);
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
  const commentGate = commentGateFor(worktree, trunkRef(worktree), env);
  const checked = stagedTree(worktree);
  const { unparsed } =
    commentGate.state === "armed" ? refuseAddedComments(worktree, commentGate.label) : { unparsed: [] };
  const check = runSandboxedCheck({
    worktree,
    command: declared.commandLine,
    canary: join(dataDir(env), `check-canary-${randomUUID()}`),
    sandbox: options.checkSandbox ?? CHECK_SANDBOX,
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
  const fixed = turn.answers.filter((one) => one.answer === "fixed").map((one) => one.finding);
  if (!changed && fixed.length > 0) {
    throw new BuildTurnRefused(
      "no_change",
      `the turn answers finding ${fixed.join(", ")} fixed and left no change in the worktree; refuse a finding that needs no change, with the reason`,
    );
  }
  if (!isActiveOrderRun(db, orderId, options.runId)) {
    git(worktree, ["reset", "-q"]);
    throw new BuildTurnRefused(
      "order_not_building",
      `order ${orderId} is no longer held by run ${options.runId} after its check ran`,
    );
  }

  if (!changed) {
    db.transaction(() => {
      recordOrderCheck(db, orderId, checkRow, operator);
      answerOrderFindings(db, orderId, options.runId, turn.answers, builder);
      if (options.finalSlice) recordOrderBuild(db, orderId, turn.artifact, before, builder);
    })();
    return { sha: before };
  }
  const commit = git(
    worktree,
    ["-c", `core.hooksPath=${hooksOutsideTree(worktree)}`, "commit", "-q", "-F", "-"],
    {
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
      answerOrderFindings(db, orderId, options.runId, turn.answers, builder);
      if (options.finalSlice) recordOrderBuild(db, orderId, turn.artifact, sha, builder);
    })();
    for (const path of unparsed) writeTrace(db, { event: "order.file_unparsed", orderId, path });
    return { sha };
  } catch (error) {
    const undone = git(worktree, ["reset", "-q", "--soft", before]);
    if (!undone.ok) {
      throw new Error(`the commit was not recorded and could not be taken back: ${undone.err}`, {
        cause: error,
      });
    }
    throw error;
  }
}
