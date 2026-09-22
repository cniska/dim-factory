import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimOrder, queueOrder } from "./factory-order";
import { mintWorker, WORKER_NAME_VAR, WORKER_SESSION_VAR, WORKER_TOKEN_VAR } from "./factory-worker";
import { integratedRepo } from "./fixtures.test-support";
import { runOrderPlan } from "./order-plan";
import { SCHEMA_SQL } from "./schema";
import { ASSIGNMENT_ID_VAR, ASSIGNMENT_TOKEN_VAR, bootstrapWorker } from "./worker-assignment";

describe("planner station", () => {
  test("spawns a read-only planner and records its Markdown report", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const home = mkdtempSync(join(tmpdir(), "dim-planner-"));
    writeFileSync(
      join(home, "routing.json"),
      '{ "codex": { "light": "small", "standard": "middling", "deep": "large" } }',
    );
    const repo = integratedRepo();
    const operator = mintWorker(db, { role: "operator", sessionId: "operator-session" });
    const builder = mintWorker(db, { role: "builder", sessionId: "builder-session" });
    queueOrder(db, { id: "planner-order", project: "cniska/dim-factory", title: "Plan this" }, operator.name);
    claimOrder(
      db,
      "planner-order",
      { runId: "run", station: "dim-station-plan" },
      operator.name,
      undefined,
      repo.dir,
    );

    expect(() =>
      runOrderPlan(db, "planner-order", {
        env: {
          DIM_HOME: home,
          [WORKER_NAME_VAR]: builder.name,
          [WORKER_TOKEN_VAR]: builder.token,
          [WORKER_SESSION_VAR]: builder.sessionId,
        },
      }),
    ).toThrow(expect.objectContaining({ code: "worker_not_operator" }));

    let argv: string[] = [];
    const outcome = runOrderPlan(db, "planner-order", {
      env: {
        DIM_HOME: home,
        [WORKER_NAME_VAR]: operator.name,
        [WORKER_TOKEN_VAR]: operator.token,
        [WORKER_SESSION_VAR]: operator.sessionId,
      },
      spawn: (given, env) => {
        argv = given;
        expect(env.DIM_WORKER_NAME).toBeUndefined();
        expect(env.DIM_WORKER_TOKEN).toBeUndefined();
        expect(env[ASSIGNMENT_ID_VAR]).toBeString();
        bootstrapWorker(db, {
          id: env[ASSIGNMENT_ID_VAR] as string,
          token: env[ASSIGNMENT_TOKEN_VAR] as string,
          sessionId: "planner-harness-session",
        });
        return { exitCode: 0, stdout: "## outcome\n\nBuild the smallest path.\n" };
      },
    });

    expect(outcome.body).toBe("## outcome\n\nBuild the smallest path.");
    expect(argv.slice(0, 7)).toEqual(["codex", "exec", "--json", "--ephemeral", "-s", "read-only", "-C"]);
    expect(argv).toContain("large");
    expect(argv.at(-1)).not.toContain("dim order");
    expect(db.query("SELECT role FROM factory_worker WHERE name = ?").get(outcome.planner)).toEqual({
      role: "planner",
    });
    expect(db.query("SELECT parent_worker FROM factory_worker WHERE name = ?").get(outcome.planner)).toEqual({
      parent_worker: operator.name,
    });
    expect(db.query("SELECT body, worker FROM factory_order_plan").get()).toEqual({
      body: outcome.body,
      worker: outcome.planner,
    });
    expect(db.query("SELECT kind FROM factory_order_event WHERE order_id = 'planner-order'").all()).toEqual([
      { kind: "queued" },
      { kind: "claimed" },
      { kind: "plan_submitted" },
    ]);
    db.close();
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
});
