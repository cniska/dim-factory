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
  recordOrderBuild,
  recordOrderCheck,
  recordOrderCommit,
} from "./factory-order";
import { mintWorker, WORKER_NAME_VAR, WORKER_SESSION_VAR, WORKER_TOKEN_VAR } from "./factory-worker";
import { integratedRepo, orderWorktree, reviewOutput } from "./fixtures.test-support";
import { builderBrief, reviewFindingsForBuild } from "./order-build";
import { runOrderCommand } from "./order-command";
import { runOrderReview } from "./order-review";
import { SCHEMA_SQL } from "./schema";
import { ASSIGNMENT_ID_VAR, ASSIGNMENT_TOKEN_VAR, bootstrapWorker } from "./worker-assignment";
import { saveWorkerCredential } from "./worker-credential";

const repo = integratedRepo();
const worktrees: string[] = [];
afterAll(() => {
  for (const path of worktrees) rmSync(path, { recursive: true, force: true });
  rmSync(repo.dir, { recursive: true, force: true });
});

const machine = (() => {
  const home = orderWorktree(repo.dir, "loop-home");
  worktrees.push(home);
  writeFileSync(join(home, "routing.json"), '{ "codex": { "light": "s", "standard": "m", "deep": "l" } }');
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
      { runId: "build-1", station: "dim-station-build", operatorWorker: operator.name },
      builder.name,
      undefined,
      repo.dir,
    );

    const first = commit(worktree, "first");
    recordOrderCommit(db, "loop-order", first, builder.name, "feat: first");
    recordOrderCheck(db, "loop-order", { command: "bun run verify", exitCode: 0 }, builder.name);
    recordOrderBuild(db, "loop-order", "The first slice is built and verified.", first, builder.name);
    approveOrderBuild(db, "loop-order", operator.name, "the requested behavior is present");
    moveOrder(db, "loop-order", "dim-station-review", operator.name);

    const firstReview = runOrderReview(db, "loop-order", operator.name, {
      dir: worktree,
      env: workerEnv(operator),
      spawn: (_argv, env) => {
        if (!env[WORKER_NAME_VAR]) {
          const reviewer = bootstrapWorker(db, {
            id: env[ASSIGNMENT_ID_VAR] as string,
            token: env[ASSIGNMENT_TOKEN_VAR] as string,
            sessionId: `reviewer-${crypto.randomUUID()}`,
          });
          saveWorkerCredential(env, reviewer);
        }
        return {
          exitCode: 0,
          output: reviewOutput({
            findings: [
              {
                dimension: "correctness",
                file: "first.txt",
                line: 1,
                failure: "the first behavior is incomplete",
                fix: "complete the first behavior",
                severity: "high",
              },
            ],
          }),
        };
      },
    });
    expect(firstReview.findings).toBe(1);
    expect(() => approveOrderReview(db, "loop-order", operator.name)).toThrow(
      expect.objectContaining({ code: "finding_unsettled" }),
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
      { runId: "build-2", station: "dim-station-build", operatorWorker: operator.name },
      builder.name,
      undefined,
      repo.dir,
    );
    const second = commit(worktree, "fixed");
    recordOrderCommit(db, "loop-order", second, builder.name, "fix: complete behavior");
    recordOrderCheck(db, "loop-order", { command: "bun run verify", exitCode: 0 }, builder.name);
    recordOrderBuild(db, "loop-order", "The finding is fixed and verified.", second, builder.name);
    approveOrderBuild(db, "loop-order", operator.name, "the finding is answered");
    moveOrder(db, "loop-order", "dim-station-review", operator.name);
    const secondReview = runOrderReview(db, "loop-order", operator.name, {
      dir: worktree,
      env: workerEnv(operator),
      spawn: (_argv, _env) => {
        return {
          exitCode: 0,
          output: reviewOutput({ rulings: [{ finding: finding.id, ruling: "addressed", reason: null }] }),
        };
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
      { runId: "build-3", station: "dim-station-build", operatorWorker: operator.name },
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

  describe("a refusal the reviewer contests", () => {
    /** Round one raises a finding, the builder refuses it, and round two contests the refusal. */
    function contested(orderId: string) {
      const db = new Database(":memory:");
      db.run(SCHEMA_SQL);
      const operator = mintWorker(db, { role: "operator", sessionId: `${orderId}-operator` });
      const builder = mintWorker(db, {
        role: "builder",
        parentWorker: operator.name,
        sessionId: `${orderId}-operator/builder`,
      });
      const worktree = join(repo.dir, ".claude", "worktrees", orderId);
      queueOrder(db, { id: orderId, project: "cniska/dim-factory", title: "Contest" }, operator.name);
      const build = (run: string, name: string) => {
        claimOrder(
          db,
          orderId,
          { runId: run, station: "dim-station-build", operatorWorker: operator.name },
          builder.name,
          undefined,
          repo.dir,
        );
        const sha = commit(worktree, name);
        recordOrderCommit(db, orderId, sha, builder.name, `feat: ${name}`);
        recordOrderCheck(db, orderId, { command: "bun run verify", exitCode: 0 }, builder.name);
        recordOrderBuild(db, orderId, `The ${name} slice is built.`, sha, builder.name);
        approveOrderBuild(db, orderId, operator.name, "built");
        moveOrder(db, orderId, "dim-station-review", operator.name);
      };
      const review = (output: string) =>
        runOrderReview(db, orderId, operator.name, {
          dir: worktree,
          env: workerEnv(operator),
          spawn: (_argv, env) => {
            if (!env[WORKER_NAME_VAR]) {
              saveWorkerCredential(
                env,
                bootstrapWorker(db, {
                  id: env[ASSIGNMENT_ID_VAR] as string,
                  token: env[ASSIGNMENT_TOKEN_VAR] as string,
                  sessionId: `reviewer-${crypto.randomUUID()}`,
                }),
              );
            }
            return { exitCode: 0, output };
          },
        });
      build("build-1", `${orderId}-first`);
      review(
        reviewOutput({
          findings: [
            {
              dimension: "tests",
              file: `${orderId}-first.txt`,
              line: 1,
              failure: "no test holds the first behavior",
              fix: "add a test that fails without it",
              severity: "medium",
            },
          ],
        }),
      );
      const finding = db.query<{ id: number }, []>("SELECT id FROM factory_order_finding").get()
        ?.id as number;
      answerOrderFinding(
        db,
        finding,
        { answer: "refused", resolution: "the test is the next slice" },
        builder.name,
      );
      moveOrder(db, orderId, "dim-station-build", operator.name);
      build("build-2", `${orderId}-second`);
      review(
        reviewOutput({
          rulings: [{ finding, ruling: "refusal_contested", reason: "the plan puts the test in this slice" }],
        }),
      );
      const rule = (flag: string) =>
        runOrderCommand(
          db,
          ["rule", String(finding), flag, "--reason", "the owner has read both"],
          null,
          worktree,
          workerEnv(operator),
        );
      return { db, operator, builder, finding, rule };
    }

    test("holds approval until the owner upholds the refusal", () => {
      const { db, operator, builder, finding, rule } = contested("uphold-order");
      expect(() => approveOrderReview(db, "uphold-order", operator.name)).toThrow(
        expect.objectContaining({ code: "ruling_pending" }),
      );
      expect(() =>
        runOrderCommand(
          db,
          ["rule", String(finding), "--uphold", "--reason", "mine"],
          null,
          repo.dir,
          workerEnv(builder),
        ),
      ).toThrow(expect.objectContaining({ code: "worker_not_operator" }));
      expect(rule("--uphold")).toBe(`finding ${finding}: refusal upheld`);
      expect(() => approveOrderReview(db, "uphold-order", operator.name)).not.toThrow();
      db.close();
    });

    test("sends an overturned refusal back to the builder as open work", () => {
      const { db, operator, finding, rule } = contested("overturn-order");
      expect(db.query("SELECT hold FROM factory_order WHERE id = 'overturn-order'").get()).toEqual({
        hold: "approval",
      });
      expect(rule("--overturn")).toBe(`finding ${finding}: refusal overturned, back to the builder`);
      expect(() => approveOrderReview(db, "overturn-order", operator.name)).toThrow(
        expect.objectContaining({ code: "finding_unsettled" }),
      );
      expect(db.query("SELECT hold FROM factory_order WHERE id = 'overturn-order'").get()).toEqual({
        hold: null,
      });
      expect(() => rule("--uphold")).toThrow(expect.objectContaining({ code: "finding_not_awaiting_owner" }));
      const brief = builderBrief(
        { id: "overturn-order", title: "Contest", description: null },
        { body: "## Outcome\n\nContest.", slices: [] },
        null,
        null,
        undefined,
        undefined,
        reviewFindingsForBuild(db, "overturn-order"),
      );
      expect(brief).toContain(
        [
          "# Review findings",
          `- Finding ${finding} (tests, overturn-order-first.txt:1): no test holds the first behavior`,
          "  Fix: add a test that fails without it",
          "  The owner overturned your refusal: the owner has read both",
        ].join("\n"),
      );
      expect(brief).not.toContain("# Refused findings");
      db.close();
    });
  });
});
