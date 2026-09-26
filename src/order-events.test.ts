import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SCHEMA_SQL } from "./db-schema";
import { appendOrderEvent } from "./order-ledger";
import { dropOrder, queueOrder, setOrderPriority } from "./order-lifecycle";
import { orderStatus } from "./order-status";
import { mintWorker } from "./worker";

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

    expect(columns(db, "factory_order_event")).toEqual(expect.arrayContaining(["evidence", "artifact_id"]));
    expect(columns(db, "factory_order_attempt")).toEqual(
      expect.arrayContaining(["session_id", "provider_session_id", "harness", "model", "tier"]),
    );
    expect(columns(db, "factory_schedule_invocation")).toEqual(
      expect.arrayContaining(["evaluated_at", "due", "dispatched", "selected_order_ids", "outcome"]),
    );
    expect(columns(db, "factory_order_artifact")).toEqual([
      "id",
      "order_id",
      "kind",
      "revision",
      "body",
      "head_sha",
      "review_id",
    ]);
    expect(columns(db, "factory_order")).not.toContain("status");
    expect(columns(db, "factory_order_event")).not.toContain("status");
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
    dropOrder(db, "queue-history", "superseded", worker, "2026-09-25T09:04:00.000Z");

    expect(
      db
        .query<{ kind: string }, [string]>(
          "SELECT kind FROM factory_order_event WHERE order_id = ? ORDER BY id",
        )
        .all("queue-history")
        .map((row) => row.kind),
    ).toEqual(["queued", "priority_changed", "dropped"]);
    expect(db.query("SELECT priority FROM factory_order WHERE id = ?").get("queue-history")).toEqual({
      priority: "urgent",
    });
    expect(orderStatus(db, "queue-history")).toBe("dropped");
    expect(
      db
        .query("SELECT worker, reason FROM factory_order_event WHERE order_id = ? AND kind = 'dropped'")
        .get("queue-history"),
    ).toEqual({
      worker,
      reason: "superseded",
    });
    db.close();
  });
});
