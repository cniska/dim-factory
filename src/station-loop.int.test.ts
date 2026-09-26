import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_SQL } from "./db-schema";
import { attemptIn, integratedRepo, orderWorktree, reviewOutput } from "./fixtures.test-support";
import { scriptedHarness } from "./harness-scripted.test-support";
import { approveOrder } from "./order-approval";
import { completeOrderSlice, nextOrderSlice, recordOrderBuild, recordOrderPlan } from "./order-artifacts";
import { finishAttempt } from "./order-attempt";
import { runOrderCommand } from "./order-command";
import { recordOrderCheck, recordOrderCommit } from "./order-evidence";
import { answerOrderFindings } from "./order-finding";
import { queueOrder, startOrder } from "./order-lifecycle";
import { shipOrder } from "./order-ship";
import { orderState } from "./order-state";
import { approvePlan } from "./station-approvals.test-support";
import { builderBrief, reviewFindingsForBuild } from "./station-build";
import { runOrderReviewLive } from "./station-review";
import { mintWorker, WORKER_NAME_VAR, WORKER_SESSION_VAR, WORKER_TOKEN_VAR } from "./worker";

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
  test("returns findings to the builder before approving and shipping the clean outcome", async () => {
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
    startOrder(db, "loop-order", operator.name, undefined, repo.dir);
    recordOrderPlan(db, "loop-order", "## Outcome\n\nRun the loop.", operator.name, [
      { title: "Run the loop", outcome: "the loop runs" },
    ]);
    approveOrder(db, "loop-order", operator.name, undefined);
    attemptIn(db, "loop-order", builder.name, operator.name, "build-1");

    const first = commit(worktree, "first");
    recordOrderCommit(db, "loop-order", first, builder.name, "feat: first");
    recordOrderCheck(db, "loop-order", { command: "bun run verify", exitCode: 0 }, builder.name);
    recordOrderBuild(db, "loop-order", "The first slice is built and verified.", first, builder.name);
    completeOrderSlice(db, "loop-order", nextOrderSlice(db, "loop-order")?.id as number, builder.name);
    approveOrder(db, "loop-order", operator.name, "the requested behavior is present");

    const firstReview = await runOrderReviewLive(db, "loop-order", operator.name, {
      dir: worktree,
      env: workerEnv(operator),
      harness: "codex",
      adapter: scriptedHarness(() => ({
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
      })),
    });
    expect(firstReview.findings).toBe(1);
    expect(() => approveOrder(db, "loop-order", operator.name, undefined)).toThrow(
      expect.objectContaining({ code: "not_next", message: expect.stringContaining("run at build") }),
    );
    const finding = db.query<{ id: number }, []>("SELECT id FROM factory_order_finding").get();
    if (!finding) throw new Error("loop test did not raise a finding");
    answerOrderFindings(
      db,
      "loop-order",
      "build-2",
      [{ finding: finding.id, answer: "fixed", resolution: "completed the missing behavior" }],
      builder.name,
    );

    attemptIn(db, "loop-order", builder.name, operator.name, "build-2");
    const second = commit(worktree, "fixed");
    recordOrderCommit(db, "loop-order", second, builder.name, "fix: complete behavior");
    recordOrderCheck(db, "loop-order", { command: "bun run verify", exitCode: 0 }, builder.name);
    recordOrderBuild(db, "loop-order", "The finding is fixed and verified.", second, builder.name);
    finishAttempt(db, "loop-order", "succeeded", undefined, new Date().toISOString());
    approveOrder(db, "loop-order", operator.name, "the finding is answered");
    const secondReview = await runOrderReviewLive(db, "loop-order", operator.name, {
      dir: worktree,
      env: workerEnv(operator),
      harness: "codex",
      adapter: scriptedHarness(() => ({
        output: reviewOutput({ rulings: [{ finding: finding.id, ruling: "addressed", reason: null }] }),
      })),
    });
    expect(secondReview.findings).toBe(0);
    expect(() => shipOrder(db, "loop-order", worktree, operator.name)).toThrow(
      expect.objectContaining({ code: "not_next", message: expect.stringContaining("approve at review") }),
    );
    approveOrder(db, "loop-order", operator.name, undefined);

    const events = db
      .query<{ kind: string; worker: string; review_id: number | null }, [string]>(
        "SELECT kind, worker, review_id FROM factory_order_event WHERE order_id = ? ORDER BY id",
      )
      .all("loop-order");
    expect(
      db
        .query(
          `SELECT e.worker, a.review_id FROM factory_order_event e
           JOIN factory_order_artifact a ON a.id = e.artifact_id
           WHERE e.order_id = ? AND e.kind = 'artifact_approved' AND a.kind = 'review'`,
        )
        .all("loop-order"),
    ).toEqual([{ worker: operator.name, review_id: secondReview.review }]);
    expect(
      db
        .query<{ role: string }, []>(
          "SELECT w.role FROM factory_order_event e JOIN factory_worker w ON w.name = e.worker WHERE e.kind = 'finding_raised'",
        )
        .get(),
    ).toEqual({ role: "reviewer" });
    expect(events.filter((event) => event.kind === "finding_answered")[0]?.worker).toBe(builder.name);
    expect(orderState(db, "loop-order")).toEqual({ station: null, next: "ship" });
    attemptIn(db, "loop-order", builder.name, operator.name, "build-3");
    recordOrderCommit(db, "loop-order", "later-commit", builder.name, "fix: another change");
    recordOrderCheck(db, "loop-order", { command: "bun run verify", exitCode: 0 }, builder.name);
    recordOrderBuild(db, "loop-order", "Another change is built and verified.", "later-commit", builder.name);
    finishAttempt(db, "loop-order", "succeeded", undefined, new Date().toISOString());
    approveOrder(db, "loop-order", operator.name, "the change is present");
    expect(() => shipOrder(db, "loop-order", worktree, operator.name)).toThrow(
      expect.objectContaining({ code: "not_next", message: expect.stringContaining("run at review") }),
    );
    db.close();
  });

  describe("a refusal the reviewer contests", () => {
    async function contested(orderId: string) {
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
      startOrder(db, orderId, operator.name, undefined, repo.dir);
      approvePlan(db, orderId, operator.name);
      const build = (run: string, name: string) => {
        attemptIn(db, orderId, builder.name, operator.name, run);
        const sha = commit(worktree, name);
        recordOrderCommit(db, orderId, sha, builder.name, `feat: ${name}`);
        recordOrderCheck(db, orderId, { command: "bun run verify", exitCode: 0 }, builder.name);
        recordOrderBuild(db, orderId, `The ${name} slice is built.`, sha, builder.name);
        const left = nextOrderSlice(db, orderId);
        if (left) completeOrderSlice(db, orderId, left.id, builder.name);
        else finishAttempt(db, orderId, "succeeded", undefined, new Date().toISOString());
        approveOrder(db, orderId, operator.name, "built");
      };
      const review = (output: string) =>
        runOrderReviewLive(db, orderId, operator.name, {
          dir: worktree,
          env: workerEnv(operator),
          harness: "codex",
          adapter: scriptedHarness(() => ({ output })),
        });
      build("build-1", `${orderId}-first`);
      await review(
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
      answerOrderFindings(
        db,
        orderId,
        "build-2",
        [{ finding, answer: "refused", resolution: "the test is the next slice" }],
        builder.name,
      );
      build("build-2", `${orderId}-second`);
      await review(
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

    test("refuses approval until the owner upholds the refusal", async () => {
      const { db, operator, builder, finding, rule } = await contested("uphold-order");
      expect(() => approveOrder(db, "uphold-order", operator.name, undefined)).toThrow(
        expect.objectContaining({ code: "not_next", message: expect.stringContaining("rule at review") }),
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
      expect(approveOrder(db, "uphold-order", operator.name, undefined)).toBe("review");
      expect(orderState(db, "uphold-order")).toEqual({ station: null, next: "ship" });
      db.close();
    });

    test("sends an overturned refusal back to the builder as open work", async () => {
      const { db, operator, finding, rule } = await contested("overturn-order");
      expect(orderState(db, "overturn-order")).toEqual({ station: "review", next: "rule" });
      expect(rule("--overturn")).toBe(`finding ${finding}: refusal overturned, back to the builder`);
      expect(() => approveOrder(db, "overturn-order", operator.name, undefined)).toThrow(
        expect.objectContaining({ code: "not_next", message: expect.stringContaining("run at build") }),
      );
      expect(orderState(db, "overturn-order")).toEqual({ station: "build", next: "run" });
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
          "  The owner overturned your refusal, so answer it fixed: the owner has read both",
        ].join("\n"),
      );
      expect(brief).not.toContain("# Refused findings");
      db.close();
    });
  });
});
