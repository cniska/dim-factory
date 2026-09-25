import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answerOrderFinding,
  appendOrderEvent,
  approveOrderBuild,
  approveOrderPlan,
  claimOrder,
  closeOrderReview,
  completeOrderBuildFollowup,
  isActiveOrderRun,
  moveOrder,
  openOrderReview,
  queueOrder,
  raiseOrderFinding,
  recordOrderBuild,
  recordOrderCheck,
  recordOrderCommit,
  recordOrderPlan,
  returnOrderArtifact,
} from "./factory-order";
import {
  endWorker,
  mintWorker,
  WORKER_NAME_VAR,
  WORKER_SESSION_VAR,
  WORKER_TOKEN_VAR,
} from "./factory-worker";
import { fakeHarness } from "./fake-harness";
import { integratedRepo } from "./fixtures.test-support";
import { runOrderBuild, runOrderBuildLive } from "./order-build";
import { SCHEMA_SQL } from "./schema";
import { ASSIGNMENT_ID_VAR, ASSIGNMENT_TOKEN_VAR, bootstrapWorker } from "./worker-assignment";
import { saveWorkerCredential } from "./worker-credential";

const repos: string[] = [];
const homes: string[] = [];
afterAll(() => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

describe("builder station", () => {
  test("starts an attributed builder in the operator-allocated worktree", async () => {
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
      { runId: "plan-run", station: "dim-station-plan", operatorWorker: operator.name },
      operator.name,
      undefined,
      repo.dir,
    );
    const planner = mintWorker(db, {
      role: "planner",
      parentWorker: operator.name,
      sessionId: "build-operator/planner",
    });
    recordOrderPlan(db, "builder-order", "## Outcome\n\nBuild the requested result.", planner.name, [
      { title: "Build the result", outcome: "The requested result is verified." },
    ]);
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
        childEnv[WORKER_TOKEN_VAR] = builder.token;
        childEnv[WORKER_SESSION_VAR] = builder.sessionId;
        saveWorkerCredential(childEnv, builder);
        claimOrder(
          db,
          "builder-order",
          {
            runId: "builder-run",
            sessionId: childEnv[WORKER_SESSION_VAR],
            station: "dim-station-build",
            operatorWorker: operator.name,
          },
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
        recordOrderBuild(
          db,
          "builder-order",
          "The requested result is built and verified.",
          repo.sha,
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
      ended_at: null,
    });
    expect(
      db
        .query("SELECT kind, worker, station FROM factory_order_event WHERE order_id = ?")
        .all("builder-order"),
    ).toEqual([
      { kind: "queued", worker: operator.name, station: null },
      { kind: "claimed", worker: operator.name, station: "dim-station-plan" },
      { kind: "plan_artifact_written", worker: planner.name, station: null },
      { kind: "hold_set", worker: planner.name, station: null },
      { kind: "owner_verdict_recorded", worker: operator.name, station: null },
      { kind: "plan_approved", worker: operator.name, station: null },
      { kind: "hold_released", worker: operator.name, station: null },
      { kind: "moved", worker: operator.name, station: "dim-station-build" },
      { kind: "claimed", worker: outcome.builder, station: "dim-station-build" },
      { kind: "commit_created", worker: outcome.builder, station: null },
      { kind: "check_finished", worker: outcome.builder, station: null },
      { kind: "build_artifact_written", worker: outcome.builder, station: null },
      { kind: "hold_set", worker: outcome.builder, station: null },
    ]);
    expect(db.query("SELECT worker FROM factory_order_slice_completion").get()).toEqual({
      worker: outcome.builder,
    });
    expect(isActiveOrderRun(db, "builder-order", outcome.runId)).toBe(false);

    returnOrderArtifact(db, "builder-order", operator.name, "Explain what the build verified.");
    let revisionBrief = "";
    expect(() =>
      runOrderBuild(db, "builder-order", operator.name, {
        dir: repo.dir,
        env: {
          DIM_HOME: home,
          [WORKER_NAME_VAR]: operator.name,
          [WORKER_TOKEN_VAR]: operator.token,
          [WORKER_SESSION_VAR]: operator.sessionId,
        },
        spawn: (argv) => {
          revisionBrief = argv.find((argument) => argument.includes("factory order ")) ?? "";
          throw new Error("harness unavailable");
        },
      }),
    ).toThrow("harness unavailable");
    expect(revisionBrief).toContain("The owner returned the Build artifact to you.");
    expect(revisionBrief).toContain("Explain what the build verified.");
    await expect(
      runOrderBuildLive(db, "builder-order", operator.name, {
        dir: repo.dir,
        env: {
          DIM_HOME: home,
          [WORKER_NAME_VAR]: operator.name,
          [WORKER_TOKEN_VAR]: operator.token,
          [WORKER_SESSION_VAR]: operator.sessionId,
        },
        adapter: fakeHarness("crash"),
      }),
    ).rejects.toThrow("fake process crashed");
    expect(db.query("SELECT status, hold FROM factory_order WHERE id = ?").get("builder-order")).toEqual({
      status: "working",
      hold: null,
    });
    expect(
      db
        .query("SELECT kind FROM factory_order_event WHERE order_id = ? ORDER BY id DESC LIMIT 1")
        .get("builder-order"),
    ).toEqual({ kind: "hold_released" });
    db.close();
  });

  test("keeps an incomplete final slice while giving the builder returned artifact feedback", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const repo = integratedRepo();
    repos.push(repo.dir);
    const home = mkdtempSync(join(tmpdir(), "dim-builder-return-"));
    homes.push(home);
    writeFileSync(
      join(home, "routing.json"),
      '{ "codex": { "light": "small", "standard": "middling", "deep": "large" } }',
    );
    const operator = mintWorker(db, { role: "operator", sessionId: "return-operator" });
    queueOrder(
      db,
      { id: "returned-builder-order", project: "cniska/dim-factory", title: "Build this" },
      operator.name,
    );
    claimOrder(
      db,
      "returned-builder-order",
      { runId: "plan-run", station: "dim-station-plan", operatorWorker: operator.name },
      operator.name,
      undefined,
      repo.dir,
    );
    const planner = mintWorker(db, {
      role: "planner",
      parentWorker: operator.name,
      sessionId: "return-operator/planner",
    });
    recordOrderPlan(db, "returned-builder-order", "Build the requested result.", planner.name, [
      { title: "Finish the result", outcome: "The result is verified." },
    ]);
    approveOrderPlan(db, "returned-builder-order", operator.name);
    moveOrder(db, "returned-builder-order", "dim-station-build", operator.name);
    const builder = mintWorker(db, {
      role: "builder",
      parentWorker: operator.name,
      sessionId: "return-operator/builder",
    });
    claimOrder(
      db,
      "returned-builder-order",
      { runId: "build-run", station: "dim-station-build", operatorWorker: operator.name },
      builder.name,
      undefined,
      repo.dir,
    );
    recordOrderCommit(db, "returned-builder-order", repo.sha, builder.name, "feat: build it");
    recordOrderCheck(
      db,
      "returned-builder-order",
      { command: "bun run verify", exitCode: 0, result: "green" },
      builder.name,
    );
    recordOrderBuild(db, "returned-builder-order", "The initial Build artifact.", repo.sha, builder.name);
    appendOrderEvent(db, "returned-builder-order", {
      kind: "failed",
      worker: builder.name,
      reason: "Artifact needs revision.",
    });
    returnOrderArtifact(
      db,
      "returned-builder-order",
      operator.name,
      "Explain the verification for the owner.",
    );

    let brief = "";
    expect(() =>
      runOrderBuild(db, "returned-builder-order", operator.name, {
        dir: repo.dir,
        env: { DIM_HOME: home },
        spawn: (argv) => {
          brief = argv.find((argument) => argument.includes("factory order ")) ?? "";
          throw new Error("harness unavailable");
        },
      }),
    ).toThrow("harness unavailable");
    expect(brief).toContain("# Current slice");
    expect(brief).toContain("Finish the result: The result is verified.");
    expect(brief).toContain("# Returned Build artifact");
    expect(brief).toContain("The initial Build artifact.");
    expect(brief).toContain("# Owner feedback");
    expect(brief).toContain("Explain the verification for the owner.");
    expect(brief).not.toContain("The code work is complete; revise only the artifact.");
    expect(db.query("SELECT count(*) AS n FROM factory_order_slice_completion").get()).toEqual({ n: 0 });

    const outcome = runOrderBuild(db, "returned-builder-order", operator.name, {
      dir: repo.dir,
      env: { DIM_HOME: home },
      spawn: (_argv, childEnv) => {
        const resumedBuilder = bootstrapWorker(db, {
          id: childEnv[ASSIGNMENT_ID_VAR] as string,
          token: childEnv[ASSIGNMENT_TOKEN_VAR] as string,
          sessionId: "returned-builder-session",
        });
        childEnv[WORKER_NAME_VAR] = resumedBuilder.name;
        childEnv[WORKER_TOKEN_VAR] = resumedBuilder.token;
        childEnv[WORKER_SESSION_VAR] = resumedBuilder.sessionId;
        saveWorkerCredential(childEnv, resumedBuilder);
        claimOrder(
          db,
          "returned-builder-order",
          {
            runId: "returned-build-run",
            sessionId: resumedBuilder.sessionId,
            station: "dim-station-build",
            operatorWorker: operator.name,
          },
          resumedBuilder.name,
          undefined,
          repo.dir,
        );
        recordOrderBuild(
          db,
          "returned-builder-order",
          "The revised Build artifact explains the verification.",
          repo.sha,
          resumedBuilder.name,
        );
        return { exitCode: 0 };
      },
    });
    expect(db.query("SELECT count(*) AS n FROM factory_order_slice_completion").get()).toEqual({ n: 1 });
    expect(db.query("SELECT worker FROM factory_order_slice_completion").get()).toEqual({
      worker: outcome.builder,
    });
    expect(db.query("SELECT revision FROM factory_order_build ORDER BY revision DESC LIMIT 1").get()).toEqual(
      {
        revision: 2,
      },
    );
    returnOrderArtifact(db, "returned-builder-order", operator.name, "Match the actual worktree HEAD.");
    const laterCommit = Bun.spawnSync(
      [
        "git",
        "-C",
        outcome.worktree,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "fix: unrecorded head",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(laterCommit.success).toBe(true);
    expect(() =>
      runOrderBuild(db, "returned-builder-order", operator.name, {
        dir: repo.dir,
        env: { DIM_HOME: home },
        spawn: () => {
          recordOrderBuild(
            db,
            "returned-builder-order",
            "Revision still points to the old head.",
            repo.sha,
            outcome.builder,
          );
          return { exitCode: 0 };
        },
      }),
    ).toThrow("builder did not record worktree HEAD");
    returnOrderArtifact(db, "returned-builder-order", operator.name, "Record an immutable commit ID.");
    recordOrderCommit(db, "returned-builder-order", "HEAD", outcome.builder, "fix: symbolic head");
    recordOrderCheck(
      db,
      "returned-builder-order",
      { command: "bun run verify", exitCode: 0, result: "green" },
      outcome.builder,
    );
    expect(() =>
      runOrderBuild(db, "returned-builder-order", operator.name, {
        dir: repo.dir,
        env: { DIM_HOME: home },
        spawn: () => {
          recordOrderBuild(
            db,
            "returned-builder-order",
            "Revision names a moving ref.",
            "HEAD",
            outcome.builder,
          );
          return { exitCode: 0 };
        },
      }),
    ).toThrow("builder did not record an immutable commit ID");
    db.close();
  });

  test("returns answered review findings to the same builder for a new Build artifact", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const repo = integratedRepo();
    repos.push(repo.dir);
    const home = mkdtempSync(join(tmpdir(), "dim-builder-review-rework-"));
    homes.push(home);
    writeFileSync(
      join(home, "routing.json"),
      '{ "codex": { "light": "small", "standard": "middling", "deep": "large" } }',
    );
    const operator = mintWorker(db, { role: "operator", sessionId: "review-rework-operator" });
    queueOrder(
      db,
      { id: "review-rework-order", project: "cniska/dim-factory", title: "Build this" },
      operator.name,
    );
    claimOrder(
      db,
      "review-rework-order",
      { runId: "plan-run", station: "dim-station-plan", operatorWorker: operator.name },
      operator.name,
      undefined,
      repo.dir,
    );
    const planner = mintWorker(db, {
      role: "planner",
      parentWorker: operator.name,
      sessionId: "review-rework-planner",
    });
    recordOrderPlan(db, "review-rework-order", "Build the requested result.", planner.name, [
      { title: "Build the result", outcome: "The result is verified." },
    ]);
    approveOrderPlan(db, "review-rework-order", operator.name);
    moveOrder(db, "review-rework-order", "dim-station-build", operator.name);

    const firstBuild = runOrderBuild(db, "review-rework-order", operator.name, {
      dir: repo.dir,
      env: { DIM_HOME: home },
      spawn: (_argv, childEnv) => {
        const builder = bootstrapWorker(db, {
          id: childEnv[ASSIGNMENT_ID_VAR] as string,
          token: childEnv[ASSIGNMENT_TOKEN_VAR] as string,
          sessionId: "review-rework-builder-session",
        });
        childEnv[WORKER_NAME_VAR] = builder.name;
        childEnv[WORKER_TOKEN_VAR] = builder.token;
        childEnv[WORKER_SESSION_VAR] = builder.sessionId;
        saveWorkerCredential(childEnv, builder);
        claimOrder(
          db,
          "review-rework-order",
          { runId: "first-build-run", station: "dim-station-build", operatorWorker: operator.name },
          builder.name,
          undefined,
          repo.dir,
        );
        recordOrderCommit(db, "review-rework-order", repo.sha, builder.name, "feat: build it");
        recordOrderCheck(db, "review-rework-order", { command: "bun run verify", exitCode: 0 }, builder.name);
        recordOrderBuild(db, "review-rework-order", "Initial Build artifact.", repo.sha, builder.name);
        return { exitCode: 0 };
      },
    });
    approveOrderBuild(db, "review-rework-order", operator.name, "Build approved.");
    moveOrder(db, "review-rework-order", "dim-station-review", operator.name);
    const reviewer = mintWorker(db, {
      role: "reviewer",
      parentWorker: operator.name,
      sessionId: "review-rework-reviewer",
    });
    const review = openOrderReview(
      db,
      "review-rework-order",
      { reviewer: reviewer.name, baseSha: repo.sha, headSha: repo.sha },
      reviewer.name,
    );
    const finding = raiseOrderFinding(
      db,
      "review-rework-order",
      { dimension: "correctness", summary: "Count the actual order provenance." },
      reviewer.name,
    );
    closeOrderReview(db, review.id, "closed", reviewer.name);
    answerOrderFinding(db, finding, { answer: "fixed" }, operator.name);
    moveOrder(db, "review-rework-order", "dim-station-build", operator.name);
    const newCommit = Bun.spawnSync(
      [
        "git",
        "-C",
        firstBuild.worktree,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "fix: review finding",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(newCommit.success).toBe(true);
    const head = Bun.spawnSync(["git", "-C", firstBuild.worktree, "rev-parse", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    })
      .stdout.toString()
      .trim();

    let brief = "";
    const followup = runOrderBuild(db, "review-rework-order", operator.name, {
      dir: repo.dir,
      env: { DIM_HOME: home },
      spawn: (argv) => {
        brief = argv.find((argument) => argument.includes("factory order ")) ?? "";
        claimOrder(
          db,
          "review-rework-order",
          { runId: "followup-build-run", station: "dim-station-build", operatorWorker: operator.name },
          firstBuild.builder,
          undefined,
          repo.dir,
        );
        recordOrderCheck(
          db,
          "review-rework-order",
          { command: "bun run verify", exitCode: 0 },
          firstBuild.builder,
        );
        expect(() => completeOrderBuildFollowup(db, "review-rework-order", firstBuild.builder)).toThrow(
          "no Build artifact after its latest Review",
        );
        recordOrderCommit(db, "review-rework-order", head, firstBuild.builder, "fix: review finding");
        recordOrderCheck(
          db,
          "review-rework-order",
          { command: "bun run verify", exitCode: 0 },
          firstBuild.builder,
        );
        recordOrderBuild(db, "review-rework-order", "Revised Build artifact.", head, firstBuild.builder);
        return { exitCode: 0 };
      },
    });
    expect(brief).toContain("Count the actual order provenance.");
    expect(brief).toContain("Review findings");
    expect(followup.builder).toBe(firstBuild.builder);
    expect(db.query("SELECT run_id FROM factory_order WHERE id = ?").get("review-rework-order")).toEqual({
      run_id: null,
    });
    expect(
      db.query("SELECT revision, head_sha FROM factory_order_build ORDER BY revision DESC LIMIT 1").get(),
    ).toEqual({
      revision: 2,
      head_sha: head,
    });
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
      { runId: "failed-plan-run", station: "dim-station-plan", operatorWorker: operator.name },
      operator.name,
      undefined,
      repo.dir,
    );
    const planner = mintWorker(db, {
      role: "planner",
      parentWorker: operator.name,
      sessionId: "failed-build-operator/planner",
    });
    recordOrderPlan(db, "failed-builder-order", "## Outcome\n\nTry the build.", planner.name, [
      { title: "Try the build", outcome: "The build result is verified." },
    ]);
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
    ).toContainEqual({ kind: "failed", worker: null, reason: "harness unavailable" });
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
    const nextOperator = mintWorker(db, { role: "operator", sessionId: "builder-resume-operator-2" });
    const laterOperator = mintWorker(db, { role: "operator", sessionId: "builder-resume-operator-3" });
    queueOrder(
      db,
      { id: "builder-resume-order", project: "cniska/dim-factory", title: "Retry this build" },
      operator.name,
    );
    claimOrder(
      db,
      "builder-resume-order",
      { runId: "plan-run", station: "dim-station-plan", operatorWorker: operator.name },
      operator.name,
      undefined,
      repo.dir,
    );
    const planner = mintWorker(db, {
      role: "planner",
      parentWorker: operator.name,
      sessionId: "builder-resume-operator/planner",
    });
    recordOrderPlan(db, "builder-resume-order", "## Outcome\n\nBuild the requested result.", planner.name, [
      { title: "Build the result", outcome: "The requested result is verified." },
    ]);
    approveOrderPlan(db, "builder-resume-order", operator.name);
    moveOrder(db, "builder-resume-order", "dim-station-build", operator.name);

    const base = fakeHarness("crash");
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
        expect(request.brief).toContain("# Previous failed Build attempt");
        expect(request.brief).toContain("fake process crashed");
        return base.resume(sessionId, request);
      },
    };
    const env = {
      DIM_HOME: home,
      [WORKER_NAME_VAR]: operator.name,
      [WORKER_TOKEN_VAR]: operator.token,
      [WORKER_SESSION_VAR]: operator.sessionId,
    };

    await expect(
      runOrderBuildLive(db, "builder-resume-order", operator.name, {
        dir: repo.dir,
        env,
        adapter: fakeHarness("bootstrap-failure"),
      }),
    ).rejects.toThrow("worker bootstrap failed");
    expect(db.query("SELECT count(*) AS n FROM factory_worker WHERE role = 'builder'").get()).toEqual({
      n: 0,
    });
    endWorker(db, operator.name);
    await expect(
      runOrderBuildLive(db, "builder-resume-order", nextOperator.name, {
        dir: repo.dir,
        env: {
          DIM_HOME: home,
          [WORKER_NAME_VAR]: nextOperator.name,
          [WORKER_TOKEN_VAR]: nextOperator.token,
          [WORKER_SESSION_VAR]: nextOperator.sessionId,
        },
        adapter,
      }),
    ).rejects.toThrow("fake process crashed");
    await expect(
      runOrderBuildLive(db, "builder-resume-order", laterOperator.name, {
        dir: repo.dir,
        env: {
          DIM_HOME: home,
          [WORKER_NAME_VAR]: laterOperator.name,
          [WORKER_TOKEN_VAR]: laterOperator.token,
          [WORKER_SESSION_VAR]: laterOperator.sessionId,
        },
        adapter,
      }),
    ).rejects.toThrow("fake process crashed");

    expect(starts).toBe(1);
    expect(resumes).toBe(1);
    expect(db.query("SELECT count(*) AS n FROM factory_worker WHERE role = 'builder'").get()).toEqual({
      n: 1,
    });
    expect(db.query("SELECT count(*) AS n FROM factory_order_worker").get()).toEqual({ n: 1 });
    expect(
      db
        .query(
          "SELECT kind, operator_worker FROM factory_order_attempt WHERE kind = 'started' AND station = 'dim-station-build' ORDER BY rowid",
        )
        .all(),
    ).toEqual([
      { kind: "started", operator_worker: nextOperator.name },
      { kind: "started", operator_worker: laterOperator.name },
    ]);
    expect(
      db
        .query(
          `SELECT count(*) AS n FROM factory_order_attempt
           WHERE kind = 'started' AND station = 'dim-station-build'
             AND session_id IS NOT NULL AND provider_session_id IS NOT NULL
             AND harness IS NOT NULL AND model IS NOT NULL AND tier IS NOT NULL
             AND started_at IS NOT NULL`,
        )
        .get(),
    ).toEqual({ n: 2 });
    expect(
      db
        .query(
          `SELECT parent_worker FROM factory_worker WHERE name = (
            SELECT worker FROM factory_order_worker WHERE order_id = ? AND role = 'builder'
          )`,
        )
        .get("builder-resume-order"),
    ).toEqual({ parent_worker: operator.name });
    db.close();
  });

  test("refuses a builder's next turn under another harness without failing the order", async () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const repo = integratedRepo();
    repos.push(repo.dir);
    const home = mkdtempSync(join(tmpdir(), "dim-builder-harness-"));
    homes.push(home);
    writeFileSync(
      join(home, "routing.json"),
      '{ "codex": { "light": "a", "standard": "b", "deep": "c" }, "claude": { "light": "a", "standard": "b", "deep": "c" } }',
    );
    const operator = mintWorker(db, { role: "operator", sessionId: "builder-harness-operator" });
    queueOrder(
      db,
      { id: "harness-order", project: "cniska/dim-factory", title: "Stay on one harness" },
      operator.name,
    );
    claimOrder(
      db,
      "harness-order",
      { runId: "plan-run", station: "dim-station-plan", operatorWorker: operator.name },
      operator.name,
      undefined,
      repo.dir,
    );
    const planner = mintWorker(db, {
      role: "planner",
      parentWorker: operator.name,
      sessionId: "harness/planner",
    });
    recordOrderPlan(db, "harness-order", "## Outcome\n\nBuild it.", planner.name, [
      { title: "Build it", outcome: "It is verified." },
    ]);
    approveOrderPlan(db, "harness-order", operator.name);
    moveOrder(db, "harness-order", "dim-station-build", operator.name);
    const env = {
      DIM_HOME: home,
      [WORKER_NAME_VAR]: operator.name,
      [WORKER_TOKEN_VAR]: operator.token,
      [WORKER_SESSION_VAR]: operator.sessionId,
    };
    const failures = () =>
      db
        .query("SELECT count(*) AS n FROM factory_order_event WHERE order_id = ? AND kind = 'failed'")
        .get("harness-order");

    await expect(
      runOrderBuildLive(db, "harness-order", operator.name, {
        dir: repo.dir,
        env,
        harness: "claude",
        adapter: fakeHarness("crash"),
      }),
    ).rejects.toThrow("fake process crashed");
    expect(failures()).toEqual({ n: 1 });
    // The fake reports no exit code, so the record must not claim one.
    expect(
      db
        .query<{ reason: string }, [string]>(
          "SELECT reason FROM factory_order_event WHERE order_id = ? AND kind = 'failed'",
        )
        .get("harness-order")?.reason,
    ).toMatch(/ did not finish: fake process crashed/);
    claimOrder(
      db,
      "harness-order",
      { runId: "retake-run", station: "dim-station-build", operatorWorker: operator.name },
      operator.name,
      undefined,
      repo.dir,
    );
    moveOrder(db, "harness-order", "dim-station-build", operator.name);
    const working = () =>
      db.query("SELECT status, run_id FROM factory_order WHERE id = ?").get("harness-order");
    expect(working()).toEqual({ status: "working", run_id: null });

    await expect(
      runOrderBuildLive(db, "harness-order", operator.name, { dir: repo.dir, env, harness: "codex" }),
    ).rejects.toThrow(
      "order harness-order builder runs under the claude harness; delegate it with --harness claude",
    );
    expect(() =>
      runOrderBuild(db, "harness-order", operator.name, {
        dir: repo.dir,
        env,
        harness: "codex",
        spawn: () => ({ exitCode: 0 }),
      }),
    ).toThrow("order harness-order builder runs under the claude harness; delegate it with --harness claude");
    expect(failures()).toEqual({ n: 1 });
    expect(working()).toEqual({ status: "working", run_id: null });
    db.close();
  });
});
