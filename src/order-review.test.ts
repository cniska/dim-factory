import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendOrderEvent,
  approveOrderBuild,
  claimOrder,
  moveOrder,
  queueOrder,
  recordOrderBuild,
  recordOrderCheck,
  recordOrderCommit,
  returnedOrderArtifact,
} from "./factory-order";
import { mintWorker, WORKER_NAME_VAR, WORKER_SESSION_VAR, WORKER_TOKEN_VAR } from "./factory-worker";
import { fakeHarness } from "./fake-harness";
import { integratedRepo, orderWorktree, reviewOutput } from "./fixtures.test-support";
import { runOrderCommand } from "./order-command";
import { answerOrderFindings, raiseOrderFinding, recordOwnerRuling } from "./order-finding";
import {
  type ReviewerSpawn,
  ReviewRefused,
  reviewerBrief,
  reviewRange,
  runOrderReview,
  runOrderReviewLive,
} from "./order-review";
import { SCHEMA_SQL } from "./schema";
import { ASSIGNMENT_ID_VAR, ASSIGNMENT_TOKEN_VAR, bootstrapWorker } from "./worker-assignment";
import { saveWorkerCredential } from "./worker-credential";

const trunk = integratedRepo();
const worktrees: string[] = [];
const opened: Database[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  for (const path of worktrees) rmSync(path, { recursive: true, force: true });
  rmSync(trunk.dir, { recursive: true, force: true });
});

function bootstrapReviewer(db: Database, env: Record<string, string>): string {
  if (env[WORKER_NAME_VAR] && env[WORKER_TOKEN_VAR] && env[WORKER_SESSION_VAR]) {
    return env[WORKER_NAME_VAR];
  }
  const reviewer = bootstrapWorker(db, {
    id: env[ASSIGNMENT_ID_VAR] as string,
    token: env[ASSIGNMENT_TOKEN_VAR] as string,
    sessionId: `reviewer-${crypto.randomUUID()}`,
  });
  saveWorkerCredential(env, reviewer);
  env[WORKER_NAME_VAR] = reviewer.name;
  env[WORKER_TOKEN_VAR] = reviewer.token;
  env[WORKER_SESSION_VAR] = reviewer.sessionId;
  return reviewer.name;
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
  claimOrder(
    db,
    "order-1",
    { runId: "run-1", station: "dim-station-build", operatorWorker: operator.name },
    builder.name,
    undefined,
    trunk.dir,
  );
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
  const operator = db
    .query<{ name: string }, []>("SELECT name FROM factory_worker WHERE role = 'operator'")
    .get();
  if (!operator) throw new Error("review fixture has no operator");
  approveOrderBuild(db, "order-1", operator.name, `review ${name}`);
  return sha;
}

