import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  appendOrderEvent,
  createOrder,
  recordOrderCheck,
  recordOrderCommit,
  recordOrderDocument,
  recordOrderEnvironment,
  recordOrderFile,
  recordOrderFinding,
} from "./factory-order";
import { integratedRepo } from "./fixtures.test-support";
import { findQuery } from "./queries";
import { SCHEMA_SQL } from "./schema";

const trunk = integratedRepo();
afterAll(() => rmSync(trunk.dir, { recursive: true, force: true }));

describe("factory order query", () => {
  test("returns one unified status row with the latest lifecycle and evidence", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createOrder(
      db,
      {
        id: "order-status",
        runId: "run-1",
        queueId: "queue-1",
        itemId: "item-1",
        title: "Report one order's status",
        worktree: trunk.dir,
        branch: "factory-item",
        station: "dim-station-build",
      },
      "2026-09-18T10:00:00.000Z",
    );
    appendOrderEvent(db, "order-status", { kind: "started", status: "running" }, "2026-09-18T10:01:00.000Z");
    recordOrderCommit(db, "order-status", trunk.sha, "feat: status", "2026-09-18T10:02:00.000Z");
    recordOrderCommit(db, "order-status", "def456", "feat: later", "2026-09-18T10:02:00.000Z");
    recordOrderCheck(
      db,
      "order-status",
      { command: "bun run verify", exitCode: 0, result: "green" },
      "2026-09-18T10:03:00.000Z",
    );
    recordOrderCheck(
      db,
      "order-status",
      { command: "bun run test", exitCode: 0, result: "green" },
      "2026-09-18T10:03:00.000Z",
    );
    recordOrderFinding(
      db,
      "order-status",
      { dimension: "tests", summary: "holds", answer: "fixed" },
      "2026-09-18T10:04:00.000Z",
    );
    recordOrderFinding(
      db,
      "order-status",
      { dimension: "docs", summary: "updated", answer: "fixed" },
      "2026-09-18T10:04:00.000Z",
    );
    appendOrderEvent(
      db,
      "order-status",
      { kind: "completed", status: "completed", reason: "verified" },
      "2026-09-18T10:05:00.000Z",
    );

    const before = [
      "factory_order",
      "factory_order_event",
      "factory_order_commit",
      "factory_order_file",
      "factory_order_check",
      "factory_order_finding",
      "factory_order_document",
    ].map((table) => db.query(`SELECT * FROM ${table} ORDER BY 1`).all());
    const result = findQuery("factory")?.run(db, { arg: "order-st" });

    expect(result?.columns).toEqual([
      "queue",
      "item",
      "order",
      "status",
      "latest_event",
      "latest_event_at",
      "worktree",
      "branch",
      "station",
      "commit",
      "check",
      "findings",
      "stop",
    ]);
    expect(result?.rows).toEqual([
      [
        "queue-1",
        "item-1",
        "order-status",
        "completed",
        "completed",
        "2026-09-18T10:05:00.000Z",
        trunk.dir,
        "factory-item",
        "dim-station-build",
        "def456 feat: later",
        "bun run test (0, green)",
        "tests: fixed - holds; docs: fixed - updated",
        "verified",
      ],
    ]);
    expect(result?.denominator).toContain("queue planner source absent");
    const after = [
      "factory_order",
      "factory_order_event",
      "factory_order_commit",
      "factory_order_file",
      "factory_order_check",
      "factory_order_finding",
      "factory_order_document",
    ].map((table) => db.query(`SELECT * FROM ${table} ORDER BY 1`).all());
    expect(after).toEqual(before);
    db.close();
  });

  test("shows explicit absence when a blocked order has no fence or reason", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createOrder(db, {
      id: "order-blocked",
      runId: "run-1",
      queueId: "queue-1",
      itemId: "item-1",
      title: "Block on another item",
    });
    appendOrderEvent(db, "order-blocked", { kind: "blocked", status: "blocked" });

    const result = findQuery("factory")?.run(db, { arg: "order-blocked" });

    expect(result?.rows[0]?.[3]).toBe("blocked");
    expect(result?.rows[0]?.[4]).toBe("blocked");
    expect(result?.rows[0]?.[12]).toBe("(none)");

    createOrder(db, {
      id: "order-fenced",
      runId: "run-1",
      queueId: "queue-1",
      itemId: "item-2",
      title: "Stop at a fence",
    });
    appendOrderEvent(db, "order-fenced", {
      kind: "fenced",
      status: "fenced",
      fenceType: "owner-judgment",
      reason: "ambiguous scope",
    });
    const fenced = findQuery("factory")?.run(db, { arg: "order-fenced" });
    expect(fenced?.rows[0]?.[12]).toBe("owner-judgment: ambiguous scope");
    db.close();
  });

  test("returns the aggregate and every evidence kind by order prefix", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createOrder(
      db,
      {
        id: "order-123",
        runId: "run-1",
        queueId: "queue-1",
        itemId: "item-1",
        title: "Read the detailed report",
        station: "dim-station-build",
      },
      "2026-09-18T10:00:00.000Z",
    );
    appendOrderEvent(db, "order-123", { kind: "started", status: "running" }, "2026-09-18T10:00:30.000Z");
    recordOrderCommit(db, "order-123", "abc", "feat: report", "2026-09-18T10:01:00.000Z");
    recordOrderFile(
      db,
      "order-123",
      { path: "src/factory-order.ts", added: 12, removed: 3 },
      "2026-09-18T10:01:30.000Z",
    );
    recordOrderCheck(
      db,
      "order-123",
      { command: "bun run verify", exitCode: 0, result: "green" },
      "2026-09-18T10:02:00.000Z",
    );
    recordOrderFinding(
      db,
      "order-123",
      { dimension: "tests", summary: "holds", answer: "fixed" },
      "2026-09-18T10:03:00.000Z",
    );
    recordOrderDocument(db, "order-123", "docs/factory.md", "2026-09-18T10:04:00.000Z");
    recordOrderEnvironment(
      db,
      "order-123",
      {
        phase: "setup",
        argv: ["/tmp/order-123/scripts/worktree-setup.sh"],
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        resources: [{ port: 5433 }],
      },
      "2026-09-18T10:05:00.000Z",
    );
    const result = findQuery("order")?.run(db, { arg: "order-12" });
    expect(result?.columns).toEqual(["section", "when", "kind", "status", "subject", "evidence"]);
    expect(result?.rows.map((row) => row[0])).toEqual([
      "order",
      "event",
      "event",
      "event",
      "commit",
      "file",
      "event",
      "check",
      "event",
      "finding",
      "document",
      "environment",
    ]);
    expect(result?.rows.at(-1)).toEqual([
      "environment",
      "2026-09-18T10:05:00.000Z",
      "environment_reported",
      "0",
      "setup",
      '[{"port":5433}]',
    ]);
    expect(result?.rows[0]?.[4]).toBe("run-1/queue-1/item-1");
    expect(result?.rows.find((row) => row[0] === "file")?.slice(4)).toEqual([
      "src/factory-order.ts",
      "+12 -3",
    ]);
    expect(result?.denominator).toContain("order order-123: running");
    db.close();
  });

  test("reports the signal that killed a hook where it left no exit code", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createOrder(
      db,
      {
        id: "order-killed",
        runId: "run-1",
        queueId: "queue-1",
        itemId: "item-1",
        title: "Teardown hook killed",
      },
      "2026-09-18T10:00:00.000Z",
    );
    appendOrderEvent(db, "order-killed", { kind: "started", status: "running" }, "2026-09-18T10:00:30.000Z");
    recordOrderEnvironment(
      db,
      "order-killed",
      {
        phase: "teardown",
        argv: ["/tmp/order-killed/scripts/worktree-teardown.sh"],
        exitCode: null,
        signal: "SIGKILL",
        stdout: "",
        stderr: "",
        resources: [],
      },
      "2026-09-18T10:05:00.000Z",
    );

    const result = findQuery("order")?.run(db, { arg: "order-killed" });

    expect(result?.rows.at(-1)).toEqual([
      "environment",
      "2026-09-18T10:05:00.000Z",
      "environment_reported",
      "SIGKILL",
      "teardown",
      "[]",
    ]);
    db.close();
  });

  test("does not turn an unknown order into an empty report", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const result = findQuery("order")?.run(db, { arg: "missing" });
    expect(result?.rows).toEqual([]);
    expect(result?.note).toBe("no order starts with missing");
    db.close();
  });

  test("reports absent queue planning without inventing queue rows", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);

    const result = findQuery("factory")?.run(db, {});

    expect(result?.rows).toEqual([]);
    expect(result?.denominator).toContain("queue planner source absent");
    expect(result?.note).toBe("no factory orders are recorded");
    db.close();
  });
});
