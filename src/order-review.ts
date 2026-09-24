import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import type { Capability } from "./capabilities";
import { assertOperator } from "./factory-operator";
import {
  assertBuildReady,
  closeOrderReview,
  openAssignedOrderReview,
  type ReturnedOrderArtifact,
  raiseOrderFinding,
  recordOrderReviewArtifact,
} from "./factory-order";
import type { HarnessAdapter } from "./harness";
import { workerFailureReason } from "./harness-command";
import type { HarnessName } from "./harness-name";
import { runOrderStation, runOrderStationLive } from "./order-worker";
import { parseReviewArtifact } from "./review-artifact";
import { repoRoot, worktreePath } from "./wt-command";

export class ReviewRefused extends Error {
  constructor(
    readonly code: "not_a_repo" | "worktree_dirty" | "head_unrecorded" | "no_commit",
    message: string,
  ) {
    super(message);
  }
}

/** Reviewers inspect commits and return structured evidence for the factory to record. */
export const REVIEWER_CAPABILITIES: Capability[] = [
  "bootstrap-worker",
  "read-files",
  "read-history",
  "ask-dim",
];

const REVIEW_OUTPUT_SCHEMA = `${import.meta.dir}/review-artifact.schema.json`;

/** Replaced in tests, which have no model to call and need the exit code to be theirs. */
export type ReviewerSpawn = (
  argv: string[],
  env: Record<string, string>,
) => { exitCode: number; output: string };

function git(dir: string, args: string[]): { ok: boolean; out: string } {
  const run = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
  return { ok: run.success, out: run.stdout.toString().trim() };
}

function reviewDirectory(dir: string, orderId: string): string {
  const root = repoRoot(dir);
  const current = git(dir, ["rev-parse", "--show-toplevel"]);
  if (current.ok && resolve(current.out) === resolve(root)) return worktreePath(root, orderId);
  return dir;
}

/**
 * The diff a round reads is `base..head`, both recorded when it opens. A sha cannot move
 * while it is being read and a worktree can, so binding the round to shas is what makes
 * "what the reviewer saw" and "what ships" the same thing without freezing anything.
 *
 * Round one starts at the parent of the order's first commit, which is where the order's
 * own work begins. A later round starts at the previous round's head, so it reads the
 * answers rather than the whole order again.
 */
export function reviewRange(db: Database, orderId: string, dir: string): { base: string; head: string } {
  const head = git(dir, ["rev-parse", "HEAD"]);
  if (!head.ok) throw new ReviewRefused("not_a_repo", `${dir} is not a git repo that can be read`);
  if (git(dir, ["status", "--porcelain"]).out !== "") {
    throw new ReviewRefused(
      "worktree_dirty",
      `${dir} has uncommitted changes, and a round reads a commit: commit them or put them aside`,
    );
  }
  const recorded = db
    .query<{ sha: string }, [string, string]>(
      "SELECT sha FROM factory_order_commit WHERE order_id = ? AND sha = ?",
    )
    .get(orderId, head.out);
  const short = db
    .query<{ sha: string }, [string]>(
      "SELECT sha FROM factory_order_commit WHERE order_id = ? ORDER BY recorded_at, rowid",
    )
    .all(orderId);
  if (short.length === 0) {
    throw new ReviewRefused("no_commit", `order ${orderId} recorded no commit, so there is no slice to read`);
  }
  if (!recorded && !short.some((row) => head.out.startsWith(row.sha))) {
    throw new ReviewRefused(
      "head_unrecorded",
      `${head.out} is not a commit order ${orderId} recorded: record it with \`dim order commit\` first`,
    );
  }
  const last = db
    .query<{ head_sha: string }, [string]>(
      "SELECT head_sha FROM factory_order_review WHERE order_id = ? ORDER BY round DESC LIMIT 1",
    )
    .get(orderId);
  if (last) return { base: last.head_sha, head: head.out };
  const first = short[0] as { sha: string };
  const parent = git(dir, ["rev-parse", `${first.sha}^`]);
  return { base: parent.ok ? parent.out : first.sha, head: head.out };
}

/** The order's own words and its plan, so the reviewer reads the diff against what it was
 *  for. Withheld: the builder's account of what it did, which is the conclusion a reviewer
 *  handed one tends to agree with. */
