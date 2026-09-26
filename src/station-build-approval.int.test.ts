import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { SCHEMA_SQL } from "./db-schema";
import { attemptIn, integratedRepo, ranCheck } from "./fixtures.test-support";
import {
  completeOrderSlice,
  nextOrderSlice,
  recordOrderBuild,
  returnedOrderArtifact,
} from "./order-artifacts";
import { openAttempt } from "./order-attempt";
import { runOrderCommand, runOrderCommandLive } from "./order-command";
import { recordOrderCheck, recordOrderCommit } from "./order-evidence";
import { appendOrderEvent } from "./order-ledger";
import { queueOrder, startOrder } from "./order-lifecycle";
import { orderState } from "./order-state";
import { orderStatus } from "./order-status";
import { approvePlan } from "./station-approvals.test-support";
import { mintWorker, WORKER_NAME_VAR, WORKER_SESSION_VAR, WORKER_TOKEN_VAR } from "./worker";

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

describe("build approval integration", () => {
  test("returns a Build artifact after a failed attempt, which leaves the order working", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const repo = integratedRepo();
    repos.push(repo.dir);
    const operator = mintWorker(db, { role: "operator", sessionId: "failed-return-operator" });
    const builder = mintWorker(db, {
      role: "builder",
      parentWorker: operator.name,
      sessionId: "failed-return-operator/builder",
    });
    queueOrder(
      db,
      { id: "failed-return-order", project: "cniska/dim-factory", title: "Return the Build" },
      operator.name,
    );
    startOrder(db, "failed-return-order", operator.name, undefined, repo.dir);
    approvePlan(db, "failed-return-order", operator.name);
    attemptIn(db, "failed-return-order", builder.name, operator.name, "built-run");
    recordOrderCommit(db, "failed-return-order", repo.sha, builder.name, "feat: build it");
    recordOrderCheck(
      db,
      "failed-return-order",
      ranCheck({ command: "bun run verify", exitCode: 0, result: "green" }),
      builder.name,
    );
    const build = recordOrderBuild(
      db,
      "failed-return-order",
      "## Outcome\n\nBuild it.",
      repo.sha,
      builder.name,
    );
    completeOrderSlice(
      db,
      "failed-return-order",
      nextOrderSlice(db, "failed-return-order")?.id as number,
      builder.name,
    );
    attemptIn(db, "failed-return-order", builder.name, operator.name, "failing-run");
    appendOrderEvent(db, "failed-return-order", {
      kind: "failed",
      worker: builder.name,
      reason: "runner could not complete the attempt",
    });

    expect(orderStatus(db, "failed-return-order")).toBe("active");
    expect(openAttempt(db, "failed-return-order")).toBeNull();
    expect(
      db
        .query(
          "SELECT outcome, reason FROM factory_order_attempt WHERE run_id = 'failing-run' AND kind = 'finished'",
        )
        .get(),
    ).toEqual({ outcome: "failed", reason: "runner could not complete the attempt" });
    expect(orderState(db, "failed-return-order")).toEqual({ station: "build", next: "approve" });
    expect(
      runOrderCommand(
        db,
        ["return", "failed-return-order", "--reason", "Explain the verified result for review."],
        null,
        repo.dir,
        env(operator),
      ),
    ).toContain("returned");
    expect(orderState(db, "failed-return-order")).toEqual({ station: "build", next: "run" });
    expect(returnedOrderArtifact(db, "failed-return-order", "build")).toEqual({
      reason: "Explain the verified result for review.",
      artifactId: build,
      body: "## Outcome\n\nBuild it.",
    });
    db.close();
  });

  test("requires the operator to approve the checked final build", async () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const repo = integratedRepo();
    repos.push(repo.dir);
    const operator = mintWorker(db, { role: "operator", sessionId: "build-operator" });
    const builder = mintWorker(db, {
      role: "builder",
      parentWorker: operator.name,
      sessionId: "build-operator/builder",
    });
    queueOrder(
      db,
      { id: "build-approval-order", project: "cniska/dim-factory", title: "Approve the build" },
      operator.name,
    );
    startOrder(db, "build-approval-order", operator.name, undefined, repo.dir);
    approvePlan(db, "build-approval-order", operator.name);
    expect(
      db.query("SELECT role, parent_worker FROM factory_worker WHERE name = ?").get(builder.name),
    ).toEqual({
      role: "builder",
      parent_worker: operator.name,
    });

    await expect(
      runOrderCommandLive(
        db,
        ["review", "build-approval-order", "--harness", "codex"],
        null,
        repo.dir,
        env(operator),
      ),
    ).rejects.toThrow(
      expect.objectContaining({ code: "not_next", message: expect.stringContaining("run at build") }),
    );

    await expect(
      runOrderCommandLive(
        db,
        ["review", "build-approval-order", "--harness", "codex"],
        null,
        repo.dir,
        env(builder),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "worker_not_operator" }));

    attemptIn(db, "build-approval-order", builder.name, operator.name, "build-run");
    recordOrderCommit(db, "build-approval-order", repo.sha, builder.name, "feat: build it");
    recordOrderCheck(
      db,
      "build-approval-order",
      ranCheck({ command: "bun run verify", exitCode: 0, result: "green" }),
      builder.name,
    );
    const build = recordOrderBuild(
      db,
      "build-approval-order",
      "The build is complete and verified.",
      repo.sha,
      builder.name,
    );
    completeOrderSlice(
      db,
      "build-approval-order",
      nextOrderSlice(db, "build-approval-order")?.id as number,
      builder.name,
    );
    expect(
      runOrderCommand(
        db,
        ["return", "build-approval-order", "--reason", "Explain the verified result, not the command log."],
        null,
        repo.dir,
        env(operator),
      ),
    ).toContain("returned");
    expect(returnedOrderArtifact(db, "build-approval-order", "build")).toEqual({
      reason: "Explain the verified result, not the command log.",
      artifactId: build,
      body: "The build is complete and verified.",
    });
    expect(() =>
      recordOrderBuild(db, "build-approval-order", "## Outcome\n\nNo turn.", repo.sha, builder.name),
    ).toThrow(expect.objectContaining({ code: "build_artifact_before_final_slice" }));
    expect(() =>
      runOrderCommand(
        db,
        ["approve", "build-approval-order", "--reason", "answers the request"],
        null,
        repo.dir,
        env(operator),
      ),
    ).toThrow(
      expect.objectContaining({ code: "not_next", message: expect.stringContaining("run at build") }),
    );
    attemptIn(db, "build-approval-order", builder.name, operator.name, "revision-run");
    recordOrderCommit(db, "build-approval-order", "new-head", builder.name, "fix: repair the build");
    recordOrderCheck(
      db,
      "build-approval-order",
      ranCheck({ command: "bun run verify", exitCode: 0, result: "green" }),
      builder.name,
    );
    recordOrderBuild(
      db,
      "build-approval-order",
      "## Outcome\n\nThe request is complete.",
      "new-head",
      builder.name,
    );

    expect(() =>
      runOrderCommand(
        db,
        ["approve", "build-approval-order", "--reason", "answers the request"],
        null,
        repo.dir,
        env(builder),
      ),
    ).toThrow(expect.objectContaining({ code: "worker_not_operator" }));
    expect(
      runOrderCommand(
        db,
        ["approve", "build-approval-order", "--reason", "answers the request"],
        null,
        repo.dir,
        env(operator),
      ),
    ).toContain("build approved");
    expect(orderState(db, "build-approval-order")).toEqual({ station: "review", next: "run" });
    expect(
      db
        .query(
          `SELECT e.kind, e.worker, e.commit_sha, a.head_sha AS artifact_head, e.reason
           FROM factory_order_event e
           LEFT JOIN factory_order_artifact a ON a.id = e.artifact_id
           WHERE e.order_id = ? ORDER BY e.id`,
        )
        .all("build-approval-order"),
    ).toEqual([
      { kind: "queued", worker: operator.name, commit_sha: null, artifact_head: null, reason: null },
      { kind: "started", worker: operator.name, commit_sha: null, artifact_head: null, reason: null },
      {
        kind: "artifact_written",
        worker: operator.name,
        commit_sha: null,
        artifact_head: null,
        reason: null,
      },
      {
        kind: "artifact_approved",
        worker: operator.name,
        commit_sha: null,
        artifact_head: null,
        reason: null,
      },
      {
        kind: "commit_created",
        worker: builder.name,
        commit_sha: repo.sha,
        artifact_head: null,
        reason: null,
      },
      { kind: "check_finished", worker: builder.name, commit_sha: null, artifact_head: null, reason: null },
      {
        kind: "artifact_written",
        worker: builder.name,
        commit_sha: null,
        artifact_head: repo.sha,
        reason: null,
      },
      {
        kind: "artifact_returned",
        worker: operator.name,
        commit_sha: null,
        artifact_head: repo.sha,
        reason: "Explain the verified result, not the command log.",
      },
      {
        kind: "commit_created",
        worker: builder.name,
        commit_sha: "new-head",
        artifact_head: null,
        reason: null,
      },
      { kind: "check_finished", worker: builder.name, commit_sha: null, artifact_head: null, reason: null },
      {
        kind: "artifact_written",
        worker: builder.name,
        commit_sha: null,
        artifact_head: "new-head",
        reason: null,
      },
      {
        kind: "artifact_approved",
        worker: operator.name,
        commit_sha: null,
        artifact_head: "new-head",
        reason: "answers the request",
      },
    ]);
    db.close();
  });
});
