import type { Database } from "bun:sqlite";
import { FactoryStopError, liveStop } from "./factory-stop";
import { withLock } from "./lock";
import type { Env } from "./paths";
import { type ShipOutcome, shipToTrunk } from "./ship";
import { reachesTrunk } from "./trunk";
import type { WorkerHookReport } from "./worker-environment";

/** What state the order is in. A claim takes it straight to `working`: an order
 *  already exists before a worker sees it, so taking one and starting it are one act. */
export const ORDER_STATUSES = ["queued", "working", "completed"] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type OrderEventKind =
  | "queued"
  | "claimed"
  | "moved"
  | "commit_created"
  | "check_finished"
  | "review_finished"
  | "completed"
  | "failed";

export const ORDER_PRIORITIES = ["urgent", "high", "medium", "low", "unset"] as const;
export type OrderPriority = (typeof ORDER_PRIORITIES)[number];

/** What is written down before anyone takes it. The branch and the worktree are
 *  derived from the id, so neither is stored. */
export type Order = {
  id: string;
  project: string;
  title: string;
  description?: string;
  priority?: OrderPriority;
  hold?: string;
};

/** What the operator knows only once it has a worker to hand the order to. Who that
 *  worker is comes from the environment it was started in, never from the claim. */
export type OrderClaim = {
  runId: string;
  sessionId?: string;
  station?: string;
};

export type OrderEvent = {
  kind: OrderEventKind;
  /** Required, because a moment nobody did is not a moment this record can hold. */
  worker: string;
  sessionId?: string;
  station?: string;
  commitSha?: string;
  checkId?: number;
  findingId?: number;
  holdType?: string;
  status?: OrderStatus;
  reason?: string;
  ts?: string;
};

export type OrderNotDoneCode = "order_not_checked" | "order_not_integrated" | "order_trunk_unknown";

/** Carries a code because a caller deciding which condition failed must not match on prose. */
export class OrderNotDone extends Error {
  constructor(
    readonly code: OrderNotDoneCode,
    message: string,
  ) {
    super(message);
  }
}

const now = (): string => new Date().toISOString();
/** Only `completed` ends an order. Work that stopped without landing goes back to
 *  `queued`, because it is work nobody is holding. */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = ["completed"];
const terminalStatuses = new Set<OrderStatus>(TERMINAL_ORDER_STATUSES);

/** A refusal is read by whoever typed the command, so it names the act and not the event kind. */
const VERB_FOR_KIND: Record<string, string> = { completed: "complete", moved: "move" };

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return terminalStatuses.has(status);
}

function eventValues(orderId: string, event: OrderEvent, ts: string): (string | number | null)[] {
  return [
    orderId,
    ts,
    event.kind,
    event.worker,
    event.sessionId ?? null,
    event.station ?? null,
    event.commitSha ?? null,
    event.checkId ?? null,
    event.findingId ?? null,
    event.holdType ?? null,
    event.status ?? null,
    event.reason ?? null,
  ];
}

export function queueOrder(db: Database, order: Order, worker: string, at = now()): number {
  return db.transaction(() => {
    db.run(
      `INSERT INTO factory_order
       (id, project, title, description, priority, hold, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      [
        order.id,
        order.project,
        order.title,
        order.description ?? null,
        order.priority ?? "unset",
        order.hold ?? null,
        at,
        at,
      ],
    );
    return appendOrderEventInTransaction(db, order.id, { kind: "queued", worker }, at);
  })();
}

/**
 * A stopped floor finishes what it holds and takes nothing new: killing a worker
 * mid-write leaves a worktree nobody owns and a commit half made, so the refusal
 * sits here, where work enters the floor, and nowhere an order already running passes.
 */
export function claimOrder(
  db: Database,
  orderId: string,
  claim: OrderClaim,
  worker: string,
  at = now(),
): number {
  return db.transaction(() => {
    const stop = liveStop(db);
    if (stop) {
      throw new FactoryStopError(
        "floor_stopped",
        `the factory is stopped and takes no new order: ${stop.reason} ` +
          `(${stop.pulledBy}, ${stop.pulledAt}); clear it with \`dim factory clear\``,
      );
    }
    const order = db.query("SELECT status, hold FROM factory_order WHERE id = ?").get(orderId) as {
      status: OrderStatus;
      hold: string | null;
    } | null;
    if (!order) throw new Error(`order not found: ${orderId}`);
    if (order.hold) {
      throw new FactoryStopError(
        "order_held",
        `order ${orderId} is held and the owner releases it: ${order.hold}`,
      );
    }
    if (order.status !== "queued") throw new Error(`order ${orderId} is already ${order.status}`);
    db.run(
      `UPDATE factory_order SET run_id = ?, session_id = ?, station = ?,
         status = 'working', claimed_at = ?, updated_at = ? WHERE id = ?`,
      [claim.runId, claim.sessionId ?? null, claim.station ?? null, at, at, orderId],
    );
    return appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "claimed", worker, sessionId: claim.sessionId, station: claim.station },
      at,
    );
  })();
}

