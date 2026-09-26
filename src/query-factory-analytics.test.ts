import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SCHEMA_SQL } from "./db-schema";
import { findQuery } from "./query-registry";

describe("factory analytics", () => {
  test("derives retries, outcomes, delivery, verdict, attribution, and scheduling from domain rows", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    db.run(
      `INSERT INTO factory_order (id, project, title, status, created_at, updated_at)
       VALUES ('order-analytics', 'cniska/dim-factory', 'Analytics', 'completed', ?, ?)`,
      ["2026-09-18T09:00:00.000Z", "2026-09-18T09:10:00.000Z"],
    );
    db.run(
      `INSERT INTO factory_order_event (order_id, ts, kind, evidence)
       VALUES ('order-analytics', ?, 'queued', ?),
              ('order-analytics', ?, 'queued', '{}'),
              ('order-analytics', ?, 'hold_set', '{"hold":"approval"}'),
              ('order-analytics', ?, 'artifact_returned', '{}'),
              ('order-analytics', ?, 'artifact_approved', '{}'),
              ('order-analytics', ?, 'hold_released', '{"hold":null}'),
              ('order-analytics', ?, 'completed', '{}')`,
      [
        "2026-09-18T09:00:00.000Z",
        '{"source":"issue-123"}',
        "2026-09-18T09:01:00.000Z",
        "2026-09-18T09:02:00.000Z",
        "2026-09-18T09:03:00.000Z",
        "2026-09-18T09:04:00.000Z",
        "2026-09-18T09:05:00.000Z",
        "2026-09-18T09:10:00.000Z",
      ],
    );
    db.run(
      `INSERT INTO factory_order_attempt
         (order_id, run_id, station, harness, model, tier, started_at, ended_at, recorded_at, kind, outcome)
       VALUES ('order-analytics', 'run-1', 'build', 'codex', 'gpt-test', 'standard', ?, ?, ?, 'started', 'running'),
              ('order-analytics', 'run-1', 'build', 'codex', 'gpt-test', 'standard', ?, ?, ?, 'finished', 'failed'),
              ('order-analytics', 'run-2', 'build', 'codex', 'gpt-test', 'standard', ?, ?, ?, 'started', 'running'),
              ('order-analytics', 'run-2', 'build', 'codex', 'gpt-test', 'standard', ?, ?, ?, 'finished', 'succeeded')`,
      [
        "2026-09-18T09:01:00.000Z",
        "2026-09-18T09:02:00.000Z",
        "2026-09-18T09:02:00.000Z",
        "2026-09-18T09:01:00.000Z",
        "2026-09-18T09:02:00.000Z",
        "2026-09-18T09:02:00.000Z",
        "2026-09-18T09:06:00.000Z",
        "2026-09-18T09:09:00.000Z",
        "2026-09-18T09:09:00.000Z",
        "2026-09-18T09:06:00.000Z",
        "2026-09-18T09:10:00.000Z",
        "2026-09-18T09:10:00.000Z",
      ],
    );
    db.run(
      `INSERT INTO factory_order_delivery (order_id, kind, outcome, recorded_at)
       VALUES ('order-analytics', 'integration', 'succeeded', '2026-09-18T09:10:00.000Z'),
              ('order-analytics', 'delivery', 'succeeded', '2026-09-18T09:10:00.000Z')`,
    );
    db.run(
      `INSERT INTO factory_schedule (id, queue_id, interval_seconds, created_at, updated_at)
       VALUES ('schedule-analytics', 'queue', 60, '2026-09-18T09:00:00.000Z', '2026-09-18T09:00:00.000Z')`,
    );
    db.run(
      `INSERT INTO factory_schedule_invocation
         (schedule_id, evaluated_at, due, dispatched, selected_order_ids, outcome)
       VALUES ('schedule-analytics', '2026-09-18T09:01:00.000Z', 1, 1, '["order-analytics"]', 'dispatched'),
              ('schedule-analytics', '2026-09-18T09:02:00.000Z', 1, 0, '["order-analytics"]', 'failed'),
              ('schedule-analytics', '2026-09-18T09:03:00.000Z', 1, 1, '["another-order"]', 'dispatched'),
              ('schedule-analytics', '2026-09-18T09:04:00.000Z', 1, 0, '["another-order"]', 'failed'),
              ('schedule-analytics', '2026-09-18T09:05:00.000Z', 0, 0, '[]', 'not_due')`,
    );

    const result = findQuery("factory-analytics")?.run(db, { arg: "order-analytics" });
    const metrics = new Map(result?.rows.map(([name, value]) => [name, value]));
    expect(metrics.get("attempts")).toBe(2);
    expect(metrics.get("retries")).toBe(1);
    expect(metrics.get("attempt_outcome:failed")).toBe(1);
    expect(metrics.get("attempt_outcome:succeeded")).toBe(1);
    expect(metrics.get("hold_seconds")).toBe(180);
    expect(metrics.get("provenance_events")).toBe(1);
    expect(metrics.get("integration:succeeded")).toBe(1);
    expect(metrics.get("delivery:succeeded")).toBe(1);
    expect(metrics.get("verdict:approved")).toBe(1);
    expect(metrics.get("verdict:returned")).toBe(1);
    expect(metrics.get("verdict:dropped")).toBe(undefined);
    expect(metrics.get("worker_execution:codex/gpt-test/standard")).toBe(2);
    expect(metrics.get("schedule_evaluations")).toBe(2);
    expect(metrics.get("schedule_due")).toBe(2);
    expect(metrics.get("schedule_dispatched")).toBe(1);
    expect(metrics.get("schedule_dispatch_failures")).toBe(1);

    db.run("DELETE FROM factory_order_attempt WHERE run_id = 'run-2' AND kind = 'finished'");
    const afterRemoval = findQuery("factory-analytics")?.run(db, { arg: "order-analytics" });
    expect(
      new Map(afterRemoval?.rows.map(([name, value]) => [name, value])).get("attempt_outcome:succeeded"),
    ).toBe(undefined);
    db.close();
  });
});
