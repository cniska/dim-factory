import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SCHEMA_SQL } from "./db-schema";
import { appendOrderEvent } from "./order-ledger";
import { dropOrder, queueOrder } from "./order-lifecycle";
import { orderStatus } from "./order-status";
import { mintWorker } from "./worker";

describe("factory domain event boundary", () => {
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
    appendOrderEvent(db, orderId, { kind: "queued", worker }, "2026-09-25T09:01:00.000Z");

    expect(
      db
        .query("SELECT count(*) AS n FROM factory_order_event WHERE order_id = ? AND kind = 'queued'")
        .get(orderId),
    ).toEqual({ n: 2 });
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
      },
      worker,
      "2026-09-25T09:00:00.000Z",
    );
    dropOrder(db, "queue-history", "superseded", worker, "2026-09-25T09:04:00.000Z");

    expect(
      db
        .query<{ kind: string }, [string]>(
          "SELECT kind FROM factory_order_event WHERE order_id = ? ORDER BY id",
        )
        .all("queue-history")
        .map((row) => row.kind),
    ).toEqual(["queued", "dropped"]);
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
