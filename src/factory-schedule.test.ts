import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SCHEMA_SQL } from "./db-schema";
import {
  createSchedule,
  listDueSchedules,
  recordScheduleEvaluation,
  recordScheduleInvocation,
  setSchedulePaused,
} from "./factory-schedule";
import { findQuery } from "./query-registry";

describe("factory schedules", () => {
  test("selects an unevaluated schedule and respects its interval", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createSchedule(
      db,
      { id: "hourly", queueId: "build-order", intervalSeconds: 3600 },
      "2026-09-18T09:00:00.000Z",
    );

    expect(listDueSchedules(db, "2026-09-18T09:01:00.000Z").map((row) => row.id)).toEqual(["hourly"]);
    recordScheduleEvaluation(db, "hourly", "2026-09-18T09:01:00.000Z", true);
    expect(listDueSchedules(db, "2026-09-18T09:59:00.000Z")).toEqual([]);
    expect(listDueSchedules(db, "2026-09-18T10:01:00.000Z").map((row) => row.queue_id)).toEqual([
      "build-order",
    ]);
    db.close();
  });

  test("paused schedules are not due and retain their definition", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createSchedule(db, { id: "paused", queueId: "queue", intervalSeconds: 60 }, "2026-09-18T09:00:00.000Z");
    setSchedulePaused(db, "paused", true, "2026-09-18T09:02:00.000Z");

    expect(listDueSchedules(db, "2026-09-18T09:03:00.000Z")).toEqual([]);
    expect(
      db.query("SELECT queue_id, interval_seconds, paused FROM factory_schedule WHERE id = 'paused'").get(),
    ).toEqual({
      queue_id: "queue",
      interval_seconds: 60,
      paused: 1,
    });
    db.close();
  });

  test("missing schedules fail instead of inventing state", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    expect(() => setSchedulePaused(db, "missing", true)).toThrow("schedule not found: missing");
    expect(() => recordScheduleEvaluation(db, "missing", "2026-09-18T09:00:00.000Z", true)).toThrow(
      "schedule not found: missing",
    );
    db.close();
  });

  test("retains repeated evaluations and dispatch outcomes without changing the definition", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createSchedule(db, { id: "retries", queueId: "queue", intervalSeconds: 60 }, "2026-09-18T09:00:00.000Z");

    recordScheduleEvaluation(db, "retries", "2026-09-18T09:01:00.000Z", false);
    recordScheduleInvocation(db, {
      scheduleId: "retries",
      evaluatedAt: "2026-09-18T09:02:00.000Z",
      due: true,
      dispatched: false,
      selectedOrderIds: ["order-1"],
      worker: undefined,
      outcome: "failed",
      reason: "dispatch refused",
    });
    recordScheduleInvocation(db, {
      scheduleId: "retries",
      evaluatedAt: "2026-09-18T09:03:00.000Z",
      due: true,
      dispatched: true,
      selectedOrderIds: ["order-1", "order-2"],
      worker: undefined,
      harness: "codex",
      model: "gpt-test",
      tier: "standard",
      outcome: "dispatched",
    });

    expect(
      db
        .query(
          "SELECT evaluated_at, due, dispatched, selected_order_ids, outcome, reason FROM factory_schedule_invocation ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        evaluated_at: "2026-09-18T09:01:00.000Z",
        due: 0,
        dispatched: 0,
        selected_order_ids: "[]",
        outcome: "not_due",
        reason: null,
      },
      {
        evaluated_at: "2026-09-18T09:02:00.000Z",
        due: 1,
        dispatched: 0,
        selected_order_ids: '["order-1"]',
        outcome: "failed",
        reason: "dispatch refused",
      },
      {
        evaluated_at: "2026-09-18T09:03:00.000Z",
        due: 1,
        dispatched: 1,
        selected_order_ids: '["order-1","order-2"]',
        outcome: "dispatched",
        reason: null,
      },
    ]);
    expect(
      db.query("SELECT queue_id, interval_seconds FROM factory_schedule WHERE id = 'retries'").get(),
    ).toEqual({
      queue_id: "queue",
      interval_seconds: 60,
    });
    const history = findQuery("schedule-history")?.run(db, { arg: "retries" });
    expect(history?.denominator).toBe("3 schedule invocations read from factory_schedule_invocation");
    expect(history?.rows.map((row) => row[11])).toEqual([null, "dispatch refused", null]);
    db.close();
  });
});
