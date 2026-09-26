import type { Database } from "bun:sqlite";
import { latestApprovedPlan } from "./approved-plan";
import type { Capability } from "./capabilities";
import { assertOperator } from "./factory-operator";
import {
  assertBuildReady,
  carriedThroughRewrites,
  closeOrderReview,
  currentOrderCommits,
  openAssignedOrderReview,
  type ReturnedOrderArtifact,
  raiseOrderFinding,
  recordOrderReviewArtifact,
  ruleOnOrderFinding,
} from "./factory-order";
import type { HarnessAdapter } from "./harness";
import { workerFailureReason } from "./harness-command";
import { DEFAULT_HARNESS, type HarnessName } from "./harness-name";
import { orderFindingStandings } from "./order-finding-state";
import { runOrderStation, runOrderStationLive } from "./order-worker";
import type { PlanSlice } from "./plan-artifact";
import { parseReviewReport, type ReviewFinding, type ReviewRuling } from "./review-artifact";
import { renderReviewReport } from "./review-report";
import { stationDirectory } from "./station-directory";

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

/** `raw` is stdout untouched, for reading a file's content; `out` is trimmed, for reading a sha. */
function git(dir: string, args: string[]): { ok: boolean; out: string; raw: string } {
  const run = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
  const raw = run.stdout.toString();
  return { ok: run.success, out: raw.trim(), raw };
}

/**
 * The diff a round reads is `base..head`, both recorded when it opens. A sha cannot move
 * while it is being read and a worktree can, so binding the round to shas is what makes
 * "what the reviewer saw" and "what ships" the same thing without freezing anything.
 *
 * Round one starts at the parent of the order's first commit, which is where the order's
 * own work begins. A later round starts at the previous round's head, carried through any
 * rebase that kept every patch, so it reads the answers rather than the whole order again.
 * Where a rebase retired that head otherwise, the round reads the whole order from the
 * newest rebase's base.
 */