/**
 * The projection follows the move because that column is what a card is read by
 * (`src/factory-wall.ts` prefers it over the latest event's station), and the
 * event ledger keeps every station the order passed through.
 */
export function moveOrder(
  db: Database,
  orderId: string,
  station: string,
  worker: string,
  at = now(),
): number {
  return db.transaction(() => {
    const event = appendOrderEventInTransaction(db, orderId, { kind: "moved", worker, station }, at);
    db.run("UPDATE factory_order SET station = ? WHERE id = ?", [station, orderId]);
    return event;
  })();
}

/** Current state rather than history: nothing has wanted to read back what an order
 *  used to be ranked at, and a row that wants one is its own change. */
export function setOrderPriority(db: Database, orderId: string, priority: OrderPriority): void {
  const result = db.run("UPDATE factory_order SET priority = ?, updated_at = ? WHERE id = ?", [
    priority,
    now(),
    orderId,
  ]);
  if (result.changes !== 1) throw new Error(`order not found: ${orderId}`);
}

export function setOrderHold(db: Database, orderId: string, hold: string | null): void {
  const result = db.run("UPDATE factory_order SET hold = ?, updated_at = ? WHERE id = ?", [
    hold,
    now(),
    orderId,
  ]);
  if (result.changes !== 1) throw new Error(`order not found: ${orderId}`);
}

export function orderStatus(db: Database, orderId: string): OrderStatus {
  const order = db.query("SELECT status FROM factory_order WHERE id = ?").get(orderId) as {
    status: OrderStatus;
  } | null;
  if (!order) throw new Error(`order not found: ${orderId}`);
  return order.status;
}

/** `worktree` is where the completion gate reads git: the checkout the work was done
 *  in, which the caller knows and a stored path is free to be wrong about. */
export function appendOrderEvent(
  db: Database,
  orderId: string,
  event: OrderEvent,
  at = now(),
  worktree = process.cwd(),
): number {
  return db.transaction(() => appendOrderEventInTransaction(db, orderId, event, at, worktree))();
}