describe("a review round", () => {
  test("returns a Review artifact to the same reviewer and approves its revision", () => {
    const { db, worker, operator, operatorToken, operatorSession, dir } = floor();
    slice(db, dir, worker, "review-artifact");
    moveOrder(db, "order-1", "dim-station-review", operator);
    const spawn: ReviewerSpawn = (_argv, env) => {
      const reviewer = bootstrapReviewer(db, env);
      expect(reviewer).toBeTruthy();
      return { exitCode: 0, output: reviewOutput() };
    };
    const done = runOrderReview(db, "order-1", operator, { dir, spawn, env: machine });

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
    const returnedReview = returnedOrderArtifact(db, "order-1", "review");
    const reviewRange = db
      .query<{ base_sha: string; head_sha: string }, [number]>(
        "SELECT base_sha, head_sha FROM factory_order_review WHERE id = ?",
      )
      .get(done.review);
    expect(returnedReview).toMatchObject({
      station: "review",
      reason: "Explain which checks support the verdict.",
      reviewId: done.review,
      body: expect.stringContaining("## Verdict\n\n**May advance.** The change does what the plan asked."),
      baseSha: reviewRange?.base_sha,
      headSha: reviewRange?.head_sha,
    });
    expect(() =>
      runOrderCommand(db, ["approve", "order-1"], null, dir, {
        ...machine,
        [WORKER_NAME_VAR]: operator,
        [WORKER_TOKEN_VAR]: operatorToken,
        [WORKER_SESSION_VAR]: operatorSession,
      }),
    ).toThrow(expect.objectContaining({ code: "artifact_revision_required" }));
    let revisionArgv: string[] = [];
    const revise: ReviewerSpawn = (argv, env) => {
      revisionArgv = argv;
      expect(bootstrapReviewer(db, env)).toBe(done.reviewer);
      return { exitCode: 0, output: reviewOutput({ verdict: "The checks named in coverage support it." }) };
    };
    const revised = runOrderReview(db, "order-1", operator, { dir, spawn: revise, env: machine });
    expect(revised.review).toBe(done.review);
    expect(revisionArgv.join(" ")).toContain("The owner returned this Review artifact for revision.");
    expect(revisionArgv.join(" ")).toContain("Explain which checks support the verdict.");
    expect(
      runOrderCommand(db, ["approve", "order-1"], null, dir, {
        ...machine,
        [WORKER_NAME_VAR]: operator,
        [WORKER_TOKEN_VAR]: operatorToken,
        [WORKER_SESSION_VAR]: operatorSession,
      }),
    ).toContain("review approved");
    expect(
      db.query("SELECT revision, worker FROM factory_order_review_artifact ORDER BY revision").all(),
    ).toEqual([
      { revision: 1, worker: done.reviewer },
      { revision: 2, worker: done.reviewer },
    ]);
    expect(
      db
        .query(
          "SELECT kind, worker FROM factory_order_event WHERE kind IN ('artifact_returned', 'review_artifact_written', 'review_approved') ORDER BY id",
        )
        .all(),
    ).toEqual([
      { kind: "review_artifact_written", worker: done.reviewer },
      { kind: "artifact_returned", worker: operator },
      { kind: "review_artifact_written", worker: done.reviewer },
      { kind: "review_approved", worker: operator },
    ]);
  });

  test("refuses review delegation from a non-operator worker before opening a round", () => {
    const { db, worker, dir } = floor();
    slice(db, dir, worker, "a");

    expect(() => runOrderReview(db, "order-1", worker, { dir, env: machine })).toThrow(
      expect.objectContaining({ code: "worker_not_operator" }),
    );
    expect(db.query("SELECT count(*) AS n FROM factory_order_review").get()).toEqual({ n: 0 });
  });

  test("the finding names the spawned reviewer and not the operator that delegated it", () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    const spawn: ReviewerSpawn = (_argv, env) => {
      const reviewer = bootstrapReviewer(db, env);
      expect(reviewer).toBeTruthy();
      return {
        exitCode: 0,
        output: reviewOutput({ findings: [findingOn("a.txt")] }),
      };
    };

    const done = runOrderReview(db, "order-1", operator, { dir, spawn, env: machine });

    expect(done).toMatchObject({ findings: 1, outcome: "closed" });
    expect(done.reviewer).not.toBe(worker);
    const row = db
      .query(
        "SELECT e.worker, w.role FROM factory_order_event e JOIN factory_worker w ON w.name = e.worker WHERE e.kind = 'finding_raised'",
      )
      .get();
    expect(row).toEqual({ worker: done.reviewer, role: "reviewer" });
  });

  test("records the operator as the reviewer's parent", () => {
    const { db, worker, operator, builderToken, builderSession, dir } = floor();
    slice(db, dir, worker, "parent");

    const done = runOrderReview(db, "order-1", operator, {
      dir,
      spawn: (_argv, env) => {
        bootstrapReviewer(db, env);
        return { exitCode: 0, output: reviewOutput() };
      },
      env: {
        ...machine,
        [WORKER_NAME_VAR]: worker,
        [WORKER_TOKEN_VAR]: builderToken,
        [WORKER_SESSION_VAR]: builderSession,
      },
    });

    expect(db.query("SELECT parent_worker FROM factory_worker WHERE name = ?").get(done.reviewer)).toEqual({
      parent_worker: operator,
    });
  });

  test("the builder cannot raise one under its own name", () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    const spawn: ReviewerSpawn = (_argv, env) => {
      bootstrapReviewer(db, env);
      return { exitCode: 0, output: reviewOutput() };
    };
    runOrderReview(db, "order-1", operator, { dir, spawn, env: machine });

    expect(() => raiseOrderFinding(db, "order-1", { dimension: "tests", failure: "mine" }, worker)).toThrow(
      /no review open/,
    );
  });

  test("a reviewer that did not finish leaves an aborted round, not a clean one", () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    const spawn: ReviewerSpawn = (_argv, env) => {
      bootstrapReviewer(db, env);
      return { exitCode: 3, output: "" };
    };

    const done = runOrderReview(db, "order-1", operator, { dir, spawn, env: machine });

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
      adapter: fakeHarness("review"),
      env: {
        ...machine,
        [WORKER_NAME_VAR]: operator,
        [WORKER_TOKEN_VAR]: operatorToken,
        [WORKER_SESSION_VAR]: operatorSession,
      },
    });

    expect(outcome).toMatchObject({ findings: 0, outcome: "closed" });
    expect(db.query("SELECT body, worker FROM factory_order_review_artifact").get()).toEqual({
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

    const first = await runOrderReviewLive(db, "order-1", operator, { dir, adapter, env });
    slice(db, dir, worker, "review-second");
    const second = await runOrderReviewLive(db, "order-1", operator, { dir, adapter, env });

    expect(first.reviewer).toBe(second.reviewer);
    expect(starts).toBe(1);
    expect(resumes).toBe(1);
    expect(db.query("SELECT count(*) AS n FROM factory_worker WHERE role = 'reviewer'").get()).toEqual({
      n: 1,
    });
    expect(db.query("SELECT count(*) AS n FROM factory_order_worker").get()).toEqual({ n: 1 });
  });

  test("the reviewer is handed no tool that could edit", () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    let handed: string[] = [];
    const spawn: ReviewerSpawn = (argv, env) => {
      bootstrapReviewer(db, env);
      handed = argv;
      return { exitCode: 0, output: reviewOutput() };
    };

    runOrderReview(db, "order-1", operator, { dir, spawn, env: machine });

    expect(handed).toContain("-s");
    expect(handed[handed.indexOf("-s") + 1]).toBe("read-only");
    expect(handed).toContain("--output-schema");
  });

  test("the reviewer's token rides in its environment and not its argv", () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    let argv: string[] = [];
    let env: Record<string, string> = {};
    const spawn: ReviewerSpawn = (given, environment) => {
      bootstrapReviewer(db, environment);
      argv = given;
      env = environment;
      return { exitCode: 0, output: reviewOutput() };
    };

    const done = runOrderReview(db, "order-1", operator, { dir, spawn, env: machine });

    expect(env[WORKER_NAME_VAR]).toBe(done.reviewer);
    expect(env[WORKER_TOKEN_VAR]).toMatch(/^[0-9a-f]{32}$/);
    expect(argv.join(" ")).not.toContain(env[WORKER_TOKEN_VAR] as string);
  });

  test("a second round reads only what the first one did not", () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    const quiet: ReviewerSpawn = (_argv, env) => {
      bootstrapReviewer(db, env);
      return { exitCode: 0, output: reviewOutput() };
    };
    const first = runOrderReview(db, "order-1", operator, { dir, spawn: quiet, env: machine });
    const fixed = slice(db, dir, worker, "b");

    let read = "";
    runOrderReview(db, "order-1", operator, {
      dir,
      env: machine,
      spawn: (argv, env) => {
        bootstrapReviewer(db, env);
        read = argv.find((argument) => argument.includes("git diff ")) ?? "";
        return { exitCode: 0, output: reviewOutput() };
      },
    });

    const firstHead = db
      .query<{ head_sha: string }, [number]>("SELECT head_sha FROM factory_order_review WHERE id = ?")
      .get(first.review);
    expect(read).toContain(`${firstHead?.head_sha}..${fixed}`);
  });

  test("a round is refused over a tree that can still move", () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    writeFileSync(join(dir, "uncommitted.txt"), "still moving");

    expect(() => runOrderReview(db, "order-1", operator, { dir, env: machine })).toThrow(ReviewRefused);
    expect(db.query("SELECT count(*) AS n FROM factory_order_review").get()).toEqual({ n: 0 });
  });

  test("a round is refused over a head the order never recorded", () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    writeFileSync(join(dir, "unrecorded.txt"), "b");
    Bun.spawnSync(["git", "-C", dir, "add", "."]);
    Bun.spawnSync(["git", "-C", dir, "commit", "-q", "-m", "feat: unrecorded"]);

    expect(() => runOrderReview(db, "order-1", operator, { dir, env: machine })).toThrow(
      /is not a commit order order-1 recorded/,
    );
  });

  test("two rounds cannot be open over one order", () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    const spawn: ReviewerSpawn = (_argv, env) => {
      bootstrapReviewer(db, env);
      expect(() => runOrderReview(db, "order-1", operator, { dir, env: machine })).toThrow(
        /already has review/,
      );
      return { exitCode: 0, output: reviewOutput() };
    };

    runOrderReview(db, "order-1", operator, { dir, spawn, env: machine });
  });

  test("refuses a finding on a file the round did not change", () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    const spawn: ReviewerSpawn = (_argv, env) => {
      bootstrapReviewer(db, env);
      return { exitCode: 0, output: reviewOutput({ findings: [findingOn("landed.txt")] }) };
    };

    expect(() => runOrderReview(db, "order-1", operator, { dir, spawn, env: machine })).toThrow(
      /reviewer finding 1 names file landed\.txt, which [0-9a-f]+\.\.[0-9a-f]+ does not change/,
    );
    expect(db.query("SELECT count(*) AS n FROM factory_order_finding").get()).toEqual({ n: 0 });
    expect(db.query("SELECT outcome FROM factory_order_review").get()).toEqual({ outcome: "aborted" });
  });

  test("refuses a finding on a line past the end of the file at head", () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    const spawn: ReviewerSpawn = (_argv, env) => {
      bootstrapReviewer(db, env);
      return { exitCode: 0, output: reviewOutput({ findings: [findingOn("a.txt", { line: 2 })] }) };
    };

    expect(() => runOrderReview(db, "order-1", operator, { dir, spawn, env: machine })).toThrow(
      /reviewer finding 1 names line 2 of a\.txt, which has 1 lines at [0-9a-f]+/,
    );
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
  ])("the location check %s", (_name, files, file, line, refusal) => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "located", files);
    const run = () =>
      runOrderReview(db, "order-1", operator, {
        dir,
        env: machine,
        spawn: (_argv, env) => {
          bootstrapReviewer(db, env);
          return { exitCode: 0, output: reviewOutput({ findings: [findingOn(file, { line })] }) };
        },
      });
    if (refusal) expect(run).toThrow(refusal);
    else expect(run()).toMatchObject({ findings: 1, outcome: "closed" });
  });

  test("briefs the reviewer with the order's approved plan", () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    const plan = Number(
      db.run(
        `INSERT INTO factory_order_plan (order_id, revision, worker, body, recorded_at)
         VALUES ('order-1', 1, ?, '## Outcome\n\nRead the slice.', '2026-09-26T10:00:00.000Z')`,
        [operator],
      ).lastInsertRowid,
    );
    db.run(
      `INSERT INTO factory_order_slice (plan_id, ordinal, title, outcome) VALUES (?, 1, 'Read', 'The slice is read.')`,
      [plan],
    );
    appendOrderEvent(db, "order-1", { kind: "plan_approved", worker: operator, planId: plan });
    let brief = "";
    runOrderReview(db, "order-1", operator, {
      dir,
      env: machine,
      spawn: (argv, env) => {
        bootstrapReviewer(db, env);
        brief = argv.join(" ");
        return { exitCode: 0, output: reviewOutput() };
      },
    });
    expect(brief).toContain("# Approved plan\n## Outcome\n\nRead the slice.");
    expect(brief).toContain("# Plan slices\n1. Read: The slice is read.");
  });

  test("records a finding's location, failure, fix and severity and renders it as blocking", () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    const spawn: ReviewerSpawn = (_argv, env) => {
      bootstrapReviewer(db, env);
      return { exitCode: 0, output: reviewOutput({ findings: [findingOn("a.txt")] }) };
    };

    runOrderReview(db, "order-1", operator, { dir, spawn, env: machine });

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
    const body = db.query<{ body: string }, []>("SELECT body FROM factory_order_review_artifact").get()?.body;
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
    expect(brief).not.toContain("# Earlier findings to rule on");
  });

  test("the brief names an overturned refusal's reason from the owner", () => {
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
            file: null,
            line: null,
            failure: "no test",
            fix: null,
            severity: null,
            raisedAt: "2026-09-26T10:00:00.000Z",
            answer: "refused",
            resolution: "later slice",
            answered: true,
            ruling: null,
            rulingReason: null,
            ownerRuling: "refusal_overturned",
            ownerReason: "fix it here",
            state: "open",
            refusalStands: false,
          },
        ],
      },
    );
    expect(brief).toContain(
      [
        "- Finding 7 (tests, no location recorded): no test",
        "  - Builder's answer: refused: later slice",
        "  - The owner overturned the refusal: fix it here",
      ].join("\n"),
    );
    expect(brief).toContain("No approved plan is recorded for this order.");
  });

  test("refuses a returned artifact that carries findings", () => {
    const { db, worker, operator, operatorToken, operatorSession, dir } = floor();
    slice(db, dir, worker, "a");
    const env = {
      ...machine,
      [WORKER_NAME_VAR]: operator,
      [WORKER_TOKEN_VAR]: operatorToken,
      [WORKER_SESSION_VAR]: operatorSession,
    };
    moveOrder(db, "order-1", "dim-station-review", operator);
    runOrderReview(db, "order-1", operator, {
      dir,
      env: machine,
      spawn: (_argv, spawned) => {
        bootstrapReviewer(db, spawned);
        return { exitCode: 0, output: reviewOutput() };
      },
    });
    runOrderCommand(db, ["return", "order-1", "--reason", "Say more."], null, dir, env);
    expect(() =>
      runOrderReview(db, "order-1", operator, {
        dir,
        env: machine,
        spawn: (_argv, spawned) => {
          bootstrapReviewer(db, spawned);
          return { exitCode: 0, output: reviewOutput({ findings: [findingOn("a.txt")] }) };
        },
      }),
    ).toThrow("a returned Review artifact cannot change its findings or rulings");
  });

  test("refuses a ruling in the first round", () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    const spawn: ReviewerSpawn = (_argv, env) => {
      bootstrapReviewer(db, env);
      return {
        exitCode: 0,
        output: reviewOutput({ rulings: [{ finding: 1, ruling: "addressed", reason: null }] }),
      };
    };

    expect(() => runOrderReview(db, "order-1", operator, { dir, spawn, env: machine })).toThrow(
      "reviewer ruling names finding 1, which is not an open earlier finding",
    );
  });

  describe("a later round", () => {
    function raisedAndFixed() {
      const f = floor();
      slice(f.db, f.dir, f.worker, "a");
      runOrderReview(f.db, "order-1", f.operator, {
        dir: f.dir,
        env: machine,
        spawn: (_argv, env) => {
          bootstrapReviewer(f.db, env);
          return { exitCode: 0, output: reviewOutput({ findings: [findingOn("a.txt")] }) };
        },
      });
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

    test("is briefed with each open earlier finding and the builder's answer", () => {
      const { db, operator, dir, finding } = raisedAndFixed();
      let brief = "";
      expect(() =>
        runOrderReview(db, "order-1", operator, {
          dir,
          env: machine,
          spawn: (argv, env) => {
            bootstrapReviewer(db, env);
            brief = argv.join(" ");
            return { exitCode: 0, output: reviewOutput() };
          },
        }),
      ).toThrow(`reviewer rulings leave open earlier finding ${finding} without a ruling`);
      expect(brief).toContain(
        `- Finding ${finding} (correctness, a.txt:1): the guard is the wrong way round`,
      );
      expect(brief).toContain("  - Fix asked for: invert the guard");
      expect(brief).toContain("  - Builder's answer: fixed: inverted it");
    });

    test("records nothing of a round whose ruling the record refuses", () => {
      const { db, operator, dir, finding } = raisedAndFixed();
      expect(() =>
        runOrderReview(db, "order-1", operator, {
          dir,
          env: machine,
          spawn: (_argv, env) => {
            bootstrapReviewer(db, env);
            return {
              exitCode: 0,
              output: reviewOutput({
                findings: [findingOn("b.txt")],
                rulings: [{ finding, ruling: "refusal_accepted", reason: null }],
              }),
            };
          },
        }),
      ).toThrow(`finding ${finding} is answered fixed, so it takes addressed or not_addressed`);
      expect(db.query("SELECT count(*) AS n FROM factory_order_finding").get()).toEqual({ n: 1 });
      expect(db.query("SELECT count(*) AS n FROM factory_order_review_artifact").get()).toEqual({ n: 1 });
    });

    test("leaves an unanswered earlier finding out of the rulings it owes", () => {
      const f = floor();
      slice(f.db, f.dir, f.worker, "a");
      runOrderReview(f.db, "order-1", f.operator, {
        dir: f.dir,
        env: machine,
        spawn: (_argv, env) => {
          bootstrapReviewer(f.db, env);
          return { exitCode: 0, output: reviewOutput({ findings: [findingOn("a.txt")] }) };
        },
      });
      slice(f.db, f.dir, f.worker, "b");
      const second = runOrderReview(f.db, "order-1", f.operator, {
        dir: f.dir,
        env: machine,
        spawn: (_argv, env) => {
          bootstrapReviewer(f.db, env);
          return { exitCode: 0, output: reviewOutput() };
        },
      });
      expect(second.outcome).toBe("closed");
      const body = f.db
        .query<{ body: string }, [number]>(
          "SELECT body FROM factory_order_review_artifact WHERE review_id = ?",
        )
        .get(second.review)?.body;
      expect(body).toStartWith("## Verdict\n\n**Returns to the builder.**");
      expect(body).toMatch(
        /## Earlier findings\n\n- Finding \d+, `a\.txt:1`: the guard is the wrong way round \*\*awaiting the builder's answer\*\*/,
      );
    });

    test("briefs the round after an overturned refusal with the last ruling and the owner's reason", () => {
      const f = floor();
      const review = (output: string) => {
        let brief = "";
        runOrderReview(f.db, "order-1", f.operator, {
          dir: f.dir,
          env: machine,
          spawn: (argv, env) => {
            bootstrapReviewer(f.db, env);
            brief = argv.join(" ");
            return { exitCode: 0, output };
          },
        });
        return brief;
      };
      slice(f.db, f.dir, f.worker, "a");
      review(reviewOutput({ findings: [findingOn("a.txt")] }));
      const finding = f.db.query<{ id: number }, []>("SELECT id FROM factory_order_finding").get()
        ?.id as number;
      answerOrderFindings(
        f.db,
        "order-1",
        "build-1",
        [{ finding, answer: "refused", resolution: "later slice" }],
        f.worker,
      );
      slice(f.db, f.dir, f.worker, "b");
      review(
        reviewOutput({ rulings: [{ finding, ruling: "refusal_contested", reason: "it is this slice" }] }),
      );
      recordOwnerRuling(f.db, finding, { ruling: "refusal_overturned", reason: "fix it here" }, f.operator);
      answerOrderFindings(
        f.db,
        "order-1",
        "build-2",
        [{ finding, answer: "fixed", resolution: "moved the gate here" }],
        f.worker,
      );
      slice(f.db, f.dir, f.worker, "c");
      const brief = review(reviewOutput({ rulings: [{ finding, ruling: "addressed", reason: null }] }));
      expect(brief).toContain(
        [
          "  - Builder's answer: fixed: moved the gate here",
          "  - Last ruled refusal_contested: it is this slice",
          "  - The owner overturned the refusal: fix it here",
        ].join("\n"),
      );
      const body = f.db
        .query<{ body: string }, []>("SELECT body FROM factory_order_review_artifact ORDER BY id DESC")
        .get()?.body;
      expect(body).toContain("## Owner rulings\n\nNone.");
    });

    test("records its rulings and renders them as earlier findings", () => {
      const { db, operator, dir, finding } = raisedAndFixed();
      runOrderReview(db, "order-1", operator, {
        dir,
        env: machine,
        spawn: (_argv, env) => {
          bootstrapReviewer(db, env);
          return {
            exitCode: 0,
            output: reviewOutput({ rulings: [{ finding, ruling: "addressed", reason: null }] }),
          };
        },
      });

      expect(db.query("SELECT finding_id, ruling FROM factory_order_finding_ruling").all()).toEqual([
        { finding_id: finding, ruling: "addressed" },
      ]);
      const body = db
        .query<{ body: string }, []>("SELECT body FROM factory_order_review_artifact ORDER BY id DESC")
        .get()?.body;
      expect(body).toStartWith("## Verdict\n\n**May advance.**");
      expect(body).toContain(
        `## Earlier findings\n\n- Finding ${finding}, \`a.txt:1\`: the guard is the wrong way round **addressed**`,
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
