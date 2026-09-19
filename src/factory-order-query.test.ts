import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  appendOrderEvent,
  claimOrder,
  queueOrder,
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

const claim = { runId: "run-1", agentId: "agent-1", station: "dim-station-build" };

describe("factory order query", () => {
  test("returns one unified status row with the latest lifecycle and evidence", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    queueOrder(
      db,
      {
        id: "order-status",
        project: "cniska/dim-factory",
        title: "Report one order's status",
      },
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-status", claim, "2026-09-18T10:01:00.000Z");
    recordOrderCommit(db, "order-status", trunk.sha, "feat: status", "2026-09-18T10:02:00.000Z");
    // Two commits recorded at one instant, the later one sorting below the earlier as a
    // string: the row reported is the one recorded last, never whichever sha reads highest.
    recordOrderCommit(db, "order-status", "fff111", "feat: middle", "2026-09-18T10:02:00.000Z");
    recordOrderCommit(db, "order-status", "aaa222", "feat: later", "2026-09-18T10:02:00.000Z");
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
      trunk.dir,
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
      "project",
      "order_id",
      "priority",
      "status",
      "latest_event",
      "latest_event_at",
      "hold",
      "station",
      "commit",
      "check",
      "findings",
      "stop",
    ]);
    expect(result?.rows).toEqual([
      [
        "cniska/dim-factory",
        "order-status",
        "unset",
        "completed",
        "completed",
        "2026-09-18T10:05:00.000Z",
        "(none)",
        "dim-station-build",
        "aaa222 feat: later",
        "bun run test (0, green)",
        "tests: fixed - holds; docs: fixed - updated",
        "verified",
      ],
    ]);
    expect(result?.denominator).toContain("factory order");
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

  test("shows explicit absence when a failed order has no reason", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    queueOrder(db, {
      id: "order-blocked",
      project: "cniska/dim-factory",
      title: "Block on another order",
    });
    claimOrder(db, "order-blocked", claim);
    appendOrderEvent(db, "order-blocked", { kind: "failed" });

    const result = findQuery("factory")?.run(db, { arg: "order-blocked" });

    expect(result?.rows[0]?.[3]).toBe("queued");
    expect(result?.rows[0]?.[4]).toBe("failed");
    expect(result?.rows[0]?.[11]).toBe("(none)");

    queueOrder(db, {
      id: "order-held",
      project: "cniska/dim-factory",
      title: "Stop at a hold",
    });
    claimOrder(db, "order-held", claim);
    appendOrderEvent(db, "order-held", {
      kind: "failed",
      holdType: "owner-judgment",
      reason: "ambiguous scope",
    });
    const held = findQuery("factory")?.run(db, { arg: "order-held" });
    expect(held?.rows[0]?.[11]).toBe("owner-judgment: ambiguous scope");
    db.close();
  });

  test("returns the aggregate and every evidence kind by order prefix", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    queueOrder(
      db,
      {
        id: "order-123",
        project: "cniska/dim-factory",
        title: "Read the detailed report",
      },
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-123", claim, "2026-09-18T10:00:30.000Z");
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
    expect(result?.rows[0]?.[4]).toBe("cniska/dim-factory/order-123");
    expect(result?.rows.find((row) => row[0] === "file")?.slice(4)).toEqual([
      "src/factory-order.ts",
      "+12 -3",
    ]);
    expect(result?.denominator).toContain("order order-123: working");
    db.close();
  });

  test("reports the signal that killed a hook where it left no exit code", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    queueOrder(
      db,
      {
        id: "order-killed",
        project: "cniska/dim-factory",
        title: "Teardown hook killed",
      },
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-killed", claim, "2026-09-18T10:00:30.000Z");
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
    expect(result?.denominator).toContain("factory order");
    expect(result?.note).toBe("no factory orders are recorded");
    db.close();
  });
});
