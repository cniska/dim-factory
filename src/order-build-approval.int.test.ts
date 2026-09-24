import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  claimOrder,
  queueOrder,
  recordOrderBuild,
  recordOrderCheck,
  recordOrderCommit,
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
    expect(() =>
      runOrderCommand(
        db,
        ["approve", "build-approval-order", "--reason", "answers the request"],
        null,
        repo.dir,
        env(operator),
      ),
    ).toThrow(expect.objectContaining({ code: "artifact_revision_required" }));
    recordOrderBuild(
      db,
      "build-approval-order",
      "## Outcome\n\nThe request is complete.",
      repo.sha,
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
        .query("SELECT kind, worker, commit_sha, reason FROM factory_order_event WHERE order_id = ?")
        .all("build-approval-order"),
    ).toEqual([
      { kind: "queued", worker: operator.name, commit_sha: null, reason: null },
      { kind: "claimed", worker: builder.name, commit_sha: null, reason: null },
      { kind: "commit_created", worker: builder.name, commit_sha: repo.sha, reason: null },
      { kind: "check_finished", worker: builder.name, commit_sha: null, reason: null },
      { kind: "build_artifact_written", worker: builder.name, commit_sha: null, reason: null },
      {
        kind: "artifact_returned",
        worker: operator.name,
        commit_sha: repo.sha,
        reason: "Explain the verified result, not the command log.",
      },
      { kind: "build_artifact_written", worker: builder.name, commit_sha: null, reason: null },
      { kind: "build_approved", worker: operator.name, commit_sha: repo.sha, reason: "answers the request" },
      { kind: "moved", worker: operator.name, commit_sha: null, reason: null },
    ]);
    db.close();
  });
});
