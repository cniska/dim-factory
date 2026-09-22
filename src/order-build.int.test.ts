import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveOrderPlan,
  claimOrder,
  moveOrder,
  queueOrder,
  recordOrderCheck,
  recordOrderCommit,
  recordOrderPlan,
} from "./factory-order";
import { mintWorker, WORKER_NAME_VAR, WORKER_SESSION_VAR, WORKER_TOKEN_VAR } from "./factory-worker";
import { fakeHarness } from "./fake-harness";
import { integratedRepo } from "./fixtures.test-support";
import { runOrderBuild, runOrderBuildLive } from "./order-build";
import { SCHEMA_SQL } from "./schema";
import { ASSIGNMENT_ID_VAR, ASSIGNMENT_TOKEN_VAR, bootstrapWorker } from "./worker-assignment";

const repos: string[] = [];
const homes: string[] = [];
afterAll(() => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

describe("builder station", () => {
  test("starts an attributed builder in the operator-allocated worktree", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const repo = integratedRepo();
    repos.push(repo.dir);
    const home = mkdtempSync(join(tmpdir(), "dim-builder-"));
    homes.push(home);
    writeFileSync(
      join(home, "routing.json"),
      '{ "codex": { "light": "small", "standard": "middling", "deep": "large" } }',
    );
    const operator = mintWorker(db, { role: "operator", sessionId: "build-operator" });
    queueOrder(
      db,
      { id: "builder-order", project: "cniska/dim-factory", title: "Build this" },
      operator.name,
    );
    claimOrder(
      db,
      "builder-order",
      { runId: "plan-run", station: "dim-station-plan" },
      operator.name,
      undefined,
      repo.dir,
    );
    const planner = mintWorker(db, {
      role: "planner",
      parentWorker: operator.name,
      sessionId: "build-operator/planner",
    });
    recordOrderPlan(db, "builder-order", "## Outcome\n\nBuild the requested result.", planner.name);
    approveOrderPlan(db, "builder-order", operator.name);
    moveOrder(db, "builder-order", "dim-station-build", operator.name);

    let spawnedCwd = "";
    let spawnedBrief = "";
    const outcome = runOrderBuild(db, "builder-order", operator.name, {
      dir: repo.dir,
      env: {
        DIM_HOME: home,
        [WORKER_NAME_VAR]: operator.name,
        [WORKER_TOKEN_VAR]: operator.token,
        [WORKER_SESSION_VAR]: operator.sessionId,
      },
      spawn: (argv, childEnv, cwd) => {
        spawnedCwd = cwd;
        spawnedBrief = argv.find((argument) => argument.includes("factory order ")) ?? "";
        const builder = bootstrapWorker(db, {
          id: childEnv[ASSIGNMENT_ID_VAR] as string,
          token: childEnv[ASSIGNMENT_TOKEN_VAR] as string,
          sessionId: "builder-session",
        });
        childEnv[WORKER_NAME_VAR] = builder.name;
        childEnv[WORKER_SESSION_VAR] = builder.sessionId;
        claimOrder(
          db,
          "builder-order",
          { runId: "builder-run", sessionId: childEnv[WORKER_SESSION_VAR], station: "dim-station-build" },
          builder.name,
          undefined,
          repo.dir,
        );
        recordOrderCommit(db, "builder-order", repo.sha, builder.name, "feat: build it");
        recordOrderCheck(
          db,
          "builder-order",
          { command: "bun run verify", exitCode: 0, result: "green" },
          builder.name,
        );
        return { exitCode: 0 };
      },
    });

    expect(spawnedCwd).toBe(realpathSync(join(repo.dir, ".claude", "worktrees", "builder-order")));
    expect(spawnedBrief).toContain("The operator approved the following plan");
    expect(spawnedBrief).toContain("Build the requested result.");
    expect(outcome.worktree).toBe(spawnedCwd);
    expect(
      db
        .query("SELECT role, parent_worker, ended_at FROM factory_worker WHERE name = ?")
        .get(outcome.builder),
    ).toEqual({
      role: "builder",
      parent_worker: operator.name,
      ended_at: expect.any(String),
    });
    expect(
      db
        .query("SELECT kind, worker, station FROM factory_order_event WHERE order_id = ?")
        .all("builder-order"),
    ).toEqual([
      { kind: "queued", worker: operator.name, station: null },
      { kind: "claimed", worker: operator.name, station: "dim-station-plan" },
      { kind: "plan_submitted", worker: planner.name, station: null },
      { kind: "plan_approved", worker: operator.name, station: null },
      { kind: "moved", worker: operator.name, station: "dim-station-build" },
      { kind: "claimed", worker: outcome.builder, station: "dim-station-build" },
      { kind: "commit_created", worker: outcome.builder, station: null },
      { kind: "check_finished", worker: outcome.builder, station: null },
    ]);
    db.close();
  });

  test("records a failed build when the configured harness cannot start", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const repo = integratedRepo();
    repos.push(repo.dir);
    const home = mkdtempSync(join(tmpdir(), "dim-builder-failure-"));
    homes.push(home);
    writeFileSync(
      join(home, "routing.json"),
      '{ "codex": { "light": "small", "standard": "middling", "deep": "large" } }',
    );
    const operator = mintWorker(db, { role: "operator", sessionId: "failed-build-operator" });
    queueOrder(
      db,
      { id: "failed-builder-order", project: "cniska/dim-factory", title: "Fail this build" },
      operator.name,
    );
    claimOrder(
      db,
      "failed-builder-order",
      { runId: "failed-plan-run", station: "dim-station-plan" },
      operator.name,
      undefined,
      repo.dir,
    );
    const planner = mintWorker(db, {
      role: "planner",
      parentWorker: operator.name,
      sessionId: "failed-build-operator/planner",
    });
    recordOrderPlan(db, "failed-builder-order", "## Outcome\n\nTry the build.", planner.name);
    approveOrderPlan(db, "failed-builder-order", operator.name);
    moveOrder(db, "failed-builder-order", "dim-station-build", operator.name);

    expect(() =>
      runOrderBuild(db, "failed-builder-order", operator.name, {
        dir: repo.dir,
        env: { DIM_HOME: home },
        spawn: () => {
          throw new Error("harness unavailable");
        },
      }),
    ).toThrow("harness unavailable");

    expect(
      db
        .query("SELECT kind, worker, reason FROM factory_order_event WHERE order_id = ?")
        .all("failed-builder-order"),
    ).toContainEqual({ kind: "failed", worker: operator.name, reason: "harness unavailable" });
    expect(
      db.query("SELECT status, run_id FROM factory_order WHERE id = ?").get("failed-builder-order"),
    ).toEqual({
      status: "queued",
      run_id: null,
    });
    db.close();
  });

  test("keeps the same builder identity after a failed build turn", async () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const repo = integratedRepo();
    repos.push(repo.dir);
    const home = mkdtempSync(join(tmpdir(), "dim-builder-resume-"));
    homes.push(home);
    writeFileSync(
      join(home, "routing.json"),
      '{ "codex": { "light": "small", "standard": "middling", "deep": "large" } }',
    );
    const operator = mintWorker(db, { role: "operator", sessionId: "builder-resume-operator" });
    queueOrder(
      db,
      { id: "builder-resume-order", project: "cniska/dim-factory", title: "Retry this build" },
      operator.name,
    );
    claimOrder(
      db,
      "builder-resume-order",
      { runId: "plan-run", station: "dim-station-plan" },
      operator.name,
      undefined,
      repo.dir,
    );
    const planner = mintWorker(db, {
      role: "planner",
      parentWorker: operator.name,
      sessionId: "builder-resume-operator/planner",
    });
    recordOrderPlan(db, "builder-resume-order", "## Outcome\n\nBuild the requested result.", planner.name);
    approveOrderPlan(db, "builder-resume-order", operator.name);
    moveOrder(db, "builder-resume-order", "dim-station-build", operator.name);

    const base = fakeHarness("crash");
    let starts = 0;
    const adapter = {
      ...base,
      start: async (request: Parameters<typeof base.start>[0]) => {
        starts += 1;
        return base.start(request);
      },
    };
    const env = {
      DIM_HOME: home,
      [WORKER_NAME_VAR]: operator.name,
      [WORKER_TOKEN_VAR]: operator.token,
      [WORKER_SESSION_VAR]: operator.sessionId,
    };

    await expect(
      runOrderBuildLive(db, "builder-resume-order", operator.name, { dir: repo.dir, env, adapter }),
    ).rejects.toThrow("fake process crashed");
    await expect(
      runOrderBuildLive(db, "builder-resume-order", operator.name, { dir: repo.dir, env, adapter }),
    ).rejects.toThrow("fake process crashed");

    expect(starts).toBe(2);
    expect(db.query("SELECT count(*) AS n FROM factory_worker WHERE role = 'builder'").get()).toEqual({
      n: 1,
    });
    expect(db.query("SELECT count(*) AS n FROM factory_order_worker").get()).toEqual({ n: 1 });
    db.close();
  });
});
