import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { claimOrder, queueOrder, recordOrderPlan } from "./factory-order";
import { mintWorker, WORKER_NAME_VAR, WORKER_SESSION_VAR, WORKER_TOKEN_VAR } from "./factory-worker";
import { integratedRepo } from "./fixtures.test-support";
import { runOrderCommand } from "./order-command";
import { SCHEMA_SQL } from "./schema";

const repos: string[] = [];
afterAll(() => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
});

function env(worker: { name: string; token: string; sessionId: string }): Record<string, string> {
  return {
    [WORKER_NAME_VAR]: worker.name,
    [WORKER_TOKEN_VAR]: worker.token,
    [WORKER_SESSION_VAR]: worker.sessionId,
  };
}

describe("plan approval integration", () => {
  test("records operator approval after an attributed plan submission", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const repo = integratedRepo();
    repos.push(repo.dir);
    const operator = mintWorker(db, { role: "operator", sessionId: "operator-session" });
    const planner = mintWorker(db, {
      role: "planner",
      parentWorker: operator.name,
      sessionId: "operator-session/planner-session",
    });
    queueOrder(
      db,
      { id: "approval-order", project: "cniska/dim-factory", title: "Approve this" },
      operator.name,
    );
    claimOrder(
      db,
      "approval-order",
      { runId: "run-1", station: "dim-station-plan" },
      operator.name,
      undefined,
      repo.dir,
    );
    recordOrderPlan(db, "approval-order", "## Build\n\nMake the smallest change.", planner.name);

    expect(runOrderCommand(db, ["approve", "approval-order"], null, repo.dir, env(operator))).toContain(
      "plan approved",
    );
    expect(
      db.query("SELECT kind, worker FROM factory_order_event WHERE order_id = ?").all("approval-order"),
    ).toEqual([
      { kind: "queued", worker: operator.name },
      { kind: "claimed", worker: operator.name },
      { kind: "plan_submitted", worker: planner.name },
      { kind: "plan_approved", worker: operator.name },
    ]);
    db.close();
  });

  test("refuses a plan approval from a non-operator worker", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const repo = integratedRepo();
    repos.push(repo.dir);
    const operator = mintWorker(db, { role: "operator", sessionId: "operator-session-2" });
    const builder = mintWorker(db, {
      role: "builder",
      parentWorker: operator.name,
      sessionId: "operator-session-2/builder-session",
    });
    queueOrder(
      db,
      { id: "approval-order-2", project: "cniska/dim-factory", title: "Approve this" },
      operator.name,
    );
    claimOrder(
      db,
      "approval-order-2",
      { runId: "run-2", station: "dim-station-plan" },
      operator.name,
      undefined,
      repo.dir,
    );
    recordOrderPlan(db, "approval-order-2", "## Build\n\nMake the smallest change.", operator.name);

    expect(() => runOrderCommand(db, ["approve", "approval-order-2"], null, repo.dir, env(builder))).toThrow(
      expect.objectContaining({ code: "worker_not_operator" }),
    );
    expect(
      db.query("SELECT count(*) AS n FROM factory_order_event WHERE kind = 'plan_approved'").get(),
    ).toEqual({
      n: 0,
    });
    db.close();
  });
});
