import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "./db-schema";
import { attemptIn, integratedRepo, located, orderWorktree, reviewOutput } from "./fixtures.test-support";
import type { HarnessRequest } from "./harness";
import { codexProcess } from "./harness-codex";
import { fakeHarness } from "./harness-fake";
import { commandLine } from "./harness-process";
import { type ScriptedAnswer, scriptedHarness } from "./harness-scripted.test-support";
import { approveOrder } from "./order-approval";
import {
  completeOrderSlice,
  nextOrderSlice,
  recordOrderBuild,
  returnedOrderArtifact,
} from "./order-artifacts";
import { finishAttempt } from "./order-attempt";
import { runOrderCommand } from "./order-command";
import { recordOrderCheck, recordOrderCommit } from "./order-evidence";
import { answerOrderFindings, raiseOrderFinding } from "./order-finding";
import { queueOrder, startOrder } from "./order-lifecycle";
import { orderState } from "./order-state";
import { approvePlan } from "./station-approvals.test-support";
import { ReviewRefused, reviewerBrief, reviewRange, runOrderReviewLive } from "./station-review";
import { mintWorker, WORKER_NAME_VAR, WORKER_SESSION_VAR, WORKER_TOKEN_VAR } from "./worker";
import { ASSIGNMENT_TOKEN_VAR } from "./worker-assignment";

const trunk = integratedRepo();
const worktrees: string[] = [];
const opened: Database[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  for (const path of worktrees) rmSync(path, { recursive: true, force: true });
  rmSync(trunk.dir, { recursive: true, force: true });
});

function argvOf(request: HarnessRequest): string[] {
  return commandLine(codexProcess, request);
}

function answering(output: string): () => ScriptedAnswer {
  return () => ({ output });
}

function findingOn(file: string, fields: Record<string, unknown> = {}) {
  return {
    dimension: "correctness",
    file,
    line: 1,
    failure: "the guard is the wrong way round",
    fix: "invert the guard",
    severity: "high",
    ...fields,
  };
}

const machine = (() => {
  const home = orderWorktree(trunk.dir, "routing-home");
  worktrees.push(home);
  writeFileSync(join(home, "routing.json"), '{ "codex": { "light": "s", "standard": "m", "deep": "l" } }');
  return { DIM_HOME: home };
})();

function review(
  db: Database,
  operator: string,
  dir: string,
  answer: (request: HarnessRequest) => ScriptedAnswer,
  env: Record<string, string> = machine,
) {
  return runOrderReviewLive(db, "order-1", operator, {
    dir,
    env,
    harness: "codex",
    adapter: scriptedHarness(answer),
  });
}

function floor(): {
  db: Database;
  worker: string;
  operator: string;
  operatorToken: string;
  operatorSession: string;
  builderToken: string;
  builderSession: string;
  dir: string;
} {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  const operator = mintWorker(db, { role: "operator", sessionId: `operator-${opened.length}` });
  opened.push(db);
  const builder = mintWorker(db, { role: "builder", sessionId: `builder-${opened.length}` });
  const dir = orderWorktree(trunk.dir, `review-${opened.length}`);
  worktrees.push(dir);
  queueOrder(db, { id: "order-1", project: "cniska/dim-factory", title: "Read a slice" }, operator.name);
  startOrder(db, "order-1", operator.name, undefined, trunk.dir);
  approvePlan(db, "order-1", operator.name);
  return {
    db,
    worker: builder.name,
    operator: operator.name,
    operatorToken: operator.token,
    operatorSession: operator.sessionId,
    builderToken: builder.token,
    builderSession: builder.sessionId,
    dir,
  };
}

