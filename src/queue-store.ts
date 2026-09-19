import type { Database } from "bun:sqlite";

export const QUEUE_STATUSES = ["planned", "claimed", "completed", "dropped"] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export const QUEUE_PRIORITIES = ["urgent", "high", "medium", "low", "unset"] as const;
export type QueuePriority = (typeof QUEUE_PRIORITIES)[number];

export type QueueItem = {
  queueId: string;
  id: string;
  title: string;
  description?: string;
  status: QueueStatus;
  priority: QueuePriority;
  createdAt: string;
  dependsOn: string[];
};

export type QueueStoreCode =
  | "unknown_status"
  | "unknown_priority"
  | "duplicate_item"
  | "unknown_item"
  | "unknown_dependency"
  | "terminal_item"
  | "invalid_transition"
  | "dependencies_open";

export class QueueStoreError extends Error {
  constructor(
    readonly code: QueueStoreCode,
    message: string,
  ) {
    super(message);
  }
}

const terminal = new Set<QueueStatus>(["completed", "dropped"]);

/** A claim is the only way out of `planned`, and an order that stopped without landing puts its
 *  item back rather than inventing a status for work nobody is holding. */
const allowed = new Map<QueueStatus, Set<QueueStatus>>([
  ["planned", new Set<QueueStatus>(["claimed", "dropped"])],
  ["claimed", new Set<QueueStatus>(["completed", "planned", "dropped"])],
]);

/** Urgent first and unset last, which is the order a queue is worked in rather than the order
 *  the words happen to sort in. */
const PRIORITY_RANK =
  "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";

type ItemRow = {
  queue_id: string;
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  created_at: string;
};

function itemFrom(row: ItemRow, dependsOn: string[]): QueueItem {
  return {
    queueId: row.queue_id,
    id: row.id,
    title: row.title,
    ...(row.description === null ? {} : { description: row.description }),
    status: row.status as QueueStatus,
    priority: row.priority as QueuePriority,
    createdAt: row.created_at,
    dependsOn,
  };
}

function dependenciesOf(db: Database, queueId: string, itemId: string): string[] {
  return db
    .query<{ depends_on_id: string }, [string, string]>(
      "SELECT depends_on_id FROM queue_item_dependency WHERE queue_id = ? AND item_id = ? ORDER BY depends_on_id",
    )
    .all(queueId, itemId)
    .map((row) => row.depends_on_id);
}

export function readItem(db: Database, queueId: string, itemId: string): QueueItem | undefined {
  const row = db
    .query<ItemRow, [string, string]>(
      "SELECT queue_id, id, title, description, status, priority, created_at FROM queue_item WHERE queue_id = ? AND id = ?",
    )
    .get(queueId, itemId);
  return row ? itemFrom(row, dependenciesOf(db, queueId, itemId)) : undefined;
}

export function addItem(
  db: Database,
  item: {
    queueId: string;
    id: string;
    title: string;
    description?: string;
    priority?: QueuePriority;
    dependsOn?: string[];
    discoveredByOrderId?: string;
  },
  at: string,
): QueueItem {
  const priority = item.priority ?? "unset";
  if (!QUEUE_PRIORITIES.includes(priority)) {
    throw new QueueStoreError("unknown_priority", `${priority} is not a priority`);
  }
  return db.transaction(() => {
    if (readItem(db, item.queueId, item.id)) {
      throw new QueueStoreError("duplicate_item", `${item.id} is already in ${item.queueId}`);
    }
    db.run(
      `INSERT INTO queue_item (queue_id, id, title, description, status, priority, created_at, discovered_by_order_id)
       VALUES (?, ?, ?, ?, 'planned', ?, ?, ?)`,
      [
        item.queueId,
        item.id,
        item.title,
        item.description ?? null,
        priority,
        at,
        item.discoveredByOrderId ?? null,
      ],
    );
    for (const dependency of item.dependsOn ?? []) {
      if (!readItem(db, item.queueId, dependency)) {
        throw new QueueStoreError("unknown_dependency", `${dependency} is not in ${item.queueId}`);
      }
      db.run("INSERT INTO queue_item_dependency (queue_id, item_id, depends_on_id) VALUES (?, ?, ?)", [
        item.queueId,
        item.id,
        dependency,
      ]);
    }
    return readItem(db, item.queueId, item.id) as QueueItem;
  })();
}

/** Planned items every dependency of which has landed, in the order they should be taken. */
export function readyItems(db: Database, queueId: string, limit?: number): QueueItem[] {
  const rows = db
    .query<ItemRow, [string]>(
      `SELECT i.queue_id, i.id, i.title, i.description, i.status, i.priority, i.created_at
         FROM queue_item i
        WHERE i.queue_id = ? AND i.status = 'planned'
          AND NOT EXISTS (
            SELECT 1 FROM queue_item_dependency d
              JOIN queue_item p ON p.queue_id = d.queue_id AND p.id = d.depends_on_id
             WHERE d.queue_id = i.queue_id AND d.item_id = i.id AND p.status <> 'completed'
          )
        ORDER BY ${PRIORITY_RANK}, i.created_at, i.id`,
    )
    .all(queueId);
  const taken = limit === undefined ? rows : rows.slice(0, limit);
  return taken.map((row) => itemFrom(row, dependenciesOf(db, row.queue_id, row.id)));
}

export function transitionItem(
  db: Database,
  queueId: string,
  itemId: string,
  to: QueueStatus,
  at: string,
  extra: { reason?: string; orderId?: string } = {},
): QueueItem {
  if (!QUEUE_STATUSES.includes(to)) {
    throw new QueueStoreError("unknown_status", `${to} is not a status`);
  }
  return db.transaction(() => {
    const item = readItem(db, queueId, itemId);
    if (!item) throw new QueueStoreError("unknown_item", `${itemId} is not in ${queueId}`);
    if (terminal.has(item.status)) {
      throw new QueueStoreError("terminal_item", `${itemId} is ${item.status} and takes no further move`);
    }
    if (!allowed.get(item.status)?.has(to)) {
      throw new QueueStoreError("invalid_transition", `${itemId} cannot go from ${item.status} to ${to}`);
    }
    if (to === "claimed" && !readyItems(db, queueId).some((ready) => ready.id === itemId)) {
      throw new QueueStoreError("dependencies_open", `${itemId} waits on something unfinished`);
    }
    db.run("UPDATE queue_item SET status = ? WHERE queue_id = ? AND id = ?", [to, queueId, itemId]);
    db.run(
      `INSERT INTO queue_item_transition (queue_id, item_id, from_status, to_status, ts, reason, order_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [queueId, itemId, item.status, to, at, extra.reason ?? null, extra.orderId ?? null],
    );
    return readItem(db, queueId, itemId) as QueueItem;
  })();
}
