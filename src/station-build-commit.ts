import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CHECK_SANDBOX, runSandboxedCheck, type SandboxedCheck } from "./check-sandbox";
import type { CodedError } from "./coded-error";
import { stagedComments } from "./comments-staged";
import { writeTransaction } from "./db";
import { commentGateFor } from "./gate-commit";
import { factoryCommitEnv, UNSIGNED } from "./git-identity";
import { rebaseInProgress } from "./git-rebase";
import { git, hooksOutsideTree } from "./git-tree";
import { trunkRef } from "./git-trunk";
import { recordOrderBuild } from "./order-artifacts";
import { latestOrderCommit } from "./order-commits";
import {
  checkRowOf,
  type OrderProof,
  recordOrderCheck,
  recordOrderCommit,
  recordOrderFile,
  recordOrderProof,
} from "./order-evidence";
import { answerOrderFindings, assertFindingAnswersOwed } from "./order-finding";
import { dataDir, type Env } from "./paths";
import { proveTests } from "./station-build-proof";
import { checkedTreeRefusal, nestedRefusal, stagedTree } from "./station-build-tree";
import type { BuildTurn } from "./station-build-turn";
import { fail } from "./station-contract";
import { writeTrace } from "./trace-store";
import { trunkCheck } from "./workspace-tasks";

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

function changedAttributes(worktree: string, trunk: string): CodedError | null {
  const listed = git(worktree, ["diff", "--cached", "--name-only", "-z", trunk, "--"]);
  if (!listed.ok) throw new Error(`cannot compare ${worktree} with ${trunk}: ${listed.err}`);
  const changed = listed.out
    .split("\0")
    .filter((path) => path === ".gitattributes" || path.endsWith("/.gitattributes"));
  if (changed.length === 0) return null;
  git(worktree, ["reset", "-q"]);
  return fail("attributes_changed", { changed, trunk });
}

function addedComments(worktree: string, label: string): { refused: CodedError } | { unparsed: string[] } {
  const { found, unparsed } = stagedComments(worktree);
  if (found.length === 0) return { unparsed };
  git(worktree, ["reset", "-q"]);
  return {
    refused: fail("comment_added", { label, found }),
  };
}

function refuseUntouchedTests(worktree: string, tests: readonly string[], proofRequired: boolean): void {
  if (tests.length === 0) {
    if (!proofRequired) return;
    git(worktree, ["reset", "-q"]);
    throw fail("proof_unnamed", {});
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
  throw fail("proof_untouched", { tests: untouched });
}

function lineCount(value: string | undefined): number | null {
  return value === undefined || value === "-" ? null : Number(value);
}

function assertTurnAnswersBrief(turn: BuildTurn, owed: readonly number[]): void {
  const answered = turn.answers.map((one) => one.finding);
  const extra = answered.filter((id, index) => !owed.includes(id) || answered.indexOf(id) !== index);
  if (extra.length > 0) {
    throw fail("answer_not_owed", { findings: extra });
  }
  const missing = owed.filter((id) => !answered.includes(id));
  if (missing.length > 0) {
    throw fail("finding_unanswered", { findings: missing });
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
}): { sha: string } | { refused: CodedError } {
  const { db, orderId, builder, worktree, turn } = options;
  const env = options.env ?? process.env;
  const governing = trunkCheck(worktree);
  if ("refused" in governing) {
    throw governing.refused === "undeclared"
      ? fail("no_declared_check", { trunk: governing.trunk })
      : fail("check_redefined", {
          task: governing.task.name,
          source: governing.task.source,
          trunk: governing.trunk,
        });
  }
  const declared = governing.task;
  if (options.finalSlice && turn.artifact === "") {
    throw fail("empty_artifact", {});
  }
  assertTurnAnswersBrief(turn, options.owed);
  assertFindingAnswersOwed(db, orderId, turn.answers);
  if (rebaseInProgress(worktree)) {
    throw fail("rebase_in_progress", { worktree });
  }
  const recorded = latestOrderCommit(db, orderId);
  const before = head(worktree);
  const base = recorded ? recorded.sha.toLowerCase() : trunkForkPoint(worktree);
  const branch = git(worktree, ["symbolic-ref", "-q", "HEAD"]).out;
  if (branch !== `refs/heads/${orderId}` || !before.startsWith(base)) {
    throw fail("builder_committed", { branch: branch || null, head: before, orderId, base });
  }

  const nested = nestedRefusal(worktree, null);
  if (nested) throw nested;
  const trunk = trunkRef(worktree);
  const commentGate = commentGateFor(worktree, trunk, env);
  const checked = stagedTree(worktree);
  const attributes = commentGate.state === "armed" ? changedAttributes(worktree, trunk) : null;
  if (attributes) return { refused: attributes };
  const comments =
    commentGate.state === "armed" ? addedComments(worktree, commentGate.label) : { unparsed: [] };
  if ("refused" in comments) return comments;
  const { unparsed } = comments;
  refuseUntouchedTests(worktree, turn.tests, options.proofRequired);
  const sandboxedCheck = () =>
    runSandboxedCheck({
      worktree,
      command: declared.commandLine,
      canary: join(dataDir(env), `check-canary-${randomUUID()}`),
      sandbox: options.checkSandbox ?? CHECK_SANDBOX,
      env: env.PATH === undefined ? {} : { PATH: env.PATH },
    });
  const changed = !git(worktree, ["diff", "--cached", "--quiet"]).ok;
  if (!changed)
    return recordUnchangedTurn({ ...options, before, recorded: recorded !== null, check: sandboxedCheck });

  const commit = git(
    worktree,
    [...UNSIGNED, "-c", `core.hooksPath=${hooksOutsideTree(worktree)}`, "commit", "-q", "-F", "-"],
    {
      env: { ...factoryCommitEnv(), DIM_SKIP_CHECK: "1" },
      stdin: `${turn.subject}\n`,
    },
  );
  if (!commit.ok) {
    git(worktree, ["reset", "-q"]);
    return { refused: fail("commit_refused", { stderr: commit.err || commit.out }) };
  }
  let proof: OrderProof | null = null;
  const refuse = (refusal: CodedError): CodedError => {
    if (proof) recordOrderProof(db, orderId, proof, before);
    return refusal;
  };
  try {
    const proved =
      turn.tests.length === 0
        ? null
        : proveTests({ worktree, tests: turn.tests, base: before, check: sandboxedCheck });
    proof = proved && { ...checkRowOf(proved.check), baseSha: before, paths: turn.tests };
    if (proved?.refusal) throw refuse(proved.refusal);
    if (proved && proved.check.exitCode === 0 && options.proofRequired) {
      throw refuse(
        fail("proof_green", {
          command: proved.check.command,
          base: before,
          tests: turn.tests,
          output: proved.check.output,
        }),
      );
    }
    const check = sandboxedCheck();
    const checkRow = checkRowOf(check);
    if (check.exitCode !== 0) {
      const checkId = recordOrderCheck(db, orderId, checkRow, before);
      throw refuse(fail("check_failed", { command: check.command, exitCode: check.exitCode, checkId }));
    }
    const drifted = checkedTreeRefusal(worktree, checked, check.command, null);
    if (drifted) throw refuse(drifted);
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
      if (proof) recordOrderProof(db, orderId, proof, sha);
      answerOrderFindings(db, orderId, options.runId, turn.answers, builder);
      if (options.finalSlice) recordOrderBuild(db, orderId, turn.artifact, sha, builder);
    });
    for (const path of unparsed) writeTrace(db, { event: "order.file_unparsed", orderId, path });
    return { sha };
  } catch (error) {
    undoCommit(worktree, before, error);
    throw error;
  }
}