export function reviewRange(db: Database, orderId: string, dir: string): { base: string; head: string } {
  const head = git(dir, ["rev-parse", "HEAD"]);
  if (!head.ok) throw new ReviewRefused("not_a_repo", `${dir} is not a git repo that can be read`);
  // The builder writes this worktree, so a repository nested in it can carry a config its own
  // status would obey. `dirty` still reports a submodule whose commit moved, but compares
  // that commit without running a status inside the submodule.
  if (git(dir, ["status", "--porcelain", "--ignore-submodules=dirty"]).out !== "") {
    throw new ReviewRefused(
      "worktree_dirty",
      `${dir} has uncommitted changes, and a round reads a commit: commit them or put them aside`,
    );
  }
  const current = currentOrderCommits(db, orderId);
  if (current.length === 0) {
    throw new ReviewRefused("no_commit", `order ${orderId} recorded no commit, so there is no slice to read`);
  }
  if (!current.some((row) => head.out.startsWith(row.sha))) {
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
  if (last) {
    const carried = carriedThroughRewrites(db, orderId, last.head_sha);
    if (carried && current.some((row) => carried.startsWith(row.sha)))
      return { base: carried, head: head.out };
    const rewrite = db
      .query<{ new_base: string }, [string]>(
        "SELECT new_base FROM factory_order_rewrite WHERE order_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(orderId);
    if (!rewrite) {
      throw new Error(`order ${orderId}'s last review read ${last.head_sha}, which it no longer carries`);
    }
    return { base: rewrite.new_base, head: head.out };
  }
  const first = current[0] as { sha: string };
  const parent = git(dir, ["rev-parse", `${first.sha}^`]);
  return { base: parent.ok ? parent.out : first.sha, head: head.out };
}

/** An open finding from an earlier round, as the next reviewer rules on it. */
export type EarlierFinding = {
  id: number;
  dimension: string;
  summary: string;
  file: string | null;
  line: number | null;
  failure: string | null;
  fix: string | null;
  answer: string | null;
  resolution: string | null;
  lastRuling: string | null;
  lastReason: string | null;
  ownerReason: string | null;
};

/** The open findings earlier rounds raised and the builder answered: exactly the set this round
 *  must rule on. A ruling judges an answer, so an unanswered finding waits, still open, for one. */
export function earlierOpenFindings(db: Database, orderId: string, reviewId: number): EarlierFinding[] {
  const open = orderFindingStandings(db, orderId).filter(
    (finding) => finding.state === "open" && finding.reviewId !== reviewId && finding.answer !== null,
  );
  const read = db.query<EarlierFinding, [number]>(
    `SELECT f.id, f.dimension, f.summary, f.file, f.line, f.failure, f.fix, f.answer, f.resolution,
            r.ruling AS lastRuling, r.reason AS lastReason,
            (SELECT d.reason FROM factory_order_refusal_decision d WHERE d.finding_id = f.id) AS ownerReason
     FROM factory_order_finding f
     LEFT JOIN factory_order_finding_ruling r
       ON r.id = (SELECT max(latest.id) FROM factory_order_finding_ruling latest WHERE latest.finding_id = f.id)
     WHERE f.id = ?`,
  );
  return open.map((finding) => read.get(finding.id) as EarlierFinding);
}

function earlierFindingLines(finding: EarlierFinding): string[] {
  const where =
    finding.file === null
      ? "no location recorded"
      : finding.line === null
        ? finding.file
        : `${finding.file}:${finding.line}`;
  return [
    `- Finding ${finding.id} (${finding.dimension}, ${where}): ${finding.failure ?? finding.summary}`,
    ...(finding.fix ? [`  - Fix asked for: ${finding.fix}`] : []),
    `  - Builder's answer: ${finding.answer}${finding.resolution ? `: ${finding.resolution}` : ""}`,
    ...(finding.lastRuling
      ? [`  - Last ruled ${finding.lastRuling}${finding.lastReason ? `: ${finding.lastReason}` : ""}`]
      : []),
    ...(finding.ownerReason ? [`  - The owner overturned the refusal: ${finding.ownerReason}`] : []),
  ];
}

const REPORT_CONTRACT = [
  "Return exactly one JSON object matching the output schema, with no Markdown fence and no text outside it:",
  '- "verdict": one sentence saying why the order may advance or must return.',
  '- "findings": each {dimension, file, line, failure, fix, severity}. Every finding blocks: severity is critical, high or medium, file is the repo-relative path of a file the diff changed exactly as git prints it, and line exists in that file at the head commit. A point that would not block goes in "observations" instead.',
  '- "rulings": each {finding, ruling, reason}, one for every finding listed under "Earlier findings to rule on" and none when that section is absent. ruling is addressed or not_addressed for a finding answered fixed or a refusal the owner overturned, and refusal_accepted or refusal_contested for a refusal that still stands; not_addressed and refusal_contested give a reason.',
  '- "conformance": each {kind: missing|extra|misunderstood, slice, detail}, judged against the approved plan. A deviation that must be fixed is also a finding with dimension plan.',
  '- "coverage": exactly one {dimension, status, reason} per dimension (plan, correctness, tests, architecture, maintainability, docs, security, performance, style). status is findings exactly when a finding carries that dimension, clean exactly when none does, or not_applicable or not_run with a reason.',
  '- "set_aside": each {item, why} left out as outside the order.',
  '- "unverified": each {claim, would_settle} you could not verify.',
  '- "observations": at most three strings, none of which blocks.',
  "Use null for a reason or slice that has nothing to say, and [] for an empty list.",
];

/** The order's own words and its approved plan, so the reviewer reads the diff against what it was
 *  for. Withheld: the builder's account of what it did, which is the conclusion a reviewer
 *  handed one tends to agree with. */
export function reviewerBrief(
  order: { id: string; title: string; description: string | null },
  range: { base: string; head: string },
  context: { plan: { body: string; slices: readonly PlanSlice[] } | null; earlier: EarlierFinding[] },
  revision?: { body: string; feedback: string },
): string {
  const header = [
    `You are the reviewer for factory order ${order.id} in this repository.`,
    "",
    `# ${order.title}`,
    order.description ?? "",
    "",
  ];
  if (revision) {
    return [
      ...header,
      "The owner returned this Review artifact for revision. The factory renders the artifact from your report and from the findings and rulings this round already recorded, so those stay as they are; address only the owner's feedback.",
      "Use dim-artifact for the shared artifact-writing and sizing contract.",
      "",
      "# Previous Review artifact",
      revision.body,
      "",
      "# Owner feedback",
      revision.feedback,
      "",
      ...REPORT_CONTRACT,
      'Return "findings" and "rulings" empty; only a round that raised nothing is returned for revision, so no coverage entry reports findings.',
      "Do not edit the repository.",
    ].join("\n");
  }
  return [
    ...header,
    "# Approved plan",
    // An order built by hand reaches review with no plan the factory approved; it is judged
    // against its own words instead, which the plan dimension then says.
    context.plan?.body ??
      "No approved plan is recorded for this order. Judge the diff against the order's own words, and report the plan dimension as not_applicable with that reason.",
    ...(context.plan && context.plan.slices.length > 0
      ? [
          "",
          "# Plan slices",
          ...context.plan.slices.map((slice, index) => `${index + 1}. ${slice.title}: ${slice.outcome}`),
        ]
      : []),
    "",
    ...(context.earlier.length > 0
      ? [
          "# Earlier findings to rule on",
          "Rule on each of these against the new diff.",
          ...context.earlier.flatMap(earlierFindingLines),
          "",
        ]
      : []),
    `Read the diff \`git diff ${range.base}..${range.head}\` and nothing else about how it came to be.`,
    "Judge it against the approved plan: name work that is missing, extra, or misunderstood.",
    "Check each claim at its source before raising it; a reading you did not verify is not a finding.",
    "",
    "Use dim-station-review and dim-artifact.",
    "",
    ...REPORT_CONTRACT,
    "",
    "Raising nothing is the expected result and the right one when the diff is sound.",
    "Do not edit the repository.",
  ].join("\n");
}

type ReturnedReview = Extract<ReturnedOrderArtifact, { station: "review" }>;

type ReviewedRound = { id: number; base: string; head: string; dir: string };

/** A returned artifact revises the round it came from; otherwise a new round opens over the range. */
function openRound(
  db: Database,
  orderId: string,
  dir: string,
  assignmentId: string,
  worker: string,
  returned: ReturnedReview | null,
): ReviewedRound {
  if (returned) return { id: returned.reviewId, base: returned.baseSha, head: returned.headSha, dir };
  const range = reviewRange(db, orderId, dir);
  const round = openAssignedOrderReview(
    db,
    orderId,
    { assignmentId, baseSha: range.base, headSha: range.head },
    worker,
  );
  return { id: round.id, ...range, dir };
}

function reviewerRequest(
  db: Database,
  order: { id: string; title: string; description: string | null },
  round: ReviewedRound,
  returned: ReturnedReview | null,
) {
  return {
    cwd: round.dir,
    brief: reviewerBrief(
      order,
      round,
      { plan: latestApprovedPlan(db, order.id), earlier: earlierOpenFindings(db, order.id, round.id) },
      returned ? { body: returned.body, feedback: returned.reason } : undefined,
    ),
    capabilities: REVIEWER_CAPABILITIES,
    outputSchema: REVIEW_OUTPUT_SCHEMA,
  };
}

export type ReviewOutcome = {
  review: number;
  reviewer: string;
  findings: number;
  outcome: "closed" | "aborted";
};

/** A finding points at a line of the diff it read, so the file must be one the round changed and
 *  the line one that file has at the head the round read. */
function assertLocations(findings: ReviewFinding[], round: ReviewedRound): void {
  if (findings.length === 0) return;
  // -z keeps a path byte for byte, where the default quotes one holding anything but ASCII.
  const diff = git(round.dir, ["diff", "--name-only", "-z", `${round.base}..${round.head}`]);
  if (!diff.ok) throw new Error(`could not list the files ${round.base}..${round.head} changes`);
  const changed = new Set(diff.raw.split("\0"));
  findings.forEach((finding, index) => {
    const what = `reviewer finding ${index + 1}`;
    if (!changed.has(finding.file)) {
      throw new Error(
        `${what} names file ${finding.file}, which ${round.base}..${round.head} does not change`,
      );
    }
    const shown = git(round.dir, ["show", `${round.head}:${finding.file}`]);
    // A finding names a line the reader can open at head, so a file the diff deleted has none.
    if (!shown.ok) {
      throw new Error(`${what} names file ${finding.file}, which does not exist at ${round.head}`);
    }
    const text = shown.raw;
    const lines = text.split("\n").length - (text === "" || text.endsWith("\n") ? 1 : 0);
    if (finding.line > lines) {
      throw new Error(
        `${what} names line ${finding.line} of ${finding.file}, which has ${lines} lines at ${round.head}`,
      );
    }
  });
}

function assertRulingSet(rulings: ReviewRuling[], earlier: EarlierFinding[]): void {
  const expected = new Set(earlier.map((finding) => finding.id));
  for (const ruling of rulings) {
    if (!expected.has(ruling.finding)) {
      throw new Error(
        `reviewer ruling names finding ${ruling.finding}, which is not an open earlier finding`,
      );
    }
  }
  const ruled = new Set(rulings.map((ruling) => ruling.finding));
  for (const id of expected) {
    if (!ruled.has(id)) throw new Error(`reviewer rulings leave open earlier finding ${id} without a ruling`);
  }
}

function recordReviewResult(
  db: Database,
  orderId: string,
  reviewer: string,
  raw: string,
  round: ReviewedRound,
  returned: boolean,
): number {
  const report = parseReviewReport(raw);
  if (returned && (report.findings.length > 0 || report.rulings.length > 0)) {
    throw new Error("a returned Review artifact cannot change its findings or rulings");
  }
  if (!returned) {
    assertLocations(report.findings, round);
    assertRulingSet(report.rulings, earlierOpenFindings(db, orderId, round.id));
  }
  return db.transaction(() => {
    for (const finding of report.findings) {
      raiseOrderFinding(db, orderId, { ...finding, summary: finding.failure }, reviewer);
    }
    for (const ruling of report.rulings) {
      ruleOnOrderFinding(
        db,
        ruling.finding,
        { ruling: ruling.ruling, reason: ruling.reason ?? undefined },
        reviewer,
      );
    }
    recordOrderReviewArtifact(db, orderId, renderReviewReport(db, round.id, report), reviewer);
    return report.findings.length;
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
  const dir = stationDirectory(options.dir, orderId);
  const harness = options.harness ?? DEFAULT_HARNESS;
  let returned: ReturnedReview | null = null;
  let opened: ReviewedRound | undefined;
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
        opened = openRound(db, orderId, dir, assigned.assignment.id, worker, artifact);
        return reviewerRequest(db, order, opened, artifact);
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
    findings = recordReviewResult(db, orderId, reviewer, turn.run.output, opened, Boolean(returned));
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
  const dir = stationDirectory(options.dir, orderId);
  const harness = options.harness ?? DEFAULT_HARNESS;
  let opened: ReviewedRound | undefined;
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
      opened = openRound(db, orderId, dir, orderWorker.assignment.id, worker, artifact);
      return reviewerRequest(db, order, opened, artifact);
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
    findings = recordReviewResult(db, orderId, reviewer, run.output, opened, Boolean(returned));
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    if (!returned) closeOrderReview(db, opened.id, "aborted", worker, undefined, failure);
    throw error;
  }
  if (!returned) closeOrderReview(db, opened.id, outcome, worker);
  return { review: opened.id, reviewer, findings, outcome };
}
