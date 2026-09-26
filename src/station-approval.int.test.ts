import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "./db-schema";
import { integratedRepo } from "./fixtures.test-support";
import { scriptedHarness } from "./harness-scripted.test-support";
import { recordOrderPlan } from "./order-artifacts";
import { runOrderCommand, runOrderCommandLive } from "./order-command";
import { queueOrder, startOrder } from "./order-lifecycle";
import { orderState } from "./order-state";
import { runOrderPlanLive } from "./station-plan";
import type { PlanSlice } from "./station-plan-artifact";
import { mintWorker, WORKER_NAME_VAR, WORKER_SESSION_VAR, WORKER_TOKEN_VAR } from "./worker";
import { ASSIGNMENT_ID_VAR, assignedWorker } from "./worker-assignment";

const repos: string[] = [];
const homes: string[] = [];
const slices: readonly PlanSlice[] = [
  { title: "Complete the request", outcome: "The requested result is verified." },
];
afterAll(() => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function env(worker: { name: string; token: string; sessionId: string }): Record<string, string> {
  return {
    [WORKER_NAME_VAR]: worker.name,
    [WORKER_TOKEN_VAR]: worker.token,
    [WORKER_SESSION_VAR]: worker.sessionId,
  };
}

describe("plan approval integration", () => {
  test("the operator delegates planning and approves the attributed plan", async () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const repo = integratedRepo();
    repos.push(repo.dir);
    const home = mkdtempSync(join(tmpdir(), "dim-plan-approval-"));
    homes.push(home);
    writeFileSync(
      join(home, "routing.json"),
      '{ "codex": { "light": "small", "standard": "middling", "deep": "large" } }',
    );
    const operator = mintWorker(db, { role: "operator", sessionId: "operator-plan-session" });
    queueOrder(
      db,
      { id: "operator-plan-order", project: "cniska/dim-factory", title: "Delegate planning" },
      operator.name,
    );

    const outcome = await runOrderPlanLive(db, "operator-plan-order", {
      dir: repo.dir,
      env: { ...env(operator), DIM_HOME: home },
      harness: "codex",
      adapter: scriptedHarness((request) => ({
        output: JSON.stringify({
          body: `## Outcome\n\nPlan for ${assignedWorker(db, request.env[ASSIGNMENT_ID_VAR] as string)}.`,
          slices: [{ title: "Complete the request", outcome: "The requested result is verified." }],
        }),
      })),
    });
    runOrderCommand(db, ["approve", "operator-plan-order"], null, repo.dir, env(operator));

    expect(
      db.query("SELECT role, parent_worker FROM factory_worker WHERE name = ?").get(outcome.planner),
    ).toEqual({
      role: "planner",
      parent_worker: operator.name,
    });
    expect(
      db
        .query<{ kind: string; worker: string }, []>(
          "SELECT kind, worker FROM factory_order_event WHERE order_id = 'operator-plan-order' ORDER BY id",
        )
        .all(),
    ).toEqual([
      { kind: "queued", worker: operator.name },
      { kind: "started", worker: operator.name },
      { kind: "artifact_written", worker: outcome.planner },
      { kind: "artifact_approved", worker: operator.name },
    ]);
    db.close();
  });

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
    startOrder(db, "approval-order", operator.name, undefined, repo.dir);
    const planId = recordOrderPlan(
      db,
      "approval-order",
      "## Build\n\nMake the smallest change.",
      planner.name,
      slices,
    );

    expect(orderState(db, "approval-order")).toEqual({ station: "plan", next: "approve" });

    expect(runOrderCommand(db, ["approve", "approval-order"], null, repo.dir, env(operator))).toContain(
      "plan approved",
    );
    expect(orderState(db, "approval-order")).toEqual({ station: "build", next: "run" });
    expect(
      db.query("SELECT kind, worker FROM factory_order_event WHERE order_id = ?").all("approval-order"),
    ).toEqual([
      { kind: "queued", worker: operator.name },
      { kind: "started", worker: operator.name },
      { kind: "artifact_written", worker: planner.name },
      { kind: "artifact_approved", worker: operator.name },
    ]);
    expect(
      db.query("SELECT artifact_id FROM factory_order_event WHERE kind = 'artifact_approved'").get(),
    ).toEqual({
      artifact_id: planId,
    });
    expect(() => runOrderCommand(db, ["approve", "approval-order"], null, repo.dir, env(operator))).toThrow(
      expect.objectContaining({ code: "not_next", message: expect.stringContaining("run at build") }),
    );
    db.close();
  });

  test("approves a revised plan as a separate attributed artifact", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const repo = integratedRepo();
    repos.push(repo.dir);
    const operator = mintWorker(db, { role: "operator", sessionId: "operator-session-3" });
    const planner = mintWorker(db, {
      role: "planner",
      parentWorker: operator.name,
      sessionId: "operator-session-3/planner-session",
    });
    queueOrder(
      db,
      { id: "approval-order-3", project: "cniska/dim-factory", title: "Revise this" },
      operator.name,
    );
    startOrder(db, "approval-order-3", operator.name, undefined, repo.dir);
    const first = recordOrderPlan(db, "approval-order-3", "## Build\n\nFirst path.", planner.name, slices);
    expect(
      runOrderCommand(
        db,
        ["return", "approval-order-3", "--reason", "Clarify why this plan is the right route."],
        null,
        repo.dir,
        env(operator),
      ),
    ).toContain("returned");
    expect(() => runOrderCommand(db, ["approve", "approval-order-3"], null, repo.dir, env(operator))).toThrow(
      expect.objectContaining({ code: "not_next", message: expect.stringContaining("run at plan") }),
    );
    const second = recordOrderPlan(db, "approval-order-3", "## Build\n\nRevised path.", planner.name, slices);
    expect(second).not.toBe(first);
    expect(runOrderCommand(db, ["approve", "approval-order-3"], null, repo.dir, env(operator))).toContain(
      "plan approved",
    );
    expect(
      db.query("SELECT kind, revision, body FROM factory_order_artifact ORDER BY revision").all(),
    ).toEqual([
      { kind: "plan", revision: 1, body: "## Build\n\nFirst path." },
      { kind: "plan", revision: 2, body: "## Build\n\nRevised path." },
    ]);
    expect(
      db
        .query("SELECT artifact_id FROM factory_order_event WHERE kind = 'artifact_approved' ORDER BY id")
        .all(),
    ).toEqual([{ artifact_id: second }]);
    expect(
      db
        .query("SELECT artifact_id FROM factory_order_event WHERE kind = 'artifact_written' ORDER BY id")
        .all(),
    ).toEqual([{ artifact_id: first }, { artifact_id: second }]);
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
    startOrder(db, "approval-order-2", operator.name, undefined, repo.dir);
    recordOrderPlan(db, "approval-order-2", "## Build\n\nMake the smallest change.", operator.name, slices);

    expect(() => runOrderCommand(db, ["approve", "approval-order-2"], null, repo.dir, env(builder))).toThrow(
      expect.objectContaining({ code: "worker_not_operator" }),
    );
    expect(
      db.query("SELECT count(*) AS n FROM factory_order_event WHERE kind = 'artifact_approved'").get(),
    ).toEqual({
      n: 0,
    });
    db.close();
  });

  test("refuses planning delegation from a non-operator worker", async () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const repo = integratedRepo();
    repos.push(repo.dir);
    const operator = mintWorker(db, { role: "operator", sessionId: "delegate-operator" });
    const builder = mintWorker(db, {
      role: "builder",
      parentWorker: operator.name,
      sessionId: "delegate-operator/builder",
    });
    queueOrder(
      db,
      { id: "delegation-order", project: "cniska/dim-factory", title: "Delegate this" },
      operator.name,
    );

    await expect(
      runOrderCommandLive(
        db,
        ["plan", "delegation-order", "--harness", "codex"],
        null,
        repo.dir,
        env(builder),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "worker_not_operator" }));
    expect(db.query("SELECT count(*) AS n FROM factory_order_artifact").get()).toEqual({ n: 0 });
    db.close();
  });
});
