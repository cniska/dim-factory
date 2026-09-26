import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexProcess } from "./codex-harness";
import { claimOrder, queueOrder } from "./factory-order-lifecycle";
import { mintWorker, WORKER_NAME_VAR, WORKER_SESSION_VAR, WORKER_TOKEN_VAR } from "./factory-worker";
import { fakeHarness } from "./fake-harness";
import { integratedRepo } from "./fixtures.test-support";
import { commandLine } from "./harness-process";
import { plannerBrief, runOrderPlanLive } from "./order-plan";
import { SCHEMA_SQL } from "./schema";
import { scriptedHarness } from "./scripted-harness.test-support";
import { ASSIGNMENT_ID_VAR } from "./worker-assignment";

describe("planner station", () => {
  test("uses the shared artifact contract and names the plan dimensions", () => {
    const brief = plannerBrief({
      id: "human-plan",
      title: "Make the change understandable",
      description: "Keep the plan readable.",
    });

    expect(brief).toContain(
      "Write one Markdown plan for the owner to read on the factory wall and the builder to execute",
    );
    expect(brief).toContain("Use dim-artifact for the shared artifact-writing and sizing contract.");
    expect(brief).toContain(
      "For this Plan artifact, include only the outcome, boundary, evidence, contracts, slices, checks, risks, and owner decisions that this change needs.",
    );
  });

  test("spawns a read-only planner and records its Markdown report", async () => {
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
      { runId: "run", station: "dim-station-plan", operatorWorker: operator.name },
      operator.name,
      undefined,
      repo.dir,
    );

    await expect(
      runOrderPlanLive(db, "planner-order", {
        dir: repo.dir,
        harness: "codex",
        env: {
          DIM_HOME: home,
          [WORKER_NAME_VAR]: builder.name,
          [WORKER_TOKEN_VAR]: builder.token,
          [WORKER_SESSION_VAR]: builder.sessionId,
        },
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "worker_not_operator" }));

    let argv: string[] = [];
    const outcome = await runOrderPlanLive(db, "planner-order", {
      dir: repo.dir,
      harness: "codex",
      env: {
        DIM_HOME: home,
        [WORKER_NAME_VAR]: operator.name,
        [WORKER_TOKEN_VAR]: operator.token,
        [WORKER_SESSION_VAR]: operator.sessionId,
      },
      adapter: scriptedHarness((request) => {
        argv = commandLine(codexProcess, request);
        expect(request.env.DIM_WORKER_NAME).toBeUndefined();
        expect(request.env.DIM_WORKER_TOKEN).toBeUndefined();
        expect(request.env[ASSIGNMENT_ID_VAR]).toBeString();
        return {
          output: JSON.stringify({
            body: "## outcome\n\nBuild the smallest path.",
            slices: [{ title: "Build the smallest path", outcome: "The requested result is verified." }],
          }),
        };
      }),
    });

    expect(outcome.body).toBe("## outcome\n\nBuild the smallest path.");
    expect(outcome.slices).toEqual([
      { title: "Build the smallest path", outcome: "The requested result is verified." },
    ]);
    expect(argv.slice(0, 5)).toEqual(["codex", "-c", 'forced_login_method="chatgpt"', "exec", "--json"]);
    expect(argv).toContain("--output-schema");
    expect(argv).toContain(home);
    expect(argv).toContain("-C");
    expect(argv).toContain("large");
    expect(argv.at(-1)).not.toContain("dim order");
    expect(db.query("SELECT role FROM factory_worker WHERE name = ?").get(outcome.planner)).toEqual({
      role: "planner",
    });
    expect(db.query("SELECT parent_worker FROM factory_worker WHERE name = ?").get(outcome.planner)).toEqual({
      parent_worker: operator.name,
    });
    expect(
      db
        .query(
          `SELECT a.kind, a.body, w.worker FROM factory_order_artifact a
           JOIN factory_order_event w ON w.artifact_id = a.id AND w.kind = 'artifact_written'`,
        )
        .get(),
    ).toEqual({
      kind: "plan",
      body: outcome.body,
      worker: outcome.planner,
    });
    expect(db.query("SELECT ordinal, title, outcome FROM factory_order_slice").all()).toEqual([
      { ordinal: 1, title: "Build the smallest path", outcome: "The requested result is verified." },
    ]);
    expect(db.query("SELECT kind FROM factory_order_event WHERE order_id = 'planner-order'").all()).toEqual([
      { kind: "queued" },
      { kind: "claimed" },
      { kind: "artifact_written" },
      { kind: "hold_set" },
    ]);
    db.close();
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("records a crashed planner with the harness explanation", async () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const home = mkdtempSync(join(tmpdir(), "dim-planner-crash-"));
    writeFileSync(
      join(home, "routing.json"),
      '{ "codex": { "light": "small", "standard": "middling", "deep": "large" } }',
    );
    const repo = integratedRepo();
    const operator = mintWorker(db, { role: "operator", sessionId: "planner-crash-operator" });
    queueOrder(
      db,
      { id: "planner-crash-order", project: "cniska/dim-factory", title: "Plan this" },
      operator.name,
    );
    claimOrder(
      db,
      "planner-crash-order",
      { runId: "run", station: "dim-station-plan", operatorWorker: operator.name },
      operator.name,
      undefined,
      repo.dir,
    );

    await expect(
      runOrderPlanLive(db, "planner-crash-order", {
        dir: repo.dir,
        harness: "codex",
        adapter: fakeHarness("crash"),
        env: {
          DIM_HOME: home,
          [WORKER_NAME_VAR]: operator.name,
          [WORKER_TOKEN_VAR]: operator.token,
          [WORKER_SESSION_VAR]: operator.sessionId,
        },
      }),
    ).rejects.toThrow("fake process crashed");

    const failure = db
      .query<{ worker: string; reason: string }, [string]>(
        "SELECT worker, reason FROM factory_order_event WHERE order_id = ? AND kind = 'failed'",
      )
      .get("planner-crash-order");
    if (!failure) throw new Error("planner failure event was not recorded");
    expect(failure.reason).toContain("fake process crashed");
    expect(
      db
        .query<{ role: string }, [string]>("SELECT role FROM factory_worker WHERE name = ?")
        .get(failure.worker),
    ).toEqual({
      role: "planner",
    });

    db.close();
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("keeps the same planner identity for a later planning turn", async () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const home = mkdtempSync(join(tmpdir(), "dim-planner-resume-"));
    writeFileSync(
      join(home, "routing.json"),
      '{ "codex": { "light": "small", "standard": "middling", "deep": "large" } }',
    );
    const repo = integratedRepo();
    const operator = mintWorker(db, { role: "operator", sessionId: "planner-resume-operator" });
    queueOrder(
      db,
      { id: "planner-resume-order", project: "cniska/dim-factory", title: "Plan this" },
      operator.name,
    );
    claimOrder(
      db,
      "planner-resume-order",
      { runId: "run", station: "dim-station-plan", operatorWorker: operator.name },
      operator.name,
      undefined,
      repo.dir,
    );
    const base = fakeHarness("plan");
    let starts = 0;
    let resumes = 0;
    const adapter = {
      ...base,
      start: async (request: Parameters<typeof base.start>[0]) => {
        starts += 1;
        return base.start(request);
      },
      resume: async (sessionId: string, request: Parameters<typeof base.start>[0]) => {
        resumes += 1;
        expect(sessionId).toBe("fake-session");
        return base.resume(sessionId, request);
      },
    };
    const env = {
      DIM_HOME: home,
      [WORKER_NAME_VAR]: operator.name,
      [WORKER_TOKEN_VAR]: operator.token,
      [WORKER_SESSION_VAR]: operator.sessionId,
    };

    const first = await runOrderPlanLive(db, "planner-resume-order", {
      adapter,
      env,
      dir: repo.dir,
      harness: "codex",
    });
    const second = await runOrderPlanLive(db, "planner-resume-order", {
      adapter,
      env,
      dir: repo.dir,
      harness: "codex",
    });

    expect(second.planner).toBe(first.planner);
    expect(starts).toBe(1);
    expect(resumes).toBe(1);
    expect(db.query("SELECT count(*) AS n FROM factory_worker WHERE role = 'planner'").get()).toEqual({
      n: 1,
    });
    expect(db.query("SELECT count(*) AS n FROM factory_order_worker").get()).toEqual({ n: 1 });
    expect(
      db
        .query("SELECT worker, provider_session_id FROM factory_order_worker WHERE order_id = ?")
        .get("planner-resume-order"),
    ).toEqual({ worker: first.planner, provider_session_id: "fake-session" });

    db.close();
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("refuses to plan an order nobody claimed, before a planner exists", async () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const repo = integratedRepo();
    const operator = mintWorker(db, { role: "operator", sessionId: "planner-unclaimed-operator" });
    queueOrder(db, { id: "unclaimed-order", project: "cniska/dim-factory", title: "Plan me" }, operator.name);
    const env = {
      [WORKER_NAME_VAR]: operator.name,
      [WORKER_TOKEN_VAR]: operator.token,
      [WORKER_SESSION_VAR]: operator.sessionId,
    };

    await expect(
      runOrderPlanLive(db, "unclaimed-order", {
        adapter: fakeHarness("plan"),
        env,
        dir: repo.dir,
        harness: "codex",
      }),
    ).rejects.toThrow("order unclaimed-order is not claimed");
    expect(db.query("SELECT count(*) AS n FROM factory_order_worker").get()).toEqual({ n: 0 });
    db.close();
    rmSync(repo.dir, { recursive: true, force: true });
  });

  test("plans in the order's worktree, wherever the operator runs from", async () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const home = mkdtempSync(join(tmpdir(), "dim-planner-cwd-"));
    writeFileSync(
      join(home, "routing.json"),
      '{ "codex": { "light": "small", "standard": "middling", "deep": "large" } }',
    );
    const repo = integratedRepo();
    const operator = mintWorker(db, { role: "operator", sessionId: "planner-cwd-operator" });
    queueOrder(
      db,
      { id: "planner-cwd-order", project: "cniska/dim-factory", title: "Plan here" },
      operator.name,
    );
    claimOrder(
      db,
      "planner-cwd-order",
      { runId: "run", station: "dim-station-plan", operatorWorker: operator.name },
      operator.name,
      undefined,
      repo.dir,
    );
    const base = fakeHarness("plan");
    let plannedIn: string | undefined;
    const adapter = {
      ...base,
      start: async (request: Parameters<typeof base.start>[0]) => {
        plannedIn = request.cwd;
        return base.start(request);
      },
    };
    const env = {
      DIM_HOME: home,
      [WORKER_NAME_VAR]: operator.name,
      [WORKER_TOKEN_VAR]: operator.token,
      [WORKER_SESSION_VAR]: operator.sessionId,
    };

    await runOrderPlanLive(db, "planner-cwd-order", { adapter, env, dir: repo.dir, harness: "codex" });

    expect(plannedIn).toBe(join(realpathSync(repo.dir), ".claude", "worktrees", "planner-cwd-order"));
    db.close();
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
});
