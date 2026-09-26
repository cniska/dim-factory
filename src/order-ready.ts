import type { Database } from "bun:sqlite";
import type { OrderLine } from "./order-line";
import type { OrderPriority, OrderStatus } from "./order-status";

export type ReadyOrder = {
  id: string;
  project: string;
  title: string;
  line: OrderLine;
  description?: string;
  status: OrderStatus;
  priority: OrderPriority;
  createdAt: string;
  hold?: string;
  stoppedBecause?: string;
};

const PRIORITY_RANK =
  "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";

type Row = {
  id: string;
  project: string;
  title: string;
  line: string;
  description: string | null;
  status: string;
  priority: string;
  created_at: string;
  hold: string | null;
  stop_reason: string | null;
};

function orderFrom(row: Row): ReadyOrder {
  return {
    id: row.id,
    project: row.project,
    title: row.title,
    line: row.line as OrderLine,
    ...(row.description === null ? {} : { description: row.description }),
    status: row.status as OrderStatus,
    priority: row.priority as OrderPriority,
    createdAt: row.created_at,
    ...(row.hold === null ? {} : { hold: row.hold }),
    ...(row.stop_reason === null ? {} : { stoppedBecause: row.stop_reason }),
  };
}

const SELECT = `SELECT id, project, title, line, description, status, priority, created_at, hold, stop_reason
                  FROM factory_order
                 WHERE project = ? AND status = 'queued'`;

export function readyOrders(db: Database, project: string, limit?: number): ReadyOrder[] {
  const rows = db
    .query<Row, [string]>(`${SELECT} AND hold IS NULL ORDER BY ${PRIORITY_RANK}, created_at, id`)
    .all(project);
  return (limit === undefined ? rows : rows.slice(0, limit)).map(orderFrom);
}

export function heldOrders(db: Database, project: string): ReadyOrder[] {
  return db
    .query<Row, [string]>(`${SELECT} AND hold IS NOT NULL ORDER BY ${PRIORITY_RANK}, created_at, id`)
    .all(project)
    .map(orderFrom);
}
