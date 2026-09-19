import type { Database } from "bun:sqlite";
import { reachesTrunk } from "./trunk";
import type { WorkerHookReport } from "./worker-environment";

/**
 * What state the order is in. `claimed` is an event and not one of these: the act
 * of claiming leaves the order waiting for the worker that will start it.
 */
export const ORDER_STATUSES = ["waiting", "working", "completed", "blocked", "fenced", "failed"] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type OrderEventKind =
  | "claimed"
  | "delegated"
  | "started"
  | "moved"
  | "commit_created"
  | "check_finished"
  | "review_finished"
  | "fenced"
  | "blocked"
  | "completed"
  | "failed";

/** What a worker was called in as. The operator runs the line and holds no order, so it is not one. */
export const ORDER_ROLES = ["planner", "builder", "reviewer"] as const;
export type OrderRole = (typeof ORDER_ROLES)[number];

export function isOrderRole(value: string): value is OrderRole {
  return (ORDER_ROLES as readonly string[]).includes(value);
}

export type Order = {
  id: string;
  runId: string;
  queueId: string;
  itemId: string;
  title: string;
  description?: string;
  agentId?: string;
  role?: OrderRole;
  sessionId?: string;
  worktree?: string;
  branch?: string;
  station?: string;
};

export type OrderEvent = {
  kind: OrderEventKind;
  actorId?: string;
  sessionId?: string;
  station?: string;
  delegatedAgentId?: string;
  delegatedSessionId?: string;
  delegatedStation?: string;
  commitSha?: string;
  checkId?: number;
  findingId?: number;
  fenceType?: string;
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
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = ["completed", "blocked", "fenced", "failed"];
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
    event.actorId ?? null,
    event.sessionId ?? null,
    event.station ?? null,
    event.delegatedAgentId ?? null,
    event.delegatedSessionId ?? null,
    event.delegatedStation ?? null,
    event.commitSha ?? null,
    event.checkId ?? null,
    event.findingId ?? null,
    event.fenceType ?? null,
    event.status ?? null,
    event.reason ?? null,
  ];
}

export function createOrder(db: Database, order: Order, at = now()): void {
  db.transaction(() => {
    db.run(
      `INSERT INTO factory_order
       (id, run_id, queue_id, item_id, title, description, agent_id, role, session_id, worktree, branch, station, status, claimed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`,
      [
        order.id,
        order.runId,
        order.queueId,
        order.itemId,
        order.title,
        order.description ?? null,
        order.agentId ?? null,
        order.role ?? null,
        order.sessionId ?? null,
        order.worktree ?? null,
        order.branch ?? null,
        order.station ?? null,
        at,
        at,
      ],
    );
    appendOrderEvent(
      db,
      order.id,
      { kind: "claimed", actorId: order.agentId, sessionId: order.sessionId, station: order.station },
      at,
    );
  })();
}

export function updateOrderLocation(db: Database, orderId: string, worktree: string, branch: string): void {
  const order = db.query("SELECT worktree, branch FROM factory_order WHERE id = ?").get(orderId) as {
    worktree: string | null;
    branch: string | null;
  } | null;
  if (!order) throw new Error(`order not found: ${orderId}`);
  const status = orderStatus(db, orderId);
  if (status !== "waiting" && status !== "working") {
    throw new Error(`order ${orderId} is already terminal`);
  }
  if (order.worktree && (order.worktree !== worktree || order.branch !== branch)) {
    throw new Error(`order ${orderId} already owns a worktree`);
  }
  const result = db.run("UPDATE factory_order SET worktree = ?, branch = ?, updated_at = ? WHERE id = ?", [
    worktree,
    branch,
    now(),
    orderId,
  ]);
  if (result.changes !== 1) throw new Error(`order not found: ${orderId}`);
}

/**
 * The projection follows the move because that column is what a card is read by
 * (`src/factory-wall.ts` prefers it over the latest event's station), and the
 * event ledger keeps every station the order passed through.
 */
export function moveOrder(db: Database, orderId: string, station: string, at = now()): void {
  db.transaction(() => {
    appendOrderEventInTransaction(db, orderId, { kind: "moved", station }, at);
    db.run("UPDATE factory_order SET station = ? WHERE id = ?", [station, orderId]);
  })();
}