function slice(
  db: Database,
  dir: string,
  worker: string,
  name: string,
  files: Record<string, string | null> = { [`${name}.txt`]: name },
): string {
  const operator = db
    .query<{ name: string }, []>("SELECT name FROM factory_worker WHERE role = 'operator'")
    .get();
  if (!operator) throw new Error("review fixture has no operator");
  attemptIn(db, "order-1", worker, operator.name, `run-${name}`);
  for (const [path, content] of Object.entries(files)) {
    if (content === null) rmSync(join(dir, path));
    else writeFileSync(join(dir, path), content);
  }
  Bun.spawnSync(["git", "-C", dir, "add", "-A"]);
  Bun.spawnSync(["git", "-C", dir, "commit", "-q", "-m", `feat: ${name}`]);
  const sha = Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"], { stdout: "pipe" })
    .stdout.toString()
    .trim();
  recordOrderCommit(db, "order-1", sha, worker, `feat: ${name}`);
  recordOrderCheck(db, "order-1", { command: "bun run verify", exitCode: 0 }, worker);
  recordOrderBuild(db, "order-1", `The ${name} slice is built and verified.`, sha, worker);
  const left = nextOrderSlice(db, "order-1");
  if (left) completeOrderSlice(db, "order-1", left.id, worker);
  else finishAttempt(db, "order-1", "succeeded", undefined, new Date().toISOString());
  approveOrder(db, "order-1", operator.name, `review ${name}`);
  return sha;
}

