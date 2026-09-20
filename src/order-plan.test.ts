import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimOrder, queueOrder } from "./factory-order";
import { integratedRepo, workerIn } from "./fixtures.test-support";
import { runOrderPlan } from "./order-plan";
import { SCHEMA_SQL } from "./schema";

describe("planner station", () => {
  test("spawns a read-only planner and records its Markdown report", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const home = mkdtempSync(join(tmpdir(), "dim-planner-"));
    writeFileSync(
      join(home, "routing.json"),
      '{ "cheap": "small", "standard": "middling", "deep": "large" }',
    );
    const repo = integratedRepo();
    const operator = workerIn(db, "operator");
    queueOrder(db, { id: "planner-order", project: "cniska/dim-factory", title: "Plan this" }, operator);
    claimOrder(
      db,
      "planner-order",
      { runId: "run", station: "dim-station-plan" },
      operator,
      undefined,
      repo.dir,
    );

    let argv: string[] = [];
    const outcome = runOrderPlan(db, "planner-order", {
      env: { DIM_HOME: home },
      spawn: (given, env) => {
        argv = given;
        expect(env.DIM_WORKER_NAME).toBeString();
        expect(env.DIM_WORKER_TOKEN).toBeString();
        return { exitCode: 0, stdout: "## outcome\n\nBuild the smallest path.\n" };
      },
    });

    expect(outcome.body).toBe("## outcome\n\nBuild the smallest path.");
    expect(argv).toContain("--allowedTools");
    expect(argv.at(-1)).not.toContain("dim order");
    expect(db.query("SELECT role FROM factory_worker WHERE name = ?").get(outcome.planner)).toEqual({
      role: "planner",
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