export function orderStatus(db: Database, orderId: string): OrderStatus {
  const order = db.query("SELECT status FROM factory_order WHERE id = ?").get(orderId) as {
    status: OrderStatus;
  } | null;
  if (!order) throw new Error(`order not found: ${orderId}`);
  return order.status;
}

export function appendOrderEvent(db: Database, orderId: string, event: OrderEvent, at = now()): void {
  db.transaction(() => appendOrderEventInTransaction(db, orderId, event, at))();
}

function appendOrderEventInTransaction(db: Database, orderId: string, event: OrderEvent, at: string): void {
  if (isTerminalOrderStatus(event.kind as OrderStatus) && event.status !== event.kind) {
    throw new Error(`terminal event kind must match its status: ${event.kind}`);
  }
  if (event.status && isTerminalOrderStatus(event.status) && event.kind !== event.status) {
    throw new Error(`terminal event status must match its kind: ${event.status}`);
  }
  const order = db.query("SELECT status, worktree FROM factory_order WHERE id = ?").get(orderId) as {
    status: OrderStatus;
    worktree: string | null;
  } | null;
  if (!order) throw new Error(`order not found: ${orderId}`);
  if (isTerminalOrderStatus(order.status)) {
    throw new Error(`order ${orderId} is already ${order.status}`);
  }
  if (event.kind !== "claimed") {
    if (event.kind === "started" && order.status !== "waiting") {
      throw new Error(`order ${orderId} must be claimed before it can start`);
    }
    const mayStopBeforeWorking =
      isTerminalOrderStatus(event.kind as OrderStatus) && event.kind !== "completed";
    if (event.kind !== "started" && order.status !== "working" && !mayStopBeforeWorking) {
      const action = VERB_FOR_KIND[event.kind] ?? event.kind;
      throw new Error(`order ${orderId} must be working before it can ${action}`);
    }
    if (event.kind === "completed") {
      if (!order.worktree) throw new Error(`order ${orderId} has no worktree`);
      assertChecked(db, orderId);
      assertIntegrated(db, orderId, order.worktree);
    }
  }

  db.run(
    `INSERT INTO factory_order_event
       (order_id, ts, kind, actor_id, session_id, station, delegated_agent_id, delegated_session_id,
        delegated_station, commit_sha, check_id, finding_id, fence_type, status, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    eventValues(orderId, event, event.ts ?? at),
  );
  db.run(
    `UPDATE factory_order SET status = coalesce(?, status), updated_at = ?, started_at = coalesce(started_at, ?),
       completed_at = CASE WHEN ? IN ('completed', 'blocked', 'fenced', 'failed') THEN ? ELSE completed_at END,
       stop_reason = coalesce(?, stop_reason)
       WHERE id = ?`,
    [
      event.status ?? null,
      event.ts ?? at,
      event.kind === "started" ? (event.ts ?? at) : null,
      event.status ?? null,
      event.ts ?? at,
      event.reason ?? null,
      orderId,
    ],
  );
}

export function recordOrderCommit(
  db: Database,
  orderId: string,
  sha: string,
  subject?: string,
  at = now(),
): void {
  assertOrderWorking(db, orderId);
  db.transaction(() => {
    db.run("INSERT INTO factory_order_commit (order_id, sha, subject, recorded_at) VALUES (?, ?, ?, ?)", [
      orderId,
      sha,
      subject ?? null,
      at,
    ]);
    appendOrderEventInTransaction(db, orderId, { kind: "commit_created", commitSha: sha }, at);
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
    appendOrderEventInTransaction(db, orderId, { kind: "check_finished", checkId: id }, at);
    return id;
  })();
}

export function recordOrderFinding(
  db: Database,
  orderId: string,
  finding: { dimension: string; summary: string; answer: "fixed" | "refused"; resolution?: string },
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
    appendOrderEventInTransaction(db, orderId, { kind: "review_finished", findingId: id }, at);
    return id;
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
        "or stop the order as blocked, fenced or failed.",
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
        "or stop the order as blocked, fenced or failed.",
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
      "or stop the order as blocked, fenced or failed.",
  );
}

function assertOrderWorking(db: Database, orderId: string): void {
  const status = orderStatus(db, orderId);
  if (status === "working") return;
  // A claimed order is short of the point that takes evidence rather than past it,
  // and this refusal is read by whoever typed the command.
  throw new Error(
    status === "waiting" ? `order ${orderId} has not started` : `order ${orderId} is already ${status}`,
  );
}