export function undoInterruptedJudgement(db: Database, orderId: string, worktree: string): string | null {
  const recorded = latestOrderCommit(db, orderId);
  const base = recorded ? recorded.sha.toLowerCase() : trunkForkPoint(worktree);
  const current = head(worktree);
  if (current === base) return null;
  const parent = git(worktree, ["rev-parse", "-q", "--verify", "HEAD^"]);
  if (!parent.ok || parent.out !== base) return null;
  undoCommit(worktree, base);
  return current;
}

function undoCommit(worktree: string, before: string, cause?: unknown): void {
  const undone = git(worktree, ["reset", "-q", "--soft", before]);
  const unstaged = undone.ok ? git(worktree, ["reset", "-q"]) : undone;
  if (!unstaged.ok) {
    throw new Error(`the commit was not kept and could not be taken back to ${before}: ${unstaged.err}`, {
      cause,
    });
  }
}

function recordUnchangedTurn(options: {
  db: Database;
  orderId: string;
  runId: string;
  builder: string;
  worktree: string;
  turn: BuildTurn;
  finalSlice: boolean;
  before: string;
  recorded: boolean;
  check: () => SandboxedCheck;
}): { sha: string } {
  const { db, orderId, builder, worktree, turn, before } = options;
  if (!options.recorded) throw fail("no_change", { fixed: [] });
  const fixed = turn.answers.filter((one) => one.answer === "fixed").map((one) => one.finding);
  if (fixed.length > 0) throw fail("no_change", { fixed });
  const check = options.check();
  const checkRow = checkRowOf(check);
  if (check.exitCode !== 0) {
    const checkId = recordOrderCheck(db, orderId, checkRow, before);
    git(worktree, ["reset", "-q"]);
    throw fail("check_failed", { command: check.command, exitCode: check.exitCode, checkId });
  }
  const drifted = checkedTreeRefusal(worktree, stagedTree(worktree), check.command, null);
  if (drifted) throw drifted;
  writeTransaction(db, () => {
    recordOrderCheck(db, orderId, checkRow, before);
    answerOrderFindings(db, orderId, options.runId, turn.answers, builder);
    if (options.finalSlice) recordOrderBuild(db, orderId, turn.artifact, before, builder);
  });
  return { sha: before };
}
