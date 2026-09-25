import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveOrderBuild,
  claimOrder,
  moveOrder,
  queueOrder,
  raiseOrderFinding,
  recordOrderBuild,
  recordOrderCheck,
  recordOrderCommit,
  returnedOrderArtifact,
} from "./factory-order";
import { mintWorker, WORKER_NAME_VAR, WORKER_SESSION_VAR, WORKER_TOKEN_VAR } from "./factory-worker";
import { fakeHarness } from "./fake-harness";
import { integratedRepo, orderWorktree } from "./fixtures.test-support";
import { runOrderCommand } from "./order-command";
import {
  type ReviewerSpawn,
  ReviewRefused,
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

function reviewOutput(
  body = "## Outcome\n\nThe change is sound.",
  findings: { dimension: string; summary: string }[] = [],
): string {
  return JSON.stringify({ body, findings });
}

// Routing resolves the reviewer's tier to the model name supplied to the adapter.
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

/** A commit in the order's own worktree, recorded the way a builder records one. */
function slice(db: Database, dir: string, worker: string, name: string): string {
  writeFileSync(join(dir, `${name}.txt`), name);
  Bun.spawnSync(["git", "-C", dir, "add", "."]);
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
      body: "## Outcome\n\nThe change is sound.",
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
      return { exitCode: 0, output: reviewOutput("## Outcome\n\nThe review evidence supports the verdict.") };
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

  // The whole of the fix: the hand that writes the finding is one the builder was handed
  // no token for, and the record can tell them apart afterwards.
  test("the finding names the spawned reviewer and not the operator that delegated it", () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    const spawn: ReviewerSpawn = (_argv, env) => {
      const reviewer = bootstrapReviewer(db, env);
      expect(reviewer).toBeTruthy();
      return {
        exitCode: 0,
        output: reviewOutput("## Outcome\n\nThe guard is reversed.", [
          { dimension: "correctness", summary: "the guard is the wrong way round" },
        ]),
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

    expect(() => raiseOrderFinding(db, "order-1", { dimension: "tests", summary: "mine" }, worker)).toThrow(
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
      body: "## Outcome\n\nThe change is sound.",
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

  // The token is the whole of the separation, so it must reach the child's environment and
  // nothing the builder's process can read back off the command line.
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
