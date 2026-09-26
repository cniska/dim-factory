import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { SCHEMA_SQL } from "./db-schema";
import { attemptIn, integratedRepo, located, reviewIn, workerIn } from "./fixtures.test-support";
import { recordOrderBuild } from "./order-artifacts";
import {
  recordOrderCheck,
  recordOrderCommit,
  recordOrderDocument,
  recordOrderEnvironment,
  recordOrderFile,
} from "./order-evidence";
import { answerOrderFindings, raiseOrderFinding, ruleOnOrderFinding } from "./order-finding";
import { appendOrderEvent } from "./order-ledger";
import { queueOrder, startOrder } from "./order-lifecycle";
import { closeOrderReview } from "./order-review";
import { findQuery } from "./query-registry";

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

function building(db: Database, orderId: string, at?: string): void {
  startOrder(db, orderId, attemptOperator, at, trunk.dir);
  attemptIn(db, orderId, worker, attemptOperator, "run-1", at);
}

describe("factory order query", () => {
  test("reports a finding a later round found not addressed as unanswered until it is answered again", () => {
    const db = floor();
    queueOrder(db, { id: "order-reopened", project: "cniska/dim-factory", title: "Reopen" }, worker);
    building(db, "order-reopened");
    const first = reviewIn(db, "order-reopened", worker);
    const finding = raiseOrderFinding(
      db,
      "order-reopened",
      located({ dimension: "tests", failure: "no test" }),
      first.reviewer,
    );
    closeOrderReview(db, first.review, "closed", first.reviewer);
    const answer = (run: string) =>
      answerOrderFindings(
        db,
        "order-reopened",
        run,
        [{ finding, answer: "fixed", resolution: null }],
        worker,
      );
    const reported = () => ({
      order: findQuery("order")
        ?.run(db, { arg: "order-reopened" })
        .rows.filter((row) => row[0] === "finding")
        .map((row) => [row[2], row[3]]),
      factory: findQuery("factory")?.run(db, { arg: "order-reopened" }).rows[0]?.[9],
    });
    answer("run-1");
    expect(reported()).toEqual({ order: [["finding_answered", "fixed"]], factory: "tests: fixed - no test" });
    const second = reviewIn(db, "order-reopened", worker);
    ruleOnOrderFinding(db, finding, { ruling: "not_addressed", reason: "still none" }, second.reviewer);
    closeOrderReview(db, second.review, "closed", second.reviewer);
    expect(reported()).toEqual({
      order: [["finding_raised", "unanswered"]],
      factory: "tests: unanswered - no test",
    });
    answer("run-2");
    expect(reported()).toEqual({ order: [["finding_answered", "fixed"]], factory: "tests: fixed - no test" });
    db.close();
  });

  test("lists each order's findings on its own row", () => {
    const db = floor();
    for (const [id, dimension, answered] of [
      ["order-left", "tests", true],
      ["order-right", "docs", false],
    ] as const) {
      queueOrder(db, { id, project: "cniska/dim-factory", title: id }, worker);
      building(db, id);
      const round = reviewIn(db, id, worker);
      const finding = raiseOrderFinding(db, id, located({ dimension, failure: `${id} gap` }), round.reviewer);
      closeOrderReview(db, round.review, "closed", round.reviewer);
      if (answered) {
        answerOrderFindings(db, id, `build-${id}`, [{ finding, answer: "fixed", resolution: null }], worker);
      }
    }
    queueOrder(db, { id: "order-clean", project: "cniska/dim-factory", title: "clean" }, worker);

    const rows = findQuery("factory")?.run(db, {}).rows ?? [];

    expect(Object.fromEntries(rows.map((row) => [row[1], row[9]]))).toEqual({
      "order-left": "tests: fixed - order-left gap",
      "order-right": "docs: unanswered - order-right gap",
      "order-clean": "(none recorded)",
    });
    db.close();
  });

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
    building(db, "order-status", "2026-09-18T10:01:00.000Z");
    recordOrderCommit(db, "order-status", trunk.sha, worker, "feat: status", "2026-09-18T10:02:00.000Z");
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
    for (const [dimension, failure] of [
      ["tests", "holds"],
      ["docs", "updated"],
    ] as const) {
      const raised = raiseOrderFinding(
        db,
        "order-status",
        located({ dimension, failure }),
        reviewer,
        "2026-09-18T10:04:00.000Z",
      );
      answerOrderFindings(
        db,
        "order-status",
        "run",
        [{ finding: raised, answer: "fixed", resolution: null }],
        worker,
        "2026-09-18T10:04:00.000Z",
      );
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
      "factory_order_finding_answer",
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
      "next",
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
      "factory_order_finding_answer",
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
    building(db, "order-blocked");
    appendOrderEvent(db, "order-blocked", { worker, kind: "failed" });

    const result = findQuery("factory")?.run(db, { arg: "order-blocked" });

    expect(result?.rows[0]?.[3]).toBe("working");
    expect(result?.rows[0]?.[4]).toBe("failed");
    expect(result?.rows[0]?.[6]).toBe("run at plan");
    expect(result?.rows[0]?.[10]).toBe("(none)");

    queueOrder(
      db,
      {
        id: "order-reasoned",
        project: "cniska/dim-factory",
        title: "Fail with a reason",
      },
      worker,
    );
    building(db, "order-reasoned");
    appendOrderEvent(db, "order-reasoned", {
      worker,
      kind: "failed",
      reason: "ambiguous scope",
    });
    const reasoned = findQuery("factory")?.run(db, { arg: "order-reasoned" });
    expect(reasoned?.rows[0]?.[10]).toBe("ambiguous scope");
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
    building(db, "order-123", "2026-09-18T10:00:30.000Z");
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
      located({ dimension: "tests", failure: "holds" }),
      reviewIn(db, "order-123", worker, "2026-09-18T10:02:30.000Z").reviewer,
      "2026-09-18T10:03:00.000Z",
    );
    answerOrderFindings(
      db,
      "order-123",
      "run",
      [{ finding: raised, answer: "fixed", resolution: null }],
      worker,
      "2026-09-18T10:03:00.000Z",
    );
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
    expect(result?.rows[0]?.[5]).toBe("unset | run at plan");
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
    building(db, "order-killed", "2026-09-18T10:00:30.000Z");
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
