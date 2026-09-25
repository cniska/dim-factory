import type { Database } from "bun:sqlite";
import type { ScheduleInvocation } from "./factory-events";

export type Schedule = {
  id: string;
  queueId: string;
  intervalSeconds: number;
  enabled?: boolean;
  paused?: boolean;
};

export type ScheduleRow = {
  id: string;
  queue_id: string;
  interval_seconds: number;
  enabled: number;
  paused: number;
  created_at: string;
  updated_at: string;
  last_evaluated_at: string | null;
  last_due_at: string | null;
};

const now = (): string => new Date().toISOString();

export function createSchedule(db: Database, schedule: Schedule, at = now()): void {
  db.run(
    `INSERT INTO factory_schedule
     (id, queue_id, interval_seconds, enabled, paused, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      schedule.id,
      schedule.queueId,
      schedule.intervalSeconds,
      schedule.enabled === false ? 0 : 1,
      schedule.paused ? 1 : 0,
      at,
      at,
    ],
  );
}

export function setSchedulePaused(db: Database, id: string, paused: boolean, at = now()): void {
  const result = db.run("UPDATE factory_schedule SET paused = ?, updated_at = ? WHERE id = ?", [
    paused ? 1 : 0,
    at,
    id,
  ]);
  if (result.changes !== 1) throw new Error(`schedule not found: ${id}`);
}

export function setScheduleEnabled(db: Database, id: string, enabled: boolean, at = now()): void {
  const result = db.run("UPDATE factory_schedule SET enabled = ?, updated_at = ? WHERE id = ?", [
    enabled ? 1 : 0,
    at,
    id,
  ]);
  if (result.changes !== 1) throw new Error(`schedule not found: ${id}`);
}

export function listDueSchedules(db: Database, at: string): ScheduleRow[] {
  return db
    .query(
      `SELECT * FROM factory_schedule
       WHERE enabled = 1 AND paused = 0
         AND (last_evaluated_at IS NULL OR datetime(last_evaluated_at, '+' || interval_seconds || ' seconds') <= datetime(?))
       ORDER BY id`,
    )
    .all(at) as ScheduleRow[];
}

export function recordScheduleEvaluation(db: Database, id: string, at: string, due: boolean): void {
  recordScheduleInvocation(db, {
    scheduleId: id,
    evaluatedAt: at,
    due,
    dispatched: false,
    selectedOrderIds: [],
    outcome: due ? "failed" : "not_due",
    reason: due ? "due evaluation was not dispatched" : undefined,
  });
}

export function recordScheduleInvocation(db: Database, invocation: ScheduleInvocation): number {
  return db.transaction(() => {
    const sessionId =
      invocation.sessionId ??
      (invocation.worker
        ? db
            .query<{ session_id: string | null }, [string]>(
              "SELECT session_id FROM factory_worker WHERE name = ?",
            )
            .get(invocation.worker)?.session_id
        : null);
    const written = db.run(
      `INSERT INTO factory_schedule_invocation
         (schedule_id, evaluated_at, due, dispatched, selected_order_ids, worker, session_id,
          harness, model, tier, outcome, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invocation.scheduleId,
        invocation.evaluatedAt,
        invocation.due ? 1 : 0,
        invocation.dispatched ? 1 : 0,
        JSON.stringify(invocation.selectedOrderIds),
        invocation.worker ?? null,
        sessionId ?? null,
        invocation.harness ?? null,
        invocation.model ?? null,
        invocation.tier ?? null,
        invocation.outcome,
        invocation.reason ?? null,
      ],
    );
    const updated = db.run(
      `UPDATE factory_schedule
       SET last_evaluated_at = ?, last_due_at = CASE WHEN ? THEN ? ELSE last_due_at END, updated_at = ?
       WHERE id = ?`,
      [
        invocation.evaluatedAt,
        invocation.due ? 1 : 0,
        invocation.due ? invocation.evaluatedAt : null,
        invocation.evaluatedAt,
        invocation.scheduleId,
      ],
    );
    if (updated.changes !== 1) throw new Error(`schedule not found: ${invocation.scheduleId}`);
    return Number(written.lastInsertRowid);
  })();
}