export function reviewerBrief(
  order: { id: string; title: string; description: string | null },
  range: { base: string; head: string },
  revision?: { body: string; feedback: string },
): string {
  if (revision) {
    return [
      `You are the reviewer for factory order ${order.id} in this repository.`,
      "",
      `# ${order.title}`,
      order.description ?? "",
      "",
      "The owner returned this Review artifact for revision. Preserve the review's findings and evidence; address only the owner's feedback.",
      "",
      "# Previous Review artifact",
      revision.body,
      "",
      "# Owner feedback",
      revision.feedback,
      "",
      "Return one JSON object with a revised Markdown body and an empty findings array.",
      "Do not edit the repository or change the findings during an artifact revision.",
    ].join("\n");
  }
  return [
    `You are the reviewer for factory order ${order.id} in this repository.`,
    "",
    `# ${order.title}`,
    order.description ?? "",
    "",
    `Read the diff \`git diff ${range.base}..${range.head}\` and nothing else about how it came to be.`,
    "Check each claim at its source before raising it; a reading you did not verify is not a finding.",
    "",
    "Write one Review artifact for the owner with the verdict, dimensions covered, evidence considered, and whether the order may advance or must return. Keep it proportional to the change.",
    'Return exactly one JSON object with a non-empty Markdown "body" and a "findings" array. Each finding has non-empty "dimension" and "summary" strings. Use an empty array when there are no findings. Do not use a Markdown fence or add text outside the JSON object.',
    "",
    "Raising nothing is the expected result and the right one when the diff is sound.",
    "Do not edit the repository.",
  ].join("\n");
}

export type ReviewOutcome = {
  review: number;
  reviewer: string;
  findings: number;
  outcome: "closed" | "aborted";
};

function recordReviewResult(
  db: Database,
  orderId: string,
  reviewer: string,
  raw: string,
  returned: boolean,
): number {
  const artifact = parseReviewArtifact(raw);
  if (returned && artifact.findings.length > 0) {
    throw new Error("a returned Review artifact cannot change its findings");
  }
  return db.transaction(() => {
    for (const finding of artifact.findings) {
      raiseOrderFinding(db, orderId, finding, reviewer);
    }
    recordOrderReviewArtifact(db, orderId, artifact.body, reviewer);
    return artifact.findings.length;
  })();
}

export async function runOrderReviewLive(
  db: Database,
  orderId: string,
  worker: string,
  options: {
    dir: string;
    env?: Record<string, string | undefined>;
    harness?: HarnessName;
    adapter?: HarnessAdapter;
  },
): Promise<ReviewOutcome> {
  const order = db
    .query<{ id: string; title: string; description: string | null }, [string]>(
      "SELECT id, title, description FROM factory_order WHERE id = ?",
    )
    .get(orderId);
  if (!order) throw new Error(`order not found: ${orderId}`);
  assertOperator(db, worker, "delegate review");
  assertBuildReady(db, orderId);
  const dir = reviewDirectory(options.dir, orderId);
  const harness = options.harness ?? "codex";
  let returned: Extract<ReturnedOrderArtifact, { station: "review" }> | null = null;
  let opened: { id: number } | undefined;
  let turn: Awaited<ReturnType<typeof runOrderStationLive<"review">>>;
  try {
    turn = await runOrderStationLive({
      db,
      orderId,
      station: "review",
      parentWorker: worker,
      harness,
      env: options.env,
      adapter: options.adapter,
      onPrepared: (_assigned, artifact) => {
        returned = artifact;
      },
      request: ({ orderWorker: assigned, returned: artifact }) => {
        const range = artifact
          ? { base: artifact.baseSha, head: artifact.headSha }
          : reviewRange(db, orderId, dir);
        opened = artifact
          ? { id: artifact.reviewId }
          : openAssignedOrderReview(
              db,
              orderId,
              { assignmentId: assigned.assignment.id, baseSha: range.base, headSha: range.head },
              worker,
            );
        return {
          cwd: dir,
          brief: reviewerBrief(
            order,
            range,
            artifact ? { body: artifact.body, feedback: artifact.reason } : undefined,
          ),
          capabilities: REVIEWER_CAPABILITIES,
          outputSchema: REVIEW_OUTPUT_SCHEMA,
        };
      },
    });
  } catch (error) {
    if (!returned && opened) {
      const reason = workerFailureReason(
        "reviewer did not finish reviewing",
        error instanceof Error ? error.message : String(error),
        undefined,
      );
      try {
        closeOrderReview(db, opened.id, "aborted", worker, undefined, reason);
      } catch {
        throw error;
      }
    }
    throw error;
  }
  returned = turn.returned;
  if (!opened) throw new Error("review round was not opened");
  const reviewer = turn.worker;
  if (!reviewer) {
    if (!returned) closeOrderReview(db, opened.id, "aborted", worker);
    throw new Error("reviewer did not bootstrap its worker assignment");
  }
  db.run("UPDATE factory_order_review SET reviewer = ? WHERE id = ?", [reviewer, opened.id]);
  const outcome = turn.run.exitCode === 0 ? "closed" : "aborted";
  const reason =
    outcome === "aborted"
      ? workerFailureReason("reviewer did not finish reviewing", turn.run.output, turn.run.failureReason)
      : undefined;
  if (outcome === "aborted") {
    if (returned) throw new Error(reason);
    closeOrderReview(db, opened.id, outcome, worker, undefined, reason);
    return { review: opened.id, reviewer, findings: 0, outcome };
  }
  let findings: number;
  try {
    findings = recordReviewResult(db, orderId, reviewer, turn.run.output, Boolean(returned));
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    if (!returned) closeOrderReview(db, opened.id, "aborted", worker, undefined, failure);
    throw error;
  }
  if (!returned) closeOrderReview(db, opened.id, outcome, worker, undefined, reason);
  return { review: opened.id, reviewer, findings, outcome };
}

