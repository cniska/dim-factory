import type { Database } from "bun:sqlite";
import type { OrderLine } from "./order-line";
import type { OrderPriority } from "./order-status";

export type ReadyOrder = {
  id: string;
  project: string;
  title: string;
  line: OrderLine;
  description?: string;
  priority: OrderPriority;
  createdAt: string;
};

const PRIORITY_RANK =
  "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";

type Row = {
  id: string;
  project: string;
  title: string;
  line: string;
  description: string | null;
  priority: string;
  created_at: string;
};

function orderFrom(row: Row): ReadyOrder {
  return {
    id: row.id,
    project: row.project,
    title: row.title,
    line: row.line as OrderLine,
    ...(row.description === null ? {} : { description: row.description }),
    priority: row.priority as OrderPriority,
    createdAt: row.created_at,
  };
}

export function readyOrders(db: Database, project: string, limit?: number): ReadyOrder[] {
  const rows = db
    .query<Row, [string]>(
      `SELECT id, project, title, line, description, priority, created_at
       FROM factory_order
       WHERE project = ? AND status = 'queued'
       ORDER BY ${PRIORITY_RANK}, created_at, id`,
    )
    .all(project);
  return (limit === undefined ? rows : rows.slice(0, limit)).map(orderFrom);
}