/** Returns the row it wrote, which is the id a command prints for the spool to attribute. */
function appendOrderEventInTransaction(
  db: Database,
  orderId: string,
  event: OrderEvent,
  at: string,
  worktree = process.cwd(),
): number {
  if (isTerminalOrderStatus(event.kind as OrderStatus) && event.status !== event.kind) {
    throw new Error(`terminal event kind must match its status: ${event.kind}`);
  }
  if (event.status && isTerminalOrderStatus(event.status) && event.kind !== event.status) {
    throw new Error(`terminal event status must match its kind: ${event.status}`);
  }
  const order = db.query("SELECT status FROM factory_order WHERE id = ?").get(orderId) as {
    status: OrderStatus;
  } | null;
  if (!order) throw new Error(`order not found: ${orderId}`);
  if (isTerminalOrderStatus(order.status)) {
    throw new Error(`order ${orderId} is already ${order.status}`);
  }
  if (event.kind !== "queued" && event.kind !== "claimed") {
    if (order.status !== "working") {
      const action = VERB_FOR_KIND[event.kind] ?? event.kind;
      throw new Error(`order ${orderId} must be working before it can ${action}`);
    }
    if (event.kind === "completed") {
      assertChecked(db, orderId);
      assertIntegrated(db, orderId, worktree);
    }
  }

  const written = db.run(
    `INSERT INTO factory_order_event
       (order_id, ts, kind, worker, session_id, station, commit_sha, check_id, finding_id,
        hold_type, status, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    eventValues(orderId, event, event.ts ?? at),
  );
  // A failure hands the work back rather than ending it, so the row returns to the
  // queue and the run it was claimed for is cleared with it.
  const projected = event.kind === "failed" ? "queued" : (event.status ?? null);
  db.run(
    `UPDATE factory_order SET status = coalesce(?, status), updated_at = ?,
       completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
       stop_reason = coalesce(?, stop_reason),
       run_id = CASE WHEN ? = 'failed' THEN NULL ELSE run_id END,
       claimed_at = CASE WHEN ? = 'failed' THEN NULL ELSE claimed_at END
       WHERE id = ?`,
    [
      projected,
      event.ts ?? at,
      projected,
      event.ts ?? at,
      event.reason ?? null,
      event.kind,
      event.kind,
      orderId,
    ],
  );
  return Number(written.lastInsertRowid);
}

export function recordOrderCommit(
  db: Database,
  orderId: string,
  sha: string,
  worker: string,
  subject?: string,
  at = now(),
): number {
  assertOrderWorking(db, orderId);
  return db.transaction(() => {
    db.run("INSERT INTO factory_order_commit (order_id, sha, subject, recorded_at) VALUES (?, ?, ?, ?)", [
      orderId,
      sha,
      subject ?? null,
      at,
    ]);
    return appendOrderEventInTransaction(db, orderId, { kind: "commit_created", worker, commitSha: sha }, at);
  })();
}

export type OrderFile = { path: string; added?: number; removed?: number };

export function recordOrderFile(db: Database, orderId: string, file: OrderFile, at = now()): void {
  assertOrderWorking(db, orderId);
  db.run(
    "INSERT INTO factory_order_file (order_id, path, added, removed, recorded_at) VALUES (?, ?, ?, ?, ?)",
    [orderId, file.path, file.added ?? null, file.removed ?? null, at],
  );
}

export function recordOrderCheck(
  db: Database,
  orderId: string,
  check: { command: string; exitCode: number; startedAt?: string; finishedAt?: string; result?: string },
  worker: string,
  at = now(),
): number {
  assertOrderWorking(db, orderId);
  return db.transaction(() => {
    const result = db.run(
      `INSERT INTO factory_order_check (order_id, command, exit_code, started_at, finished_at, result, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        check.command,
        check.exitCode,
        check.startedAt ?? null,
        check.finishedAt ?? at,
        check.result ?? null,
        at,
      ],
    );
    const id = Number(result.lastInsertRowid);
    return appendOrderEventInTransaction(db, orderId, { kind: "check_finished", worker, checkId: id }, at);
  })();
}

