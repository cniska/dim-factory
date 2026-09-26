import type { Database } from "bun:sqlite";
import type { PlanSlice } from "./plan-artifact";

export function latestApprovedPlan(
  db: Database,
  orderId: string,
): { id: number; body: string; slices: PlanSlice[] } | null {
  const plan = db
    .query<{ id: number; body: string }, [string]>(
      `SELECT p.id, p.body FROM factory_order_plan p
       WHERE p.order_id = ? AND EXISTS (
         SELECT 1 FROM factory_order_event e
         WHERE e.order_id = p.order_id AND e.kind = 'plan_approved' AND e.plan_id = p.id
       )
       ORDER BY p.revision DESC, p.id DESC LIMIT 1`,
    )
    .get(orderId);
  if (!plan) return null;
  const slices = db
    .query<PlanSlice, [number]>(
      "SELECT title, outcome FROM factory_order_slice WHERE plan_id = ? ORDER BY ordinal",
    )
    .all(plan.id);
  return { ...plan, slices };
}
