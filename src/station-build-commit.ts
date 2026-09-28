import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CHECK_SANDBOX, runSandboxedCheck } from "./check-sandbox";
import { stagedComments } from "./comments-staged";
import { writeTransaction } from "./db";
import { commentGateFor } from "./gate-commit";
import { repoIdentityEnv } from "./git-identity";
import { trunkRef } from "./git-trunk";
import { recordOrderBuild } from "./order-artifacts";
import { latestOrderCommit } from "./order-commits";
import { recordOrderCheck, recordOrderCommit, recordOrderFile } from "./order-evidence";
import { answerOrderFindings, assertFindingAnswersOwed, BuildTurnRefused } from "./order-finding";
import { dataDir, type Env } from "./paths";
import { rebaseInProgress } from "./ship-rebase";
import { hooksOutsideTree, nestedRepository } from "./station-build-tree";
import type { BuildTurn } from "./station-build-turn";
import { writeTrace } from "./trace-store";
import { trunkCheck } from "./workspace-tasks";

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

function refuseChangedAttributes(worktree: string, trunk: string): void {
  const listed = git(worktree, ["diff", "--cached", "--name-only", "-z", trunk, "--"]);
  if (!listed.ok) throw new Error(`cannot compare ${worktree} with ${trunk}: ${listed.err}`);
  const changed = listed.out
    .split("\0")
    .filter((path) => path === ".gitattributes" || path.endsWith("/.gitattributes"));
  if (changed.length === 0) return;
  git(worktree, ["reset", "-q"]);
  throw new BuildTurnRefused(
    "attributes_changed",
    [
      `the turn changes ${changed.join(", ")}, which decides the files the comment ban reads;`,
      `restore it, since a change to it lands on ${trunk} before an order is held to it`,
    ].join("\n"),
  );
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

function refuseUntouchedTests(worktree: string, tests: readonly string[], proofRequired: boolean): void {
  if (tests.length === 0) {
    if (!proofRequired) return;
    git(worktree, ["reset", "-q"]);
    throw new BuildTurnRefused(
      "proof_missing",
      "a fix order's slice turn names no test; name in tests each test file the slice adds or changes to prove the defect",
    );
  }
  const listed = git(worktree, [
    "diff",
    "--cached",
    "--name-only",
    "--no-renames",
    "-z",
    "--diff-filter=AM",
    "HEAD",
    "--",
  ]);
  if (!listed.ok) throw new Error(`cannot list the files the turn changes in ${worktree}: ${listed.err}`);
  const touched = new Set(listed.out.split("\0"));
  const untouched = tests.filter((path) => !touched.has(path));
  if (untouched.length === 0) return;
  git(worktree, ["reset", "-q"]);
  throw new BuildTurnRefused(
    "proof_missing",
    `the turn names test ${untouched.join(", ")}, which the slice does not add or change; name only test files the slice adds or changes`,
  );
}

function lineCount(value: string | undefined): number | null {
  return value === undefined || value === "-" ? null : Number(value);
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
  worktree: string;
  turn: BuildTurn;
  owed: readonly number[];
  finalSlice: boolean;
  proofRequired: boolean;
  env?: Env;
  checkSandbox?: string[];
}): { sha: string } {
  const { db, orderId, builder, worktree, turn } = options;
  const env = options.env ?? process.env;
  const governing = trunkCheck(worktree);
  if ("refused" in governing) {
    throw governing.refused === "undeclared"
      ? new BuildTurnRefused(
          "no_declared_check",
          `${governing.trunk} declares no check, so the builder's turn cannot be verified`,
        )
      : new BuildTurnRefused(
          "check_redefined",
          `the turn redefines ${governing.task.name} in ${governing.task.source}, the check ${governing.trunk} declares; restore it, since a change to the check lands on ${governing.trunk} before an order is checked by it`,
        );
  }
  const declared = governing.task;
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
  const trunk = trunkRef(worktree);
  const commentGate = commentGateFor(worktree, trunk, env);
  const checked = stagedTree(worktree);
  if (commentGate.state === "armed") refuseChangedAttributes(worktree, trunk);
  const { unparsed } =
    commentGate.state === "armed" ? refuseAddedComments(worktree, commentGate.label) : { unparsed: [] };
  refuseUntouchedTests(worktree, turn.tests, options.proofRequired);
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
    recordOrderCheck(db, orderId, checkRow, before);
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
  if (!changed) {
    writeTransaction(db, () => {
      recordOrderCheck(db, orderId, checkRow, before);
      answerOrderFindings(db, orderId, options.runId, turn.answers, builder);
      if (options.finalSlice) recordOrderBuild(db, orderId, turn.artifact, before, builder);
    });
    return { sha: before };
  }
  const commit = git(
    worktree,
    ["-c", `core.hooksPath=${hooksOutsideTree(worktree)}`, "commit", "-q", "-F", "-"],
    {
      env: { ...repoIdentityEnv(), DIM_SKIP_CHECK: "1" },
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
    writeTransaction(db, () => {
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
      recordOrderCheck(db, orderId, checkRow, sha);
      answerOrderFindings(db, orderId, options.runId, turn.answers, builder);
      if (options.finalSlice) recordOrderBuild(db, orderId, turn.artifact, sha, builder);
    });
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
