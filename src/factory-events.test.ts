import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { appendOrderEvent } from "./factory-order-ledger";
import { dropOrder, queueOrder, setOrderHold, setOrderPriority } from "./factory-order-lifecycle";
import { mintWorker } from "./factory-worker";
import { SCHEMA_SQL } from "./schema";

function columns(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

describe("factory domain event boundary", () => {
  test("keeps lifecycle references and dedicated records in the durable schema", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);

    expect(columns(db, "factory_order_event")).toContain("evidence");
    expect(columns(db, "factory_order_attempt")).toEqual(
      expect.arrayContaining(["session_id", "provider_session_id", "harness", "model", "tier"]),
    );
    expect(columns(db, "factory_schedule_invocation")).toEqual(
      expect.arrayContaining(["evaluated_at", "due", "dispatched", "selected_order_ids", "outcome"]),
    );
    expect(columns(db, "factory_order_verdict")).toEqual(
      expect.arrayContaining(["decision", "grounds", "worker", "recorded_at"]),
    );
    expect(columns(db, "factory_order_delivery")).toEqual(
      expect.arrayContaining(["kind", "outcome", "target", "commit_sha", "recorded_at"]),
    );
    db.close();
  });

  test("retains the domain event when diagnostic trace storage is unavailable", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const worker = mintWorker(db, { role: "operator", sessionId: "domain-boundary" }).name;
    db.run("DROP TABLE trace_event");

    const orderId = "trace-is-optional";
    queueOrder(
      db,
      { id: orderId, project: "example/project", title: "Domain fact" },
      worker,
      "2026-09-25T09:00:00.000Z",
    );
    appendOrderEvent(
      db,
      orderId,
      { kind: "queued", worker, evidence: { source: "operator", request: 1 } },
      "2026-09-25T09:01:00.000Z",
    );

    expect(
      db
        .query("SELECT kind, evidence FROM factory_order_event WHERE order_id = ? ORDER BY id DESC")
        .get(orderId),
    ).toEqual({
      kind: "queued",
      evidence: JSON.stringify({ source: "operator", request: 1 }),
    });
    db.close();
  });

  test("records attributed queue changes and owner decisions separately from the projection", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const worker = mintWorker(db, { role: "operator", sessionId: "queue-history" }).name;
    queueOrder(
      db,
      {
        id: "queue-history",
        project: "example/project",
        title: "Queue history",
        provenance: { source: "operator", request: 7 },
      },
      worker,
      "2026-09-25T09:00:00.000Z",
    );
    setOrderPriority(db, "queue-history", "urgent", worker, "2026-09-25T09:01:00.000Z");
    setOrderHold(db, "queue-history", "owner", worker, "2026-09-25T09:02:00.000Z");
    setOrderHold(db, "queue-history", null, worker, "2026-09-25T09:03:00.000Z");
    dropOrder(db, "queue-history", "superseded", worker, "2026-09-25T09:04:00.000Z");

    expect(
      db
        .query<{ kind: string }, [string]>(
          "SELECT kind FROM factory_order_event WHERE order_id = ? ORDER BY id",
        )
        .all("queue-history")
        .map((row) => row.kind),
    ).toEqual([
      "queued",
      "priority_changed",
      "hold_set",
      "hold_released",
      "owner_verdict_recorded",
      "dropped",
    ]);
    expect(
      db.query("SELECT priority, hold, status FROM factory_order WHERE id = ?").get("queue-history"),
    ).toEqual({
      priority: "urgent",
      hold: null,
      status: "dropped",
    });
    expect(
      db.query("SELECT decision, grounds FROM factory_order_verdict WHERE order_id = ?").get("queue-history"),
    ).toEqual({
      decision: "dropped",
      grounds: "superseded",
    });
    db.close();
  });
});
