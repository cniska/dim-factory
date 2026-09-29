import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { SCHEMA_SQL } from "./db-schema";
import { attemptIn, integratedRepo, located, ranCheck, reviewIn, workerIn } from "./fixtures.test-support";
import { recordShipRun } from "./order";
import { approveOrder } from "./order-approval";
import { recordOrderBuild, recordOrderPlan } from "./order-artifacts";
import {
  recordOrderCheck,
  recordOrderCommit,
  recordOrderEnvironment,
  recordOrderFile,
  recordOrderProof,
} from "./order-evidence";
import { answerOrderFindings, raiseOrderFinding } from "./order-finding";
import { appendOrderEvent } from "./order-ledger";
import { dropOrder, queueOrder, startOrder } from "./order-lifecycle";
import { closeOrderReview } from "./order-review";
import type { QueryContext } from "./query";
import { findQuery } from "./query-registry";
import { capRows, DEFAULT_MAX_ROWS } from "./query-row-cap";
import { approveFinalBuildAt, approveReviewAt } from "./station-approvals.test-support";

const ctx: QueryContext = { home: "/h", maxRows: 40 };

const boardRow = (db: Database, id: string) =>
  findQuery("factory")
    ?.run(db, ctx)
    .rows.find((row) => row[1] === id);

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
  test("shows the current next act for queued, running, and terminal orders", () => {
    const db = floor();
    queueOrder(db, { id: "queued", project: "cniska/dim-factory", title: "Queued" }, attemptOperator);
    const row = (id: string) =>
      findQuery("order")
        ?.run(db, { ...ctx, arg: id })
        .rows[0]?.slice(3);
    expect(row("queued")).toEqual([
      "queued",
      "run at plan",
      "cniska/dim-factory/queued",
      "unset",
      "feat",
      "Queued",
      null,
    ]);

    building(db, "queued");
    recordOrderPlan(db, "queued", "Build the result.", worker, [
      { title: "Build", outcome: "The result is built." },
    ]);
    expect(row("queued")).toEqual([
      "running",
      "approve at plan",
      "cniska/dim-factory/queued",
      "unset",
      "feat",
      "Queued",
      null,
    ]);
    approveOrder(db, "queued", attemptOperator, undefined);
    expect(row("queued")).toEqual([
      "running",
      "run at build",
      "cniska/dim-factory/queued",
      "unset",
      "feat",
      "Queued",
      null,
    ]);

    attemptIn(db, "queued", worker, attemptOperator, "run-2");
    recordOrderCommit(db, "queued", trunk.sha, worker, "feat: result");
    approveFinalBuildAt(db, "queued", trunk.sha, worker, attemptOperator);
    approveReviewAt(db, "queued", trunk.sha, attemptOperator);
    expect(row("queued")).toEqual([
      "running",
      "ship",
      "cniska/dim-factory/queued",
      "unset",
      "feat",
      "Queued",
      null,
    ]);
    recordShipRun(db, "queued", { outcome: "landed" });
    expect(row("queued")).toEqual([
      "shipped",
      "(none)",
      "cniska/dim-factory/queued",
      "unset",
      "feat",
      "Queued",
      null,
    ]);

    queueOrder(db, { id: "dropped", project: "cniska/dim-factory", title: "Dropped" }, attemptOperator);
    dropOrder(db, "dropped", "superseded", attemptOperator);
    expect(row("dropped")).toEqual([
      "dropped",
      "(none)",
      "cniska/dim-factory/dropped",
      "unset",
      "feat",
      "Dropped",
      null,
    ]);
    expect(
      findQuery("order")
        ?.run(db, { ...ctx, arg: "dropped" })
        .rows.find((item) => item[2] === "dropped")
        ?.slice(3),
    ).toEqual(["", null, "", "superseded", null, null, null]);
    db.close();
  });

  test("reports a finding unanswered until the builder answers it", () => {
    const db = floor();
    queueOrder(db, { id: "order-reopened", project: "cniska/dim-factory", title: "Reopen" }, attemptOperator);
    building(db, "order-reopened");
    const first = reviewIn(db, "order-reopened");
    const finding = raiseOrderFinding(
      db,
      "order-reopened",
      located({ dimension: "tests", failure: "no test" }),
      first.reviewer,
    );
    closeOrderReview(db, first.review, "closed");
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
        ?.run(db, { ...ctx, arg: "order-reopened" })
        .rows.filter((row) => row[0] === "finding")
        .map((row) => [row[2], row[3]]),
      factory: boardRow(db, "order-reopened")?.[9],
    });
    expect(reported()).toEqual({
      order: [["finding_raised", "unanswered"]],
      factory: "tests: unanswered - no test",
    });
    answer("run-1");
    expect(reported()).toEqual({ order: [["finding_answered", "fixed"]], factory: "tests: fixed - no test" });
    db.close();
  });

  test("lists each order's findings on its own row", () => {
    const db = floor();
    for (const [id, dimension, answered] of [
      ["order-left", "tests", true],
      ["order-right", "docs", false],
    ] as const) {
      queueOrder(db, { id, project: "cniska/dim-factory", title: id }, attemptOperator);
      building(db, id);
      const round = reviewIn(db, id);
      const finding = raiseOrderFinding(db, id, located({ dimension, failure: `${id} gap` }), round.reviewer);
      closeOrderReview(db, round.review, "closed");
      if (answered) {
        answerOrderFindings(db, id, `build-${id}`, [{ finding, answer: "fixed", resolution: null }], worker);
      }
    }
    queueOrder(db, { id: "order-clean", project: "cniska/dim-factory", title: "clean" }, attemptOperator);

    const rows = findQuery("factory")?.run(db, ctx).rows ?? [];

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
      attemptOperator,
      "2026-09-18T10:00:00.000Z",
    );
    building(db, "order-status", "2026-09-18T10:01:00.000Z");
    recordOrderCommit(db, "order-status", trunk.sha, worker, "feat: status", "2026-09-18T10:02:00.000Z");
    recordOrderCommit(db, "order-status", "fff111", worker, "feat: middle", "2026-09-18T10:02:00.000Z");
    recordOrderCommit(db, "order-status", "aaa222", worker, "feat: later", "2026-09-18T10:02:00.000Z");
    recordOrderCheck(
      db,
      "order-status",
      ranCheck({ command: "bun run verify", exitCode: 0, result: "green" }, "2026-09-18T10:03:00.000Z"),
      "aaa222",
      "2026-09-18T10:03:00.000Z",
    );
    recordOrderCheck(
      db,
      "order-status",
      ranCheck({ command: "bun run test", exitCode: 0, result: "green" }, "2026-09-18T10:03:00.000Z"),
      "aaa222",
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
      ranCheck({ command: "bun run focused", exitCode: 0, result: "green" }, "2026-09-18T09:58:00.000Z"),
      "late-event",
      "2026-09-18T09:58:00.000Z",
    );
    const reviewer = reviewIn(db, "order-status", "2026-09-18T10:03:30.000Z").reviewer;
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
    recordShipRun(db, "order-status", { outcome: "landed" }, "2026-09-18T10:05:00.000Z");

    const before = [
      "factory_order",
      "factory_order_event",
      "factory_order_commit",
      "factory_order_file",
      "factory_order_check",
      "factory_order_finding",
      "factory_order_finding_answer",
    ].map((table) => db.query(`SELECT * FROM ${table} ORDER BY 1`).all());
    const result = findQuery("factory")?.run(db, ctx);

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
    ]);
    expect(result?.rows).toEqual([
      [
        "cniska/dim-factory",
        "order-status",
        "unset",
        "shipped",
        "finding_answered",
        "2026-09-18T10:04:00.000Z",
        "(none)",
        "late-event feat: event order wins",
        "bun run focused (0, green)",
        "tests: fixed - holds; docs: fixed - updated",
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
    ].map((table) => db.query(`SELECT * FROM ${table} ORDER BY 1`).all());
    expect(after).toEqual(before);
    db.close();
  });

  test("keeps failure reasons in the order record rather than the factory summary", () => {
    const db = floor();
    queueOrder(
      db,
      {
        id: "order-blocked",
        project: "cniska/dim-factory",
        title: "Block on another order",
      },
      attemptOperator,
    );
    building(db, "order-blocked");
    appendOrderEvent(db, "order-blocked", {
      worker,
      kind: "failed",
      station: "build",
      reason: "the check never passed",
    });

    const result = findQuery("factory")?.run(db, ctx);
    const blocked = boardRow(db, "order-blocked");

    expect(blocked?.[3]).toBe("running");
    expect(blocked?.[4]).toBe("failed");
    expect(blocked?.[6]).toBe("run at plan");
    expect(result?.columns).not.toContain("stop");

    queueOrder(
      db,
      {
        id: "order-reasoned",
        project: "cniska/dim-factory",
        title: "Fail with a reason",
      },
      attemptOperator,
    );
    building(db, "order-reasoned");
    appendOrderEvent(db, "order-reasoned", {
      worker,
      kind: "failed",
      station: "build",
      reason: "ambiguous scope",
    });
    expect(boardRow(db, "order-reasoned")).toHaveLength(10);
    expect(
      findQuery("order")
        ?.run(db, { ...ctx, arg: "order-reasoned" })
        .rows.find((row) => row[2] === "failed")?.[6],
    ).toBe("ambiguous scope");
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
      attemptOperator,
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
    recordOrderProof(
      db,
      "order-123",
      {
        ...ranCheck({ command: "bun run verify", exitCode: 1, result: "red" }, "2026-09-18T10:01:45.000Z"),
        baseSha: "base",
        paths: ["src/a.test.ts", "src/b c.test.ts"],
      },
      "abc",
      "2026-09-18T10:01:45.000Z",
    );
    recordOrderCheck(
      db,
      "order-123",
      ranCheck({ command: "bun run verify", exitCode: 0, result: "green" }, "2026-09-18T10:02:00.000Z"),
      "abc",
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
      reviewIn(db, "order-123", "2026-09-18T10:02:30.000Z").reviewer,
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
    const result = findQuery("order")?.run(db, { ...ctx, arg: "order-12" });
    expect(result?.columns).toEqual([
      "section",
      "when",
      "kind",
      "status",
      "next",
      "subject",
      "evidence",
      "line",
      "title",
      "description",
    ]);
    expect(result?.rows.map((row) => row[0])).toEqual([
      "order",
      "environment",
      "finding",
      "event",
      "event",
      "artifact",
      "event",
      "check",
      "proof",
      "file",
      "commit",
      "event",
      "attempt",
      "event",
      "event",
      "event",
    ]);
    expect(result?.rows[1]).toEqual([
      "environment",
      "2026-09-18T10:05:00.000Z",
      "environment_reported",
      "0",
      null,
      "setup",
      '[{"port":5433}]',
      null,
      null,
      null,
    ]);
    expect(result?.rows[0]?.slice(3)).toEqual([
      "running",
      "run at plan",
      "cniska/dim-factory/order-123",
      "unset",
      "feat",
      "Read the detailed report",
      null,
    ]);
    expect(result?.rows?.every((row) => row.length === result.columns.length)).toBe(true);
    expect(result?.rows?.slice(1).every((row) => row[4] === null)).toBe(true);
    expect(result?.rows.find((row) => row[0] === "artifact")?.slice(3)).toEqual([
      "1",
      null,
      `${worker} @ abc`,
      "The report is built and verified.",
      null,
      null,
      null,
    ]);
    expect(result?.rows.find((row) => row[0] === "finding")?.slice(3)).toEqual([
      "fixed",
      null,
      "tests",
      "holds",
      null,
      null,
      null,
    ]);
    expect(result?.rows.find((row) => row[0] === "proof")?.slice(2)).toEqual([
      "proof_ran",
      "1",
      null,
      "bun run verify over src/a.test.ts, src/b c.test.ts on base for abc",
      "red",
      null,
      null,
      null,
    ]);
    expect(result?.rows.find((row) => row[0] === "file")?.slice(5)).toEqual([
      "src/factory-order.ts",
      "+12 -3",
      null,
      null,
      null,
    ]);
    expect(result?.denominator).toContain("order order-123: running");
    db.close();
  });

  test("carries the order's line, title and description on the first row alone", () => {
    const db = floor();
    queueOrder(
      db,
      {
        id: "order-described",
        project: "cniska/dim-factory",
        title: "Show the title",
        line: "fix",
        description: "The first row has no title.",
      },
      attemptOperator,
    );
    queueOrder(db, { id: "order-bare", project: "cniska/dim-factory", title: "Bare" }, attemptOperator);
    building(db, "order-described");
    const described = findQuery("order")?.run(db, { ...ctx, arg: "order-described" });
    expect(described?.columns.slice(7)).toEqual(["line", "title", "description"]);
    expect(described?.rows[0]?.[2]).toBe("report");
    expect(described?.rows[0]?.slice(7)).toEqual(["fix", "Show the title", "The first row has no title."]);
    expect(described?.rows.length).toBeGreaterThan(1);
    expect(described?.rows.slice(1).every((row) => row.slice(7).every((cell) => cell === null))).toBe(true);
    expect(
      findQuery("order")
        ?.run(db, { ...ctx, arg: "order-bare" })
        .rows[0]?.slice(7),
    ).toEqual(["feat", "Bare", null]);
    db.close();
  });

  test("shows the newest evidence first, so the row cap keeps the latest", () => {
    const db = floor();
    queueOrder(
      db,
      { id: "order-long", project: "cniska/dim-factory", title: "Long" },
      attemptOperator,
      "2026-09-18T09:00:00.000Z",
    );
    building(db, "order-long", "2026-09-18T09:00:30.000Z");
    for (let minute = 10; minute < 55; minute++) {
      const at = `2026-09-18T10:${minute}:00.000Z`;
      recordOrderCheck(
        db,
        "order-long",
        ranCheck({ command: `check ${minute}`, exitCode: 0 }, at),
        "abc",
        at,
      );
    }
    const tie = "2026-09-18T11:00:00.000Z";
    recordOrderCheck(db, "order-long", ranCheck({ command: "tie first", exitCode: 0 }, tie), "abc", tie);
    recordOrderCheck(db, "order-long", ranCheck({ command: "tie second", exitCode: 0 }, tie), "abc", tie);

    const result = findQuery("order")?.run(db, { ...ctx, arg: "order-long" });
    const rows = result?.rows ?? [];
    expect(rows[0]?.[0]).toBe("order");
    const evidence = rows.slice(1);
    const whens = evidence.map((row) => String(row[1]));
    expect(whens).toEqual([...whens].sort().reverse());
    expect(evidence.slice(0, 2).map((row) => row[5])).toEqual([
      "check 47: tie second at abc",
      "check 46: tie first at abc",
    ]);
    expect(evidence.at(-1)?.[2]).toBe("queued");
    const capped = capRows(rows, DEFAULT_MAX_ROWS).rows;
    expect(capped[0]?.[0]).toBe("order");
    expect(capped[1]?.[5]).toBe("check 47: tie second at abc");
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
      attemptOperator,
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

    const result = findQuery("order")?.run(db, { ...ctx, arg: "order-killed" });

    expect(result?.rows[1]).toEqual([
      "environment",
      "2026-09-18T10:05:00.000Z",
      "environment_reported",
      "SIGKILL",
      null,
      "teardown",
      "[]",
      null,
      null,
      null,
    ]);
    db.close();
  });

  test("does not turn an unknown order into an empty report", () => {
    const db = floor();
    const result = findQuery("order")?.run(db, { ...ctx, arg: "missing" });
    expect(result?.rows).toEqual([]);
    expect(result?.note).toBe("no order starts with missing");
    db.close();
  });

  test("refuses a missing id and an ambiguous prefix as usage errors", () => {
    const db = floor();
    queueOrder(db, { id: "overlap-one", project: "cniska/dim-factory", title: "One" }, attemptOperator);
    queueOrder(db, { id: "overlap-two", project: "cniska/dim-factory", title: "Two" }, attemptOperator);
    expect(() => findQuery("order")?.run(db, ctx)).toThrow(
      expect.objectContaining({ code: "usage", message: "usage: dim q order <order-id>" }),
    );
    expect(() => findQuery("order")?.run(db, { ...ctx, arg: "overlap" })).toThrow(
      expect.objectContaining({ code: "usage", message: "overlap matches more than one order" }),
    );
    db.close();
  });

  test("reports an empty floor as no rows, and refuses an order id", () => {
    const db = floor();

    const result = findQuery("factory")?.run(db, ctx);

    expect(result?.rows).toEqual([]);
    expect(result?.denominator).toBe("0 factory orders read from factory_order");
    expect(() => findQuery("factory")?.run(db, { ...ctx, arg: "order-1" })).toThrow(
      expect.objectContaining({ code: "usage" }),
    );
    db.close();
  });
});
