import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  answerOrderFinding,
  approveOrderBuild,
  approveOrderReview,
  claimOrder,
  moveOrder,
  queueOrder,
  raiseOrderFinding,
  recordOrderCheck,
  recordOrderCommit,
} from "./factory-order";
import { mintWorker, WORKER_NAME_VAR, WORKER_SESSION_VAR, WORKER_TOKEN_VAR } from "./factory-worker";
import { integratedRepo, orderWorktree } from "./fixtures.test-support";
import { runOrderReview } from "./order-review";
import { SCHEMA_SQL } from "./schema";
import { ASSIGNMENT_ID_VAR, ASSIGNMENT_TOKEN_VAR, bootstrapWorker } from "./worker-assignment";

const repo = integratedRepo();
const worktrees: string[] = [];
afterAll(() => {
  for (const path of worktrees) rmSync(path, { recursive: true, force: true });
  rmSync(repo.dir, { recursive: true, force: true });
});

const machine = (() => {
  const home = orderWorktree(repo.dir, "loop-home");
  worktrees.push(home);
  writeFileSync(join(home, "routing.json"), '{ "cheap": "s", "standard": "m", "deep": "l" }');
  writeFileSync(
    join(home, "spawn.json"),
    JSON.stringify({
      argv: ["claude", "-p", "{brief}", "--model", "{model}", "--allowedTools", "{tools}"],
      slots: { tools: { join: "," } },
      grants: {
        "read-files": { tools: ["Read"] },
        "read-history": { tools: ["Bash(git diff:*)"] },
        "ask-dim": { tools: ["Bash(dim q:*)"] },
        "raise-finding": { tools: ["Bash(dim order finding:*)"] },
      },
    }),
  );
  return { DIM_HOME: home };
})();

function workerEnv(worker: { name: string; token: string; sessionId: string }): Record<string, string> {
  return {
    ...machine,
    [WORKER_NAME_VAR]: worker.name,
    [WORKER_TOKEN_VAR]: worker.token,
    [WORKER_SESSION_VAR]: worker.sessionId,
  };
}

function commit(worktree: string, name: string): string {
  writeFileSync(join(worktree, `${name}.txt`), name);
  Bun.spawnSync(["git", "-C", worktree, "add", "."]);
  Bun.spawnSync(["git", "-C", worktree, "commit", "-q", "-m", `feat: ${name}`]);
  return Bun.spawnSync(["git", "-C", worktree, "rev-parse", "HEAD"], { stdout: "pipe" })
    .stdout.toString()
    .trim();
}

describe("the operator loop", () => {
  test("returns findings to the builder before approving and shipping the clean outcome", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const operator = mintWorker(db, { role: "operator", sessionId: "loop-operator" });
    const builder = mintWorker(db, {
      role: "builder",
      parentWorker: operator.name,
      sessionId: "loop-operator/builder",
    });
    const worktree = join(repo.dir, ".claude", "worktrees", "loop-order");
    queueOrder(db, { id: "loop-order", project: "cniska/dim-factory", title: "Run the loop" }, operator.name);
    claimOrder(
      db,
      "loop-order",
      { runId: "build-1", station: "dim-station-build" },
      builder.name,
      undefined,
      repo.dir,
    );

    const first = commit(worktree, "first");
    recordOrderCommit(db, "loop-order", first, builder.name, "feat: first");
    recordOrderCheck(db, "loop-order", { command: "bun run verify", exitCode: 0 }, builder.name);
    approveOrderBuild(db, "loop-order", operator.name, "the requested behavior is present");
    moveOrder(db, "loop-order", "dim-station-review", operator.name);

    const firstReview = runOrderReview(db, "loop-order", operator.name, {
      dir: worktree,
      env: workerEnv(operator),
      spawn: (_argv, env) => {
        const reviewerWorker = bootstrapWorker(db, {
          id: env[ASSIGNMENT_ID_VAR] as string,
          token: env[ASSIGNMENT_TOKEN_VAR] as string,
          sessionId: `reviewer-${crypto.randomUUID()}`,
        });
        const reviewer = reviewerWorker.name;
        raiseOrderFinding(
          db,
          "loop-order",
          { dimension: "correctness", summary: "the first behavior is incomplete" },
          reviewer,
        );
        return { exitCode: 0 };
      },
    });
    expect(firstReview.findings).toBe(1);
    expect(() => approveOrderReview(db, "loop-order", operator.name)).toThrow(
      expect.objectContaining({ code: "findings_present" }),
    );
    const finding = db.query<{ id: number }, []>("SELECT id FROM factory_order_finding").get();
    if (!finding) throw new Error("loop test did not raise a finding");
    answerOrderFinding(
      db,
      finding.id,
      { answer: "fixed", resolution: "completed the missing behavior" },
      builder.name,
    );

    moveOrder(db, "loop-order", "dim-station-build", operator.name);
    claimOrder(
      db,
      "loop-order",
      { runId: "build-2", station: "dim-station-build" },
      builder.name,
      undefined,
      repo.dir,
    );
    const second = commit(worktree, "fixed");
    recordOrderCommit(db, "loop-order", second, builder.name, "fix: complete behavior");
    recordOrderCheck(db, "loop-order", { command: "bun run verify", exitCode: 0 }, builder.name);
    approveOrderBuild(db, "loop-order", operator.name, "the finding is answered");
    moveOrder(db, "loop-order", "dim-station-review", operator.name);
    const secondReview = runOrderReview(db, "loop-order", operator.name, {
      dir: worktree,
      env: workerEnv(operator),
      spawn: (_argv, env) => {
        bootstrapWorker(db, {
          id: env[ASSIGNMENT_ID_VAR] as string,
          token: env[ASSIGNMENT_TOKEN_VAR] as string,
          sessionId: `reviewer-${crypto.randomUUID()}`,
        });
        return { exitCode: 0 };
      },
    });
    expect(secondReview.findings).toBe(0);
    expect(() => moveOrder(db, "loop-order", "ship", operator.name)).toThrow(
      expect.objectContaining({ code: "review_not_approved" }),
    );
    approveOrderReview(db, "loop-order", operator.name);

    const events = db
      .query<{ kind: string; worker: string; review_id: number | null }, [string]>(
        "SELECT kind, worker, review_id FROM factory_order_event WHERE order_id = ? ORDER BY id",
      )
      .all("loop-order");
    expect(events.filter((event) => event.kind === "review_approved")).toEqual([
      { kind: "review_approved", worker: operator.name, review_id: secondReview.review },
    ]);
    expect(
      db
        .query<{ role: string }, []>(
          "SELECT w.role FROM factory_order_event e JOIN factory_worker w ON w.name = e.worker WHERE e.kind = 'finding_raised'",
        )
        .get(),
    ).toEqual({ role: "reviewer" });
    expect(events.filter((event) => event.kind === "finding_answered")[0]?.worker).toBe(builder.name);
    expect(() => moveOrder(db, "loop-order", "ship", operator.name)).not.toThrow();
    moveOrder(db, "loop-order", "dim-station-build", operator.name);
    claimOrder(
      db,
      "loop-order",
      { runId: "build-3", station: "dim-station-build" },
      builder.name,
      undefined,
      repo.dir,
    );
    recordOrderCommit(db, "loop-order", "later-commit", builder.name, "fix: another change");
    expect(() => moveOrder(db, "loop-order", "ship", operator.name)).toThrow(
      expect.objectContaining({ code: "review_not_approved" }),
    );
    db.close();
  });
});
