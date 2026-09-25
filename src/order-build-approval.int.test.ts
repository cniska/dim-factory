import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  appendOrderEvent,
  claimOrder,
  queueOrder,
  recordOrderBuild,
  recordOrderCheck,
  recordOrderCommit,
  returnedOrderArtifact,
} from "./factory-order";
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

describe("build approval integration", () => {
  test("returns a Build artifact after its failed attempt requeues the order", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const repo = integratedRepo();
    repos.push(repo.dir);
    const operator = mintWorker(db, { role: "operator", sessionId: "queued-return-operator" });
    const builder = mintWorker(db, {
      role: "builder",
      parentWorker: operator.name,
      sessionId: "queued-return-operator/builder",
    });
    queueOrder(
      db,
      { id: "queued-return-order", project: "cniska/dim-factory", title: "Return the Build" },
      operator.name,
    );
    claimOrder(
      db,
      "queued-return-order",
      { runId: "queued-return-run", station: "dim-station-build", operatorWorker: operator.name },
      builder.name,
      undefined,
      repo.dir,
    );
    recordOrderCommit(db, "queued-return-order", repo.sha, builder.name, "feat: build it");
    recordOrderCheck(
      db,
      "queued-return-order",
      { command: "bun run verify", exitCode: 0, result: "green" },
      builder.name,
    );
    recordOrderBuild(db, "queued-return-order", "## Outcome\n\nBuild it.", repo.sha, builder.name);
    appendOrderEvent(db, "queued-return-order", {
      kind: "failed",
      worker: builder.name,
      reason: "runner could not complete the attempt",
    });

    expect(
      db.query("SELECT status, hold FROM factory_order WHERE id = ?").get("queued-return-order"),
    ).toEqual({
      status: "queued",
      hold: "approval",
    });
    expect(() =>
      appendOrderEvent(db, "queued-return-order", {
        kind: "artifact_returned",
        worker: operator.name,
        station: "dim-station-build",
        buildId: 1,
        commitSha: repo.sha,
        reason: "direct event writes cannot return the artifact",
      }),
    ).toThrow("order queued-return-order must be working before it can artifact_returned");
    expect(
      runOrderCommand(
        db,
        ["return", "queued-return-order", "--reason", "Explain the verified result for review."],
        null,
        repo.dir,
        env(operator),
      ),
    ).toContain("returned");
    expect(
      db.query("SELECT status, hold FROM factory_order WHERE id = ?").get("queued-return-order"),
    ).toEqual({
      status: "working",
      hold: null,
    });
    expect(returnedOrderArtifact(db, "queued-return-order", "build")).toEqual({
      station: "build",
      reason: "Explain the verified result for review.",
      buildId: 1,
      body: "## Outcome\n\nBuild it.",
      headSha: repo.sha,
    });
    db.close();
  });

  test("requires the operator to approve the checked final build", () => {
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
    claimOrder(
      db,
      "build-approval-order",
      { runId: "build-run", station: "dim-station-build", operatorWorker: operator.name },
      builder.name,
      undefined,
      repo.dir,
    );
    expect(
      db.query("SELECT role, parent_worker FROM factory_worker WHERE name = ?").get(builder.name),
    ).toEqual({
      role: "builder",
      parent_worker: operator.name,
    });

    expect(() =>
      runOrderCommand(
        db,
        ["review", "build-approval-order", "--harness", "codex"],
        null,
        repo.dir,
        env(operator),
      ),
    ).toThrow(expect.objectContaining({ code: "build_not_approved" }));

    expect(() =>
      runOrderCommand(
        db,
        ["review", "build-approval-order", "--harness", "codex"],
        null,
        repo.dir,
        env(builder),
      ),
    ).toThrow(expect.objectContaining({ code: "worker_not_operator" }));

    recordOrderCommit(db, "build-approval-order", repo.sha, builder.name, "feat: build it");
    recordOrderCheck(
      db,
      "build-approval-order",
      { command: "bun run verify", exitCode: 0, result: "green" },
      builder.name,
    );
    recordOrderBuild(
      db,
      "build-approval-order",
      "The build is complete and verified.",
      repo.sha,
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
      station: "build",
      reason: "Explain the verified result, not the command log.",
      buildId: 1,
      body: "The build is complete and verified.",
      headSha: repo.sha,
    });
    expect(() =>
      recordOrderBuild(
        db,
        "build-approval-order",
        "## Outcome\n\nThe wrong revision.",
        "different-head",
        builder.name,
      ),
    ).toThrow(expect.objectContaining({ code: "build_revision_head_mismatch" }));
    expect(() =>
      runOrderCommand(
        db,
        ["approve", "build-approval-order", "--reason", "answers the request"],
        null,
        repo.dir,
        env(operator),
      ),
    ).toThrow(expect.objectContaining({ code: "artifact_revision_required" }));
    recordOrderCommit(
      db,
      "build-approval-order",
      "new-head",
      builder.name,
      "fix: repair the build",
      "2026-09-25T10:02:00.000Z",
    );
    expect(() =>
      recordOrderBuild(
        db,
        "build-approval-order",
        "## Outcome\n\nThe check is missing.",
        "new-head",
        builder.name,
      ),
    ).toThrow(expect.objectContaining({ code: "order_not_checked" }));
    recordOrderCheck(
      db,
      "build-approval-order",
      { command: "bun run verify", exitCode: 0, result: "green" },
      builder.name,
      "2026-09-25T10:01:00.000Z",
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
    expect(
      runOrderCommand(
        db,
        ["move", "build-approval-order", "--station", "dim-station-review"],
        null,
        repo.dir,
        env(operator),
      ),
    ).toContain("moved");
    expect(
      db
        .query(
          "SELECT kind, worker, commit_sha, reason FROM factory_order_event WHERE order_id = ? ORDER BY id",
        )
        .all("build-approval-order"),
    ).toEqual([
      { kind: "queued", worker: operator.name, commit_sha: null, reason: null },
      { kind: "claimed", worker: builder.name, commit_sha: null, reason: null },
      { kind: "commit_created", worker: builder.name, commit_sha: repo.sha, reason: null },
      { kind: "check_finished", worker: builder.name, commit_sha: null, reason: null },
      { kind: "build_artifact_written", worker: builder.name, commit_sha: null, reason: null },
      { kind: "hold_set", worker: builder.name, commit_sha: null, reason: null },
      {
        kind: "artifact_returned",
        worker: operator.name,
        commit_sha: repo.sha,
        reason: "Explain the verified result, not the command log.",
      },
      { kind: "owner_verdict_recorded", worker: operator.name, commit_sha: null, reason: null },
      { kind: "hold_released", worker: operator.name, commit_sha: null, reason: null },
      { kind: "commit_created", worker: builder.name, commit_sha: "new-head", reason: null },
      { kind: "check_finished", worker: builder.name, commit_sha: null, reason: null },
      { kind: "build_artifact_written", worker: builder.name, commit_sha: null, reason: null },
      { kind: "hold_set", worker: builder.name, commit_sha: null, reason: null },
      { kind: "owner_verdict_recorded", worker: operator.name, commit_sha: null, reason: null },
      {
        kind: "build_approved",
        worker: operator.name,
        commit_sha: "new-head",
        reason: "answers the request",
      },
      { kind: "hold_released", worker: operator.name, commit_sha: null, reason: null },
      { kind: "moved", worker: operator.name, commit_sha: null, reason: null },
    ]);
    db.close();
  });
});
