import type { Database } from "bun:sqlite";
import type { Capability } from "./capabilities";
import { assertOperator } from "./factory-operator";
import { assertBuildApproved, closeOrderReview, openAssignedOrderReview } from "./factory-order";
import { endWorker } from "./factory-worker";
import {
  harnessArgv,
  runHarnessCommand,
  runHarnessCommandLive,
  workerFailureReason,
} from "./harness-command";
import type { HarnessName } from "./harness-name";
import { route } from "./routing";
import { assignedWorker, assignmentProcessEnv, assignWorker, bootstrapWorker } from "./worker-assignment";

export class ReviewRefused extends Error {
  constructor(
    readonly code: "not_a_repo" | "worktree_dirty" | "head_unrecorded" | "no_commit",
    message: string,
  ) {
    super(message);
  }
}

/**
 * What the reviewer may reach. The capability set is the boundary rather than the brief: an
 * instruction not to edit is a sentence the model may weigh against others, and a capability
 * it was never granted is not reachable however it reasons. `raise-finding` is the one
 * write, and the round refuses even that from any hand but this one.
 */
export const REVIEWER_CAPABILITIES: Capability[] = [
  "bootstrap-worker",
  "read-files",
  "read-history",
  "ask-dim",
  "raise-finding",
];

/** Replaced in tests, which have no model to call and need the exit code to be theirs. */
export type ReviewerSpawn = (argv: string[], env: Record<string, string>) => { exitCode: number };

function git(dir: string, args: string[]): { ok: boolean; out: string } {
  const run = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
  return { ok: run.success, out: run.stdout.toString().trim() };
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
): string {
  return [
    `You are the reviewer for factory order ${order.id} in this repository.`,
    "",
    `# ${order.title}`,
    order.description ?? "",
    "",
    `Read the diff \`git diff ${range.base}..${range.head}\` and nothing else about how it came to be.`,
    "Check each claim at its source before raising it; a reading you did not verify is not a finding.",
    "",
    "Raise each one with:",
    `  dim order finding ${order.id} --dimension <name> --summary "..."`,
    "",
    "Raising nothing is the expected result and the right one when the diff is sound.",
    "Do not edit anything. You have no tools that could.",
  ].join("\n");
}

export type ReviewOutcome = {
  review: number;
  reviewer: string;
  findings: number;
  outcome: "closed" | "aborted";
};

export async function runOrderReviewLive(
  db: Database,
  orderId: string,
  worker: string,
  options: { dir: string; env?: Record<string, string | undefined>; harness?: HarnessName },
): Promise<ReviewOutcome> {
  const order = db
    .query<{ id: string; title: string; description: string | null }, [string]>(
      "SELECT id, title, description FROM factory_order WHERE id = ?",
    )
    .get(orderId);
  if (!order) throw new Error(`order not found: ${orderId}`);
  assertOperator(db, worker, "delegate review");
  assertBuildApproved(db, orderId);
  const range = reviewRange(db, orderId, options.dir);
  const assignment = assignWorker(db, { role: "reviewer", parentWorker: worker });
  const opened = openAssignedOrderReview(
    db,
    orderId,
    { assignmentId: assignment.id, baseSha: range.base, headSha: range.head },
    worker,
  );
  const env = assignmentProcessEnv(options.env, assignment);
  const harness = options.harness ?? "codex";
  const { model } = route("reviewer", harness, options.env);
  const run = await runHarnessCommandLive(
    {
      harness,
      cwd: options.dir,
      brief: reviewerBrief(order, range),
      model,
      capabilities: REVIEWER_CAPABILITIES,
      env,
    },
    (providerSessionId) => {
      bootstrapWorker(db, { id: assignment.id, token: assignment.token, sessionId: providerSessionId });
    },
  );
  const reviewer = assignedWorker(db, assignment.id);
  if (!reviewer) {
    closeOrderReview(db, opened.id, "aborted", worker);
    throw new Error("reviewer did not bootstrap its worker assignment");
  }
  db.run("UPDATE factory_order_review SET reviewer = ? WHERE id = ?", [reviewer, opened.id]);
  const outcome = run.exitCode === 0 ? "closed" : "aborted";
  const reason =
    outcome === "aborted"
      ? workerFailureReason("reviewer did not finish reviewing", run.output, run.failureReason)
      : undefined;
  closeOrderReview(db, opened.id, outcome, worker, undefined, reason);
  const raised = (db
    .query<{ n: number }, [number]>("SELECT count(*) AS n FROM factory_order_finding WHERE review_id = ?")
    .get(opened.id)?.n ?? 0) as number;
  endWorker(db, reviewer);
  return { review: opened.id, reviewer, findings: raised, outcome };
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
  assertOperator(db, worker, "delegate review");
  assertBuildApproved(db, orderId);
  const range = reviewRange(db, orderId, options.dir);
  const assignment = assignWorker(db, { role: "reviewer", parentWorker: worker });
  const opened = openAssignedOrderReview(
    db,
    orderId,
    { assignmentId: assignment.id, baseSha: range.base, headSha: range.head },
    worker,
  );
  const env = assignmentProcessEnv(options.env, assignment);
  const harness = options.harness ?? "codex";
  const { model } = route("reviewer", harness, options.env);
  const request = {
    harness,
    cwd: options.dir,
    brief: reviewerBrief(order, range),
    model,
    capabilities: REVIEWER_CAPABILITIES,
    env,
  };
  const run = options.spawn ? options.spawn(harnessArgv(request), env) : runHarnessCommand(request);
  const reviewer = assignedWorker(db, assignment.id);
  if (!reviewer) {
    closeOrderReview(db, opened.id, "aborted", worker);
    throw new Error("reviewer did not bootstrap its worker assignment");
  }
  db.run("UPDATE factory_order_review SET reviewer = ? WHERE id = ?", [reviewer, opened.id]);
  const outcome = run.exitCode === 0 ? "closed" : "aborted";
  closeOrderReview(db, opened.id, outcome, worker);
  const raised = (db
    .query<{ n: number }, [number]>("SELECT count(*) AS n FROM factory_order_finding WHERE review_id = ?")
    .get(opened.id)?.n ?? 0) as number;
  return { review: opened.id, reviewer, findings: raised, outcome };
}
