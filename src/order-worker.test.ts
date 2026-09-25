import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { queueOrder } from "./factory-order";
import { mintWorker } from "./factory-worker";
import { bindOrderWorker, ensureOrderWorker } from "./order-worker";
import { SCHEMA_SQL } from "./schema";
import { bootstrapWorker } from "./worker-assignment";

function floor() {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  const operator = mintWorker(db, { role: "operator", sessionId: "operator-session" });
  queueOrder(db, { id: "order-1", project: "owner/repo", title: "Work" }, operator.name);
  return { db, operator: operator.name };
}

function harnessOf(db: Database): unknown {
  return db.query("SELECT harness FROM factory_order_worker WHERE order_id = 'order-1'").get();
}

describe("an order's station worker", () => {
  test("records the harness its first delegation named", () => {
    const { db, operator } = floor();

    ensureOrderWorker(db, "order-1", "builder", operator, "claude");

    expect(harnessOf(db)).toEqual({ harness: "claude" });
  });

  test("moves to another harness while no provider session is bound to it", () => {
    const { db, operator } = floor();
    ensureOrderWorker(db, "order-1", "builder", operator, "codex");

    ensureOrderWorker(db, "order-1", "builder", operator, "claude");

    expect(harnessOf(db)).toEqual({ harness: "claude" });
  });

  test("refuses another harness once its provider session is bound, since only its own harness can resume it", () => {
    const { db, operator } = floor();
    const first = ensureOrderWorker(db, "order-1", "builder", operator, "claude");
    const minted = bootstrapWorker(db, {
      id: first.assignment.id,
      token: first.assignment.token,
      sessionId: "claude-session",
    });
    bindOrderWorker(db, "order-1", "builder", first.assignment.id, minted);

    expect(() => ensureOrderWorker(db, "order-1", "builder", operator, "codex")).toThrow(
      "order order-1 builder runs under the claude harness; delegate it with --harness claude",
    );
    expect(ensureOrderWorker(db, "order-1", "builder", operator, "claude").worker).toBe(minted.name);
  });

  test("refuses another harness once its worker bootstrapped, before the order row is bound", () => {
    const { db, operator } = floor();
    const first = ensureOrderWorker(db, "order-1", "builder", operator, "claude");
    bootstrapWorker(db, {
      id: first.assignment.id,
      token: first.assignment.token,
      sessionId: "claude-session",
    });

    expect(() => ensureOrderWorker(db, "order-1", "builder", operator, "codex")).toThrow(
      "order order-1 builder runs under the claude harness; delegate it with --harness claude",
    );
  });
});