/**
 * Assigns the reviewer, spawns it and closes the round from its exit code. The operator that
 * invokes this never holds the reviewer's token and never writes its brief, which is what
 * makes the finding evidence rather than the builder's own account of itself.
 */
export function runOrderReview(
  db: Database,
  orderId: string,
  worker: string,
  options: {
    dir: string;
    spawn?: ReviewerSpawn;
    env?: Record<string, string | undefined>;
    harness?: HarnessName;
  } = {
    dir: process.cwd(),
  },
): ReviewOutcome {
  const order = db
    .query<{ id: string; title: string; description: string | null }, [string]>(
      "SELECT id, title, description FROM factory_order WHERE id = ?",
    )
    .get(orderId);
  if (!order) throw new Error(`order not found: ${orderId}`);
  assertBuildReady(db, orderId);
  const dir = reviewDirectory(options.dir, orderId);
  const harness = options.harness ?? "codex";
  let opened: { id: number } | undefined;
  const {
    run,
    worker: reviewer,
    returned,
  } = runOrderStation({
    db,
    orderId,
    station: "review",
    parentWorker: worker,
    harness,
    env: options.env,
    spawn: options.spawn,
    request: ({ orderWorker, returned: artifact }) => {
      const range = artifact
        ? { base: artifact.baseSha, head: artifact.headSha }
        : reviewRange(db, orderId, dir);
      opened = artifact
        ? { id: artifact.reviewId }
        : openAssignedOrderReview(
            db,
            orderId,
            { assignmentId: orderWorker.assignment.id, baseSha: range.base, headSha: range.head },
            worker,
          );
      return {
        cwd: dir,
        brief: reviewerBrief(
          order,
          range,
          artifact ? { body: artifact.body, feedback: artifact.reason } : undefined,
        ),
        capabilities: REVIEWER_CAPABILITIES,
        outputSchema: REVIEW_OUTPUT_SCHEMA,
      };
    },
  });
  if (!opened) throw new Error("review round was not opened");
  if (!reviewer) {
    if (!returned) closeOrderReview(db, opened.id, "aborted", worker);
    throw new Error("reviewer did not bootstrap its worker assignment");
  }
  db.run("UPDATE factory_order_review SET reviewer = ? WHERE id = ?", [reviewer, opened.id]);
  const outcome = run.exitCode === 0 ? "closed" : "aborted";
  if (outcome === "aborted") {
    if (returned) throw new Error(`${reviewer} did not finish reviewing`);
    closeOrderReview(db, opened.id, outcome, worker);
    return { review: opened.id, reviewer, findings: 0, outcome };
  }
  let findings: number;
  try {
    findings = recordReviewResult(db, orderId, reviewer, run.output, Boolean(returned));
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    if (!returned) closeOrderReview(db, opened.id, "aborted", worker, undefined, failure);
    throw error;
  }
  if (!returned) closeOrderReview(db, opened.id, outcome, worker);
  return { review: opened.id, reviewer, findings, outcome };
}