describe("a review round", () => {
  test("reads the same diff again in a new round when its Review artifact is returned", async () => {
    const { db, worker, operator, operatorToken, operatorSession, dir } = floor();
    slice(db, dir, worker, "review-artifact");
    const done = await review(db, operator, dir, answering(reviewOutput()));
    expect(done.reviewer).toBeTruthy();

    expect(
      runOrderCommand(
        db,
        ["return", "order-1", "--reason", "Explain which checks support the verdict."],
        null,
        dir,
        {
          ...machine,
          [WORKER_NAME_VAR]: operator,
          [WORKER_TOKEN_VAR]: operatorToken,
          [WORKER_SESSION_VAR]: operatorSession,
        },
      ),
    ).toContain("returned");
    expect(returnedOrderArtifact(db, "order-1", "review")).toMatchObject({
      reason: "Explain which checks support the verdict.",
      body: expect.stringContaining("## Verdict\n\n**May advance.** The change does what the plan asked."),
    });
    const roundRange = (id: number) =>
      db
        .query<{ base_sha: string; head_sha: string }, [number]>(
          "SELECT base_sha, head_sha FROM factory_order_review WHERE id = ?",
        )
        .get(id);
    expect(() =>
      runOrderCommand(db, ["approve", "order-1"], null, dir, {
        ...machine,
        [WORKER_NAME_VAR]: operator,
        [WORKER_TOKEN_VAR]: operatorToken,
        [WORKER_SESSION_VAR]: operatorSession,
      }),
    ).toThrow(
      expect.objectContaining({ code: "not_next", message: expect.stringContaining("run at review") }),
    );
    let revisionArgv: string[] = [];
    const revised = await review(db, operator, dir, (request) => {
      revisionArgv = argvOf(request);
      expect(request.env[WORKER_NAME_VAR]).toBe(done.reviewer);
      return { output: reviewOutput({ verdict: "The checks named in coverage support it." }) };
    });
    expect(revised.reviewer).toBe(done.reviewer);
    expect(revised.review).not.toBe(done.review);
    expect(roundRange(revised.review)).toEqual(
      roundRange(done.review) as { base_sha: string; head_sha: string },
    );
    expect(revisionArgv.join(" ")).toContain("# Returned Review artifact");
    expect(revisionArgv.join(" ")).toContain("Explain which checks support the verdict.");
    expect(approveOrder(db, "order-1", operator, undefined)).toBe("review");
    expect(
      db
        .query(
          `SELECT a.revision, w.worker FROM factory_order_artifact a
           JOIN factory_order_event w ON w.artifact_id = a.id AND w.kind = 'artifact_written'
           WHERE a.kind = 'review' ORDER BY a.revision`,
        )
        .all(),
    ).toEqual([
      { revision: 1, worker: done.reviewer },
      { revision: 2, worker: done.reviewer },
    ]);
    expect(
      db
        .query(
          `SELECT e.kind, e.worker, a.revision FROM factory_order_event e
           JOIN factory_order_artifact a ON a.id = e.artifact_id
           WHERE a.kind = 'review' ORDER BY e.id`,
        )
        .all(),
    ).toEqual([
      { kind: "artifact_written", worker: done.reviewer, revision: 1 },
      { kind: "artifact_returned", worker: operator, revision: 1 },
      { kind: "artifact_written", worker: done.reviewer, revision: 2 },
      { kind: "artifact_approved", worker: operator, revision: 2 },
    ]);
  });

  test("refuses review delegation from a non-operator worker before opening a round", async () => {
    const { db, worker, dir } = floor();
    slice(db, dir, worker, "a");

    await expect(review(db, worker, dir, answering(reviewOutput()))).rejects.toThrow(
      expect.objectContaining({ code: "worker_not_operator" }),
    );
    expect(db.query("SELECT count(*) AS n FROM factory_order_review").get()).toEqual({ n: 0 });
  });

  test("the finding names the spawned reviewer and not the operator that delegated it", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");

    const done = await review(db, operator, dir, answering(reviewOutput({ findings: [findingOn("a.txt")] })));

    expect(done).toMatchObject({ findings: 1, outcome: "closed" });
    expect(done.reviewer).toBeTruthy();
    expect(done.reviewer).not.toBe(worker);
    const row = db
      .query(
        "SELECT e.worker, w.role FROM factory_order_event e JOIN factory_worker w ON w.name = e.worker WHERE e.kind = 'finding_raised'",
      )
      .get();
    expect(row).toEqual({ worker: done.reviewer, role: "reviewer" });
  });

  test("records the operator as the reviewer's parent", async () => {
    const { db, worker, operator, builderToken, builderSession, dir } = floor();
    slice(db, dir, worker, "parent");

    const done = await review(db, operator, dir, answering(reviewOutput()), {
      ...machine,
      [WORKER_NAME_VAR]: worker,
      [WORKER_TOKEN_VAR]: builderToken,
      [WORKER_SESSION_VAR]: builderSession,
    });

    expect(db.query("SELECT parent_worker FROM factory_worker WHERE name = ?").get(done.reviewer)).toEqual({
      parent_worker: operator,
    });
  });

  test("the builder cannot raise one under its own name", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    await review(db, operator, dir, answering(reviewOutput()));

    expect(() =>
      raiseOrderFinding(db, "order-1", located({ dimension: "tests", failure: "mine" }), worker),
    ).toThrow(/no review open/);
  });

  test("a reviewer that did not finish leaves an aborted round, not a clean one", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");

    const done = await review(db, operator, dir, () => ({ failure: "the reviewer exited 3" }));

    expect(done).toMatchObject({ findings: 0, outcome: "aborted" });
    expect(db.query("SELECT outcome FROM factory_order_review WHERE id = ?").get(done.review)).toEqual({
      outcome: "aborted",
    });
  });

  test("records a crashed reviewer with the harness explanation", async () => {
    const { db, worker, operator, operatorToken, operatorSession, dir } = floor();
    slice(db, dir, worker, "crashed-review");

    const outcome = await runOrderReviewLive(db, "order-1", operator, {
      dir,
      harness: "codex",
      adapter: fakeHarness("crash"),
      env: {
        ...machine,
        [WORKER_NAME_VAR]: operator,
        [WORKER_TOKEN_VAR]: operatorToken,
        [WORKER_SESSION_VAR]: operatorSession,
      },
    });

    expect(outcome).toMatchObject({ findings: 0, outcome: "aborted" });
    expect(
      db
        .query<{ reason: string | null }, [number]>(
          "SELECT reason FROM factory_order_event WHERE review_id = ? AND kind = 'review_closed'",
        )
        .get(outcome.review),
    ).toEqual({ reason: expect.stringContaining("fake process crashed") });
    const reviewer = db
      .query<{ reviewer: string }, [number]>("SELECT reviewer FROM factory_order_review WHERE id = ?")
      .get(outcome.review);
    if (!reviewer?.reviewer) throw new Error("reviewer was not recorded");
    expect(
      db
        .query<{ role: string }, [string]>("SELECT role FROM factory_worker WHERE name = ?")
        .get(reviewer.reviewer),
    ).toEqual({
      role: "reviewer",
    });
  });

  test("records the reviewer's structured result through the factory", async () => {
    const { db, worker, operator, operatorToken, operatorSession, dir } = floor();
    slice(db, dir, worker, "review-result");
    const outcome = await runOrderReviewLive(db, "order-1", operator, {
      dir,
      harness: "codex",
      adapter: fakeHarness("review"),
      env: {
        ...machine,
        [WORKER_NAME_VAR]: operator,
        [WORKER_TOKEN_VAR]: operatorToken,
        [WORKER_SESSION_VAR]: operatorSession,
      },
    });

    expect(outcome).toMatchObject({ findings: 0, outcome: "closed" });
    expect(
      db
        .query(
          `SELECT a.body, w.worker FROM factory_order_artifact a
           JOIN factory_order_event w ON w.artifact_id = a.id AND w.kind = 'artifact_written'
           WHERE a.kind = 'review'`,
        )
        .get(),
    ).toEqual({
      body: expect.stringContaining("## Verdict\n\n**May advance.** The change is sound."),
      worker: outcome.reviewer,
    });
  });

  test("keeps the same reviewer identity for a later review round", async () => {
    const { db, worker, operator, operatorToken, operatorSession, dir } = floor();
    slice(db, dir, worker, "review-first");
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
        return base.resume(sessionId, request);
      },
    };
    const env = {
      ...machine,
      [WORKER_NAME_VAR]: operator,
      [WORKER_TOKEN_VAR]: operatorToken,
      [WORKER_SESSION_VAR]: operatorSession,
    };

    const first = await runOrderReviewLive(db, "order-1", operator, { dir, adapter, env, harness: "codex" });
    slice(db, dir, worker, "review-second");
    const second = await runOrderReviewLive(db, "order-1", operator, { dir, adapter, env, harness: "codex" });

    expect(first.reviewer).toBe(second.reviewer);
    expect(starts).toBe(1);
    expect(resumes).toBe(1);
    expect(db.query("SELECT count(*) AS n FROM factory_worker WHERE role = 'reviewer'").get()).toEqual({
      n: 1,
    });
    expect(db.query("SELECT count(*) AS n FROM factory_order_worker").get()).toEqual({ n: 1 });
  });

  test("the reviewer is handed no tool that could edit", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    let handed: string[] = [];

    await review(db, operator, dir, (request) => {
      handed = argvOf(request);
      return { output: reviewOutput() };
    });

    expect(handed).toContain("-s");
    expect(handed[handed.indexOf("-s") + 1]).toBe("read-only");
    expect(handed).toContain("--output-schema");
  });

  test("the reviewer's credential rides in its environment and not its argv", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    let argv: string[] = [];
    let env: Readonly<Record<string, string>> = {};
    const seen = (request: HarnessRequest): ScriptedAnswer => {
      argv = argvOf(request);
      env = request.env;
      return { output: reviewOutput() };
    };

    await review(db, operator, dir, seen);

    expect(env[ASSIGNMENT_TOKEN_VAR]).toBeString();
    expect(argv.join(" ")).not.toContain(env[ASSIGNMENT_TOKEN_VAR] as string);

    slice(db, dir, worker, "b");
    const done = await review(db, operator, dir, seen);

    expect(env[WORKER_NAME_VAR]).toBe(done.reviewer);
    expect(env[WORKER_TOKEN_VAR]).toMatch(/^[0-9a-f]{32}$/);
    expect(argv.join(" ")).not.toContain(env[WORKER_TOKEN_VAR] as string);
  });

  test("a second round reads only what the first one did not", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    const first = await review(db, operator, dir, answering(reviewOutput()));
    const fixed = slice(db, dir, worker, "b");

    let read = "";
    await review(db, operator, dir, (request) => {
      read = argvOf(request).find((argument) => argument.includes("git diff ")) ?? "";
      return { output: reviewOutput() };
    });

    const firstHead = db
      .query<{ head_sha: string }, [number]>("SELECT head_sha FROM factory_order_review WHERE id = ?")
      .get(first.review);
    expect(read).toContain(`${firstHead?.head_sha}..${fixed}`);
  });

  test("a round is refused over a tree that can still move", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    writeFileSync(join(dir, "uncommitted.txt"), "still moving");

    await expect(review(db, operator, dir, answering(reviewOutput()))).rejects.toThrow(ReviewRefused);
    expect(db.query("SELECT count(*) AS n FROM factory_order_review").get()).toEqual({ n: 0 });
  });

  test("a round is refused over a head the order never recorded", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    writeFileSync(join(dir, "unrecorded.txt"), "b");
    Bun.spawnSync(["git", "-C", dir, "add", "."]);
    Bun.spawnSync(["git", "-C", dir, "commit", "-q", "-m", "feat: unrecorded"]);

    await expect(review(db, operator, dir, answering(reviewOutput()))).rejects.toThrow(
      /is not a commit order order-1 recorded/,
    );
  });

  test("two rounds cannot be open over one order", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    let refusal: Promise<unknown> | undefined;

    await review(db, operator, dir, () => {
      refusal = review(db, operator, dir, answering(reviewOutput())).then(
        () => undefined,
        (error: unknown) => error,
      );
      return { output: reviewOutput() };
    });

    expect(await refusal).toMatchObject({ message: expect.stringMatching(/already has review/) });
  });

  test("refuses a finding on a file the round did not change", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");

    await expect(
      review(db, operator, dir, answering(reviewOutput({ findings: [findingOn("landed.txt")] }))),
    ).rejects.toThrow(
      /reviewer finding 1 names file landed\.txt, which [0-9a-f]+\.\.[0-9a-f]+ does not change/,
    );
    expect(db.query("SELECT count(*) AS n FROM factory_order_finding").get()).toEqual({ n: 0 });
    expect(db.query("SELECT outcome FROM factory_order_review").get()).toEqual({ outcome: "aborted" });
  });

  test("refuses a finding on a line past the end of the file at head", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");

    await expect(
      review(db, operator, dir, answering(reviewOutput({ findings: [findingOn("a.txt", { line: 2 })] }))),
    ).rejects.toThrow(/reviewer finding 1 names line 2 of a\.txt, which has 1 lines at [0-9a-f]+/);
    expect(db.query("SELECT count(*) AS n FROM factory_order_finding").get()).toEqual({ n: 0 });
  });

  test.each([
    ["counts trailing blank lines", { "blank.txt": "a\n\n\n" }, "blank.txt", 3, null],
    ["keeps a non-ASCII path as git holds it", { "café.txt": "a\n" }, "café.txt", 1, null],
    [
      "refuses a file the diff deleted",
      { "landed.txt": null },
      "landed.txt",
      1,
      /names file landed\.txt, which does not exist at [0-9a-f]+/,
    ],
  ])("the location check %s", async (_name, files, file, line, refusal) => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "located", files);
    const run = () =>
      review(db, operator, dir, answering(reviewOutput({ findings: [findingOn(file, { line })] })));
    if (refusal) await expect(run()).rejects.toThrow(refusal);
    else expect(await run()).toMatchObject({ findings: 1, outcome: "closed" });
  });

  test("briefs the reviewer with the order's approved plan", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    let brief = "";
    await review(db, operator, dir, (request) => {
      brief = argvOf(request).join(" ");
      return { output: reviewOutput() };
    });
    expect(brief).toContain("# Approved plan\n## Outcome\n\nBuild the requested result.");
    expect(brief).toContain("# Plan slices\n1. Build the requested result: It is verified.");
  });

  test("records a finding's location, failure, fix and severity and renders it as blocking", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");

    await review(db, operator, dir, answering(reviewOutput({ findings: [findingOn("a.txt")] })));

    expect(
      db.query("SELECT dimension, file, line, failure, fix, severity FROM factory_order_finding").get(),
    ).toEqual({
      dimension: "correctness",
      file: "a.txt",
      line: 1,
      failure: "the guard is the wrong way round",
      fix: "invert the guard",
      severity: "high",
    });
    const body = db
      .query<{ body: string }, []>("SELECT body FROM factory_order_artifact WHERE kind = 'review'")
      .get()?.body;
    expect(body).toStartWith("## Verdict\n\n**Returns to the builder.**");
    expect(body).toContain("## Earlier findings\n\nNone.");
    expect(body).toMatch(
      /## Blocking findings\n\n- \*\*high\*\* `a\.txt:1` \(correctness, finding \d+\): the guard is the wrong way round Fix: invert the guard/,
    );
  });

  test("the brief carries the approved plan and loads the review station", () => {
    const brief = reviewerBrief(
      { id: "order-1", title: "Read a slice", description: null },
      { base: "aaa", head: "bbb" },
      {
        plan: {
          body: "## Outcome\n\nRefuse empty tokens.",
          slices: [{ title: "Gate", outcome: "Empty refused." }],
        },
        earlier: [],
      },
    );
    expect(brief).toContain("# Approved plan\n## Outcome\n\nRefuse empty tokens.");
    expect(brief).toContain("# Plan slices\n1. Gate: Empty refused.");
    expect(brief).toContain("Use dim-station-review and dim-artifact.");
    expect(brief).toContain("`git diff aaa..bbb`");
    expect(brief).not.toContain("# Earlier findings");
  });

  test("the brief lists each earlier finding with the builder's answer", () => {
    const brief = reviewerBrief(
      { id: "order-1", title: "Read a slice", description: null },
      { base: "aaa", head: "bbb" },
      {
        plan: null,
        earlier: [
          {
            id: 7,
            orderId: "order-1",
            reviewId: 1,
            dimension: "tests",
            file: "src/example.ts",
            line: 1,
            failure: "no test",
            fix: "add the test",
            severity: "medium",
            raisedAt: "2026-09-26T10:00:00.000Z",
            answer: "refused",
            resolution: "later slice",
          },
        ],
      },
    );
    expect(brief).toContain(
      [
        "# Earlier findings",
        "Earlier rounds raised these, and the builder answered each. Raise a new finding for any that still holds at this head.",
        "- Finding 7 (tests, src/example.ts:1): no test",
        "  - Fix asked for: add the test",
        "  - Builder's answer: refused: later slice",
      ].join("\n"),
    );
    expect(brief).toContain("No approved plan is recorded for this order.");
  });

  test("sends the order to build when the round after a return raises a finding", async () => {
    const { db, worker, operator, operatorToken, operatorSession, dir } = floor();
    slice(db, dir, worker, "a");
    const env = {
      ...machine,
      [WORKER_NAME_VAR]: operator,
      [WORKER_TOKEN_VAR]: operatorToken,
      [WORKER_SESSION_VAR]: operatorSession,
    };
    await review(db, operator, dir, answering(reviewOutput()));
    runOrderCommand(db, ["return", "order-1", "--reason", "Say more."], null, dir, env);
    const again = await review(
      db,
      operator,
      dir,
      answering(reviewOutput({ findings: [findingOn("a.txt")] })),
    );

    expect(again.findings).toBe(1);
    expect(orderState(db, "order-1")).toEqual({ station: "build", next: "run" });
  });

  describe("a later round", () => {
    async function raisedAndFixed() {
      const f = floor();
      slice(f.db, f.dir, f.worker, "a");
      await review(f.db, f.operator, f.dir, answering(reviewOutput({ findings: [findingOn("a.txt")] })));
      const finding = f.db.query<{ id: number }, []>("SELECT id FROM factory_order_finding").get()
        ?.id as number;
      answerOrderFindings(
        f.db,
        "order-1",
        "build-1",
        [{ finding, answer: "fixed", resolution: "inverted it" }],
        f.worker,
      );
      slice(f.db, f.dir, f.worker, "b");
      return { ...f, finding };
    }

    test("is briefed with each earlier finding and the builder's answer", async () => {
      const { db, operator, dir, finding } = await raisedAndFixed();
      let brief = "";
      await review(db, operator, dir, (request) => {
        brief = argvOf(request).join(" ");
        return { output: reviewOutput() };
      });
      expect(brief).toContain(
        `- Finding ${finding} (correctness, a.txt:1): the guard is the wrong way round`,
      );
      expect(brief).toContain("  - Fix asked for: invert the guard");
      expect(brief).toContain("  - Builder's answer: fixed: inverted it");
    });

    test("is refused while an earlier finding awaits the builder's answer", async () => {
      const f = floor();
      slice(f.db, f.dir, f.worker, "a");
      await review(f.db, f.operator, f.dir, answering(reviewOutput({ findings: [findingOn("a.txt")] })));
      await expect(review(f.db, f.operator, f.dir, answering(reviewOutput()))).rejects.toThrow(
        expect.objectContaining({ code: "not_next", message: expect.stringContaining("run at build") }),
      );
      expect(f.db.query("SELECT count(*) AS n FROM factory_order_review").get()).toEqual({ n: 1 });
    });

    test("renders a clean round's earlier findings with the builder's answers", async () => {
      const { db, operator, dir, finding } = await raisedAndFixed();
      await review(db, operator, dir, answering(reviewOutput()));

      const body = db
        .query<{ body: string }, []>(
          "SELECT body FROM factory_order_artifact WHERE kind = 'review' ORDER BY id DESC",
        )
        .get()?.body;
      expect(body).toStartWith("## Verdict\n\n**May advance.**");
      expect(body).toContain(
        `## Earlier findings\n\n- Finding ${finding}, \`a.txt:1\`: the guard is the wrong way round **fixed**: inverted it`,
      );
    });
  });

  test("reads a worktree without running a command a builder's nested repository configured", () => {
    const repo = mkdtempSync(join(tmpdir(), "dim-review-nested-"));
    const git = (cwd: string, ...args: string[]) =>
      Bun.spawnSync([
        "git",
        "-C",
        cwd,
        "-c",
        "user.email=t@e",
        "-c",
        "user.name=T",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ]);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    mkdirSync(join(repo, "sub"));
    git(join(repo, "sub"), "init", "-q", "-b", "main");
    git(join(repo, "sub"), "commit", "-q", "--allow-empty", "-m", "nested");
    const nested = Bun.spawnSync(["git", "-C", join(repo, "sub"), "rev-parse", "HEAD"])
      .stdout.toString()
      .trim();
    git(repo, "update-index", "--add", "--cacheinfo", `160000,${nested},sub`);
    git(repo, "commit", "-q", "-m", "gitlink");
    const marker = join(repo, "ran");
    writeFileSync(join(repo, "fsmonitor.sh"), `#!/bin/sh\ntouch ${marker}\necho 0\n`);
    chmodSync(join(repo, "fsmonitor.sh"), 0o755);
    git(join(repo, "sub"), "config", "core.fsmonitor", join(repo, "fsmonitor.sh"));
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);

    try {
      reviewRange(db, "order-1", repo);
    } catch {}

    const ran = existsSync(marker);
    db.close();
    rmSync(repo, { recursive: true, force: true });

    expect(ran).toBe(false);
  });

  test("refuses a worktree whose submodule moved without a commit recording it", () => {
    const repo = mkdtempSync(join(tmpdir(), "dim-review-moved-"));
    const git = (cwd: string, ...args: string[]) =>
      Bun.spawnSync([
        "git",
        "-C",
        cwd,
        "-c",
        "user.email=t@e",
        "-c",
        "user.name=T",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ]);
    git(repo, "init", "-q", "-b", "main");
    mkdirSync(join(repo, "sub"));
    git(join(repo, "sub"), "init", "-q", "-b", "main");
    git(join(repo, "sub"), "commit", "-q", "--allow-empty", "-m", "nested");
    const nested = Bun.spawnSync(["git", "-C", join(repo, "sub"), "rev-parse", "HEAD"])
      .stdout.toString()
      .trim();
    git(repo, "update-index", "--add", "--cacheinfo", `160000,${nested},sub`);
    git(repo, "commit", "-q", "-m", "gitlink");
    git(join(repo, "sub"), "commit", "-q", "--allow-empty", "-m", "moved");
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);

    let refusal: unknown;
    try {
      reviewRange(db, "order-1", repo);
    } catch (error) {
      refusal = error;
    }
    db.close();
    rmSync(repo, { recursive: true, force: true });

    expect(refusal).toMatchObject({ code: "worktree_dirty" });
  });
});
