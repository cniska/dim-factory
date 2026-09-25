import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  answerOrderFinding,
  appendOrderEvent,
  claimOrder as claimOrderAt,
  type OrderClaim,
  queueOrder,
  raiseOrderFinding,
  recordOrderBuild,
  recordOrderCheck,
  recordOrderCommit,
  recordOrderDocument,
  recordOrderEnvironment,
  recordOrderFile,
} from "./factory-order";
import { integratedRepo, reviewIn, workerIn } from "./fixtures.test-support";
import { findQuery } from "./queries";
import { SCHEMA_SQL } from "./schema";

// One hand per database, set where the database is made: every moment names a worker,
// and what these tests are about is what the query reports rather than who touched it.
let worker = "";
let attemptOperator = "";

function floor(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  worker = workerIn(db);
  attemptOperator = workerIn(db, "operator");
  return db;
}

const trunk = integratedRepo();
afterAll(() => rmSync(trunk.dir, { recursive: true, force: true }));

// A claim now makes the worktree it names, so every direct call needs somewhere
// safe to make one — `trunk.dir` rather than this machine's own checkout.
function claimOrder(
  db: Database,
  orderId: string,
  given: Omit<OrderClaim, "operatorWorker">,
  who: string,
  at?: string,
): number {
  return claimOrderAt(db, orderId, { ...given, operatorWorker: attemptOperator }, who, at, trunk.dir);
}

const claim = { runId: "run-1", station: "dim-station-build" };

describe("factory order query", () => {
  test("returns one unified status row with the latest lifecycle and evidence", () => {
    const db = floor();
    queueOrder(
      db,
      {
        id: "order-status",
        project: "cniska/dim-factory",
        title: "Report one order's status",
      },
      worker,
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-status", claim, worker, "2026-09-18T10:01:00.000Z");
    recordOrderCommit(db, "order-status", trunk.sha, worker, "feat: status", "2026-09-18T10:02:00.000Z");
    // Two commits recorded at one instant, the later one sorting below the earlier as a
    // string: the row reported is the one recorded last, never whichever sha reads highest.
    recordOrderCommit(db, "order-status", "fff111", worker, "feat: middle", "2026-09-18T10:02:00.000Z");
    recordOrderCommit(db, "order-status", "aaa222", worker, "feat: later", "2026-09-18T10:02:00.000Z");
    recordOrderCheck(
      db,
      "order-status",
      { command: "bun run verify", exitCode: 0, result: "green" },
      worker,
      "2026-09-18T10:03:00.000Z",
    );
    recordOrderCheck(
      db,
      "order-status",
      { command: "bun run test", exitCode: 0, result: "green" },
      worker,
      "2026-09-18T10:03:00.000Z",
    );
    recordOrderCommit(
      db,
      "order-status",
      "late-event",
      worker,
      "feat: event order wins",
      "2026-09-18T09:59:00.000Z",
    );
    recordOrderCheck(
      db,
      "order-status",
      { command: "bun run focused", exitCode: 0, result: "green" },
      worker,
      "2026-09-18T09:58:00.000Z",
    );
    const reviewer = reviewIn(db, "order-status", worker, "2026-09-18T10:03:30.000Z").reviewer;
    for (const [dimension, summary] of [
      ["tests", "holds"],
      ["docs", "updated"],
    ] as const) {
      const raised = raiseOrderFinding(
        db,
        "order-status",
        { dimension, summary },
        reviewer,
        "2026-09-18T10:04:00.000Z",
      );
      answerOrderFinding(db, raised, { answer: "fixed" }, worker, "2026-09-18T10:04:00.000Z");
    }
    appendOrderEvent(
      db,
      "order-status",
      { worker, kind: "completed", status: "completed", reason: "verified" },
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
        "late-event feat: event order wins",
        "bun run focused (0, green)",
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
    const db = floor();
    queueOrder(
      db,
      {
        id: "order-blocked",
        project: "cniska/dim-factory",
        title: "Block on another order",
      },
      worker,
    );
    claimOrder(db, "order-blocked", claim, worker);
    appendOrderEvent(db, "order-blocked", { worker, kind: "failed" });

    const result = findQuery("factory")?.run(db, { arg: "order-blocked" });

    expect(result?.rows[0]?.[3]).toBe("queued");
    expect(result?.rows[0]?.[4]).toBe("failed");
    expect(result?.rows[0]?.[11]).toBe("(none)");

    queueOrder(
      db,
      {
        id: "order-held",
        project: "cniska/dim-factory",
        title: "Stop at a hold",
      },
      worker,
    );
    claimOrder(db, "order-held", claim, worker);
    appendOrderEvent(db, "order-held", {
      worker,
      kind: "failed",
      holdType: "owner-judgment",
      reason: "ambiguous scope",
    });
    const held = findQuery("factory")?.run(db, { arg: "order-held" });
    expect(held?.rows[0]?.[11]).toBe("owner-judgment: ambiguous scope");
    db.close();
  });

  test("returns the aggregate and every evidence kind by order prefix", () => {
    const db = floor();
    queueOrder(
      db,
      {
        id: "order-123",
        project: "cniska/dim-factory",
        title: "Read the detailed report",
      },
      worker,
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-123", claim, worker, "2026-09-18T10:00:30.000Z");
    recordOrderCommit(db, "order-123", "abc", worker, "feat: report", "2026-09-18T10:01:00.000Z");
    recordOrderFile(
      db,
      "order-123",
      { path: "src/factory-order.ts", added: 12, removed: 3 },
      worker,
      "2026-09-18T10:01:30.000Z",
    );
    recordOrderCheck(
      db,
      "order-123",
      { command: "bun run verify", exitCode: 0, result: "green" },
      worker,
      "2026-09-18T10:02:00.000Z",
    );
    recordOrderBuild(
      db,
      "order-123",
      "The report is built and verified.",
      "abc",
      worker,
      "2026-09-18T10:02:15.000Z",
    );
    const raised = raiseOrderFinding(
      db,
      "order-123",
      { dimension: "tests", summary: "holds" },
      reviewIn(db, "order-123", worker, "2026-09-18T10:02:30.000Z").reviewer,
      "2026-09-18T10:03:00.000Z",
    );
    answerOrderFinding(db, raised, { answer: "fixed" }, worker, "2026-09-18T10:03:00.000Z");
    recordOrderDocument(db, "order-123", "docs/factory.md", worker, "2026-09-18T10:04:00.000Z");
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
      "attempt",
      "event",
      "commit",
      "file",
      "event",
      "check",
      "event",
      "event",
      "artifact",
      "event",
      "event",
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
    const db = floor();
    queueOrder(
      db,
      {
        id: "order-killed",
        project: "cniska/dim-factory",
        title: "Teardown hook killed",
      },
      worker,
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-killed", claim, worker, "2026-09-18T10:00:30.000Z");
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
    const db = floor();
    const result = findQuery("order")?.run(db, { arg: "missing" });
    expect(result?.rows).toEqual([]);
    expect(result?.note).toBe("no order starts with missing");
    db.close();
  });

  test("reports absent queue planning without inventing queue rows", () => {
    const db = floor();

    const result = findQuery("factory")?.run(db, {});

    expect(result?.rows).toEqual([]);
    expect(result?.denominator).toContain("factory order");
    expect(result?.note).toBe("no factory orders are recorded");
    db.close();
  });
});