export function recordOrderFinding(
  db: Database,
  orderId: string,
  finding: { dimension: string; summary: string; answer: "fixed" | "refused"; resolution?: string },
  worker: string,
  at = now(),
): number {
  assertOrderWorking(db, orderId);
  return db.transaction(() => {
    const result = db.run(
      `INSERT INTO factory_order_finding (order_id, dimension, summary, answer, resolution, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orderId, finding.dimension, finding.summary, finding.answer, finding.resolution ?? null, at],
    );
    const id = Number(result.lastInsertRowid);
    return appendOrderEventInTransaction(db, orderId, { kind: "review_finished", worker, findingId: id }, at);
  })();
}

export function recordOrderEnvironment(
  db: Database,
  orderId: string,
  report: WorkerHookReport,
  at = now(),
): void {
  assertOrderWorking(db, orderId);
  db.run(
    `INSERT INTO factory_order_environment
       (order_id, phase, argv, exit_code, signal, stdout, stderr, resources, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orderId,
      report.phase,
      JSON.stringify(report.argv),
      report.exitCode,
      report.signal,
      report.stdout,
      report.stderr,
      JSON.stringify(report.resources),
      at,
    ],
  );
}

export function recordOrderDocument(db: Database, orderId: string, path: string, at = now()): void {
  assertOrderWorking(db, orderId);
  db.run("INSERT INTO factory_order_document (order_id, path, recorded_at) VALUES (?, ?, ?)", [
    orderId,
    path,
    at,
  ]);
}

/**
 * A check older than the last commit is the case the gate exists to catch: an order
 * that ran the repo's check and then kept committing has no evidence for what it
 * landed. With no commit recorded there is nothing for a check to be older than,
 * so any passing one satisfies it.
 *
 * Both sides are `recorded_at`, the time the row was written, so the two paths
 * are judged on one clock. A check's `finished_at` may be supplied by its caller
 * and is free to say when the check truly ran, which on a loop that checks before
 * committing is earlier than the commit it vouches for.
 */
function assertChecked(db: Database, orderId: string): void {
  const passed = db
    .query(
      `SELECT 1 FROM factory_order_check
       WHERE order_id = ? AND exit_code = 0
         AND recorded_at >= coalesce((SELECT max(recorded_at) FROM factory_order_commit WHERE order_id = ?), '')
       LIMIT 1`,
    )
    .get(orderId, orderId);
  if (!passed) {
    throw new OrderNotDone(
      "order_not_checked",
      `order ${orderId} cannot complete without a check that passed after its last commit: ` +
        `record one with \`dim order check ${orderId} --command "..." --exit 0\`, ` +
        "or stop it as failed.",
    );
  }
}

/**
 * A branch that is finished and unmerged is the state work rots in, so being on
 * the trunk is part of being done rather than a step after it. Where the repo
 * cannot place the commit at all, the refusal says which reading failed rather
 * than reporting the work as unmerged on the strength of a git command that did
 * not answer.
 */
function assertIntegrated(db: Database, orderId: string, worktree: string): void {
  const shas = db
    .query<{ sha: string }, [string]>("SELECT sha FROM factory_order_commit WHERE order_id = ?")
    .all(orderId)
    .map((row) => row.sha);
  if (shas.length === 0) {
    throw new OrderNotDone(
      "order_not_integrated",
      `order ${orderId} recorded no commit, so nothing of it is on the trunk: ` +
        `record what it landed with \`dim order commit ${orderId} --sha <sha>\`, ` +
        "or stop it as failed.",
    );
  }
  const reach = shas.map((sha) => reachesTrunk(worktree, sha));
  if (reach.some((one) => one.reach === "reached")) return;
  const unknown = reach.find((one) => one.reach === "unknown");
  if (unknown && unknown.reach === "unknown") {
    throw new OrderNotDone(
      "order_trunk_unknown",
      `order ${orderId} cannot be placed against a trunk, so nothing can say whether it is ` +
        `integrated: ${unknown.why}.`,
    );
  }
  if (reach.every((one) => one.reach === "absent")) {
    throw new OrderNotDone(
      "order_not_integrated",
      `order ${orderId} recorded commits that ${worktree} does not have, so nothing there can place ` +
        `them: check the shas recorded with \`dim q order ${orderId}\`.`,
    );
  }
  throw new OrderNotDone(
    "order_not_integrated",
    `order ${orderId} has no recorded commit on the trunk: merge its branch before completing it, ` +
      "or stop it as failed.",
  );
}

function assertOrderWorking(db: Database, orderId: string): void {
  const status = orderStatus(db, orderId);
  if (status === "working") return;
  // A queued order is short of the point that takes evidence rather than past it,
  // and this refusal is read by whoever typed the command.
  throw new Error(
    status === "queued" ? `order ${orderId} is not claimed` : `order ${orderId} is already ${status}`,
  );
}

/**
 * Lands an order's own commits on the repo's trunk. Nothing here is written back to the
 * order: whether it shipped is the trunk fact `assertIntegrated` already reads, not a bit
 * this sets, which is what lets a repo that opens a pull request instead arrive later
 * without this gate having to change. Held under the factory lock because two orders
 * shipping at once is a race on the same git checkout, not on the database.
 */
export function shipOrder(
  db: Database,
  orderId: string,
  worktree: string,
  env: Env = process.env,
): ShipOutcome {
  assertOrderWorking(db, orderId);
  const shas = db
    .query<{ sha: string }, [string]>("SELECT sha FROM factory_order_commit WHERE order_id = ?")
    .all(orderId)
    .map((row) => row.sha);
  if (shas.length === 0) {
    throw new OrderNotDone(
      "order_not_integrated",
      `order ${orderId} recorded no commit, so nothing of it can ship: ` +
        `record what it landed with \`dim order commit ${orderId} --sha <sha>\`.`,
    );
  }
  return withLock(() => shipToTrunk(worktree, shas), env);
}
