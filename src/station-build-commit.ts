import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CHECK_SANDBOX, runSandboxedCheck, type SandboxedCheck } from "./check-sandbox";
import { stagedComments } from "./comments-staged";
import { writeTransaction } from "./db";
import { commentGateFor } from "./gate-commit";
import { repoIdentityEnv } from "./git-identity";
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
import { answerOrderFindings, assertFindingAnswersOwed, BuildTurnRefused } from "./order-finding";
import { dataDir, type Env } from "./paths";
import { rebaseInProgress } from "./ship-rebase";
import { proveTests } from "./station-build-proof";
import { checkedTreeRefusal, git, hooksOutsideTree, nestedRefusal, stagedTree } from "./station-build-tree";
import type { BuildTurn } from "./station-build-turn";
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

  const nested = nestedRefusal(worktree);
  if (nested) throw new BuildTurnRefused(nested.code, nested.message);
  const trunk = trunkRef(worktree);
  const commentGate = commentGateFor(worktree, trunk, env);
  const checked = stagedTree(worktree);
  if (commentGate.state === "armed") refuseChangedAttributes(worktree, trunk);
  const { unparsed } =
    commentGate.state === "armed" ? refuseAddedComments(worktree, commentGate.label) : { unparsed: [] };
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
  let proof: OrderProof | null = null;
  const refuse = (code: BuildTurnRefused["code"], message: string): BuildTurnRefused => {
    if (proof) recordOrderProof(db, orderId, proof, before);
    return new BuildTurnRefused(code, message);
  };
  try {
    const proved =
      turn.tests.length === 0 ? null : proveTests({ worktree, tests: turn.tests, check: sandboxedCheck });
    proof = proved && { ...checkRowOf(proved.check), baseSha: before, paths: turn.tests };
    if (proved?.refusal) {
      throw refuse(
        proved.refusal.code,
        `the proof of ${turn.tests.join(", ")} at ${before} was refused: ${proved.refusal.message}`,
      );
    }
    if (proved && proved.check.exitCode === 0 && options.proofRequired) {
      throw refuse(
        "proof_green",
        [
          `${proved.check.command} passed at ${before} with only ${turn.tests.join(", ")} laid over it, so the named tests do not fail without the fix:`,
          proved.check.output,
        ].join("\n"),
      );
    }
    const check = sandboxedCheck();
    const checkRow = checkRowOf(check);
    if (check.exitCode !== 0) {
      const checkId = recordOrderCheck(db, orderId, checkRow, before);
      throw refuse(
        "check_failed",
        `${check.command} exited ${check.exitCode} in the check sandbox; its output is on check ${checkId}`,
      );
    }
    const drifted = checkedTreeRefusal(worktree, checked, check.command);
    if (drifted) throw refuse(drifted.code, drifted.message);
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
  if (!options.recorded)
    throw new BuildTurnRefused("no_change", "the turn left no change in the worktree to commit");
  const fixed = turn.answers.filter((one) => one.answer === "fixed").map((one) => one.finding);
  if (fixed.length > 0) {
    throw new BuildTurnRefused(
      "no_change",
      `the turn answers finding ${fixed.join(", ")} fixed and left no change in the worktree; refuse a finding that needs no change, with the reason`,
    );
  }
  const check = options.check();
  const checkRow = checkRowOf(check);
  if (check.exitCode !== 0) {
    const checkId = recordOrderCheck(db, orderId, checkRow, before);
    git(worktree, ["reset", "-q"]);
    throw new BuildTurnRefused(
      "check_failed",
      `${check.command} exited ${check.exitCode} in the check sandbox; its output is on check ${checkId}`,
    );
  }
  const drifted = checkedTreeRefusal(worktree, stagedTree(worktree), check.command);
  if (drifted) throw new BuildTurnRefused(drifted.code, drifted.message);
  writeTransaction(db, () => {
    recordOrderCheck(db, orderId, checkRow, before);
    answerOrderFindings(db, orderId, options.runId, turn.answers, builder);
    if (options.finalSlice) recordOrderBuild(db, orderId, turn.artifact, before, builder);
  });
  return { sha: before };
}
