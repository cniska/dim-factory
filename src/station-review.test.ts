import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "./db-schema";
import {
  attemptIn,
  integratedRepo,
  located,
  orderWorktree,
  ranCheck,
  reviewOutput,
} from "./fixtures.test-support";
import type { HarnessRequest } from "./harness";
import { codexProcess } from "./harness-codex";
import { fakeHarness } from "./harness-fake";
import { commandLine } from "./harness-process";
import { type ScriptedAnswer, scriptedHarness } from "./harness-scripted.test-support";
import { nextOrderSlice, orderState } from "./order";
import { approveOrder } from "./order-approval";
import { completeOrderSlice, recordOrderBuild, returnedOrderArtifact } from "./order-artifacts";
import { finishAttempt } from "./order-attempt";
import { runOrderCommand } from "./order-command";
import { recordOrderCheck, recordOrderCommit } from "./order-evidence";
import { answerOrderFindings, raiseOrderFinding } from "./order-finding";
import { queueOrder, startOrder } from "./order-lifecycle";
import { runStation } from "./station";
import { approvePlan } from "./station-approvals.test-support";
import { reviewerBrief, reviewRange, reviewStation } from "./station-review";
import { mintWorker } from "./worker";
import { WORKER_NAME_VAR } from "./worker-name";
import { worktreePath } from "./worktree";

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
  return runStation(db, "order-1", reviewStation, operator, {
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
  dir: string;
} {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  const operator = mintWorker(db, {
    role: "operator",
    pid: process.ppid,
    sessionId: `operator-${opened.length}`,
  });
  opened.push(db);
  const builder = mintWorker(db, { role: "builder", sessionId: `builder-${opened.length}` });
  const repo = integratedRepo();
  worktrees.push(repo.dir);
  queueOrder(
    db,
    { line: "feat", id: "order-1", project: "cniska/dim-factory", title: "Read a slice" },
    operator.name,
  );
  startOrder(db, "order-1", operator.name, undefined, repo.dir);
  const dir = worktreePath(repo.dir, "order-1");
  approvePlan(db, "order-1", operator.name);
  return {
    db,
    worker: builder.name,
    operator: operator.name,
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
  recordOrderCheck(db, "order-1", ranCheck({ command: "bun run verify", exitCode: 0 }), sha);
  recordOrderBuild(db, "order-1", `The ${name} slice is built and verified.`, sha, worker);
  const left = nextOrderSlice(db, "order-1");
  if (left) completeOrderSlice(db, "order-1", left.id, worker);
  else finishAttempt(db, "order-1", "succeeded", undefined, new Date().toISOString());
  approveOrder(db, "order-1", operator.name, `review ${name}`);
  return sha;
}

describe("a review round", () => {
  test("reads the same diff again in a new round when its Review artifact is returned", async () => {
    const { db, worker, operator, dir } = floor();
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
           JOIN factory_order_event w ON w.artifact_id = a.id AND w.kind = 'artifact_submitted'
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
      { kind: "artifact_submitted", worker: done.reviewer, revision: 1 },
      { kind: "artifact_returned", worker: operator, revision: 1 },
      { kind: "artifact_submitted", worker: done.reviewer, revision: 2 },
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

    expect(done).toMatchObject({ findings: 1 });
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
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "parent");

    const done = await review(db, operator, dir, answering(reviewOutput()), {
      ...machine,
      [WORKER_NAME_VAR]: worker,
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

    await expect(review(db, operator, dir, () => ({ failure: "the reviewer exited 3" }))).rejects.toThrow(
      "reviewer did not finish",
    );

    expect(db.query("SELECT outcome FROM factory_order_review").all()).toEqual([{ outcome: "aborted" }]);
    expect(db.query("SELECT station FROM factory_order_event WHERE kind = 'failed'").all()).toEqual([
      { station: "review" },
    ]);
    expect(
      db
        .query(
          "SELECT station, kind, outcome, reason FROM factory_order_attempt WHERE station = 'review' ORDER BY id",
        )
        .all(),
    ).toEqual([
      { station: "review", kind: "started", outcome: "running", reason: null },
      {
        station: "review",
        kind: "finished",
        outcome: "failed",
        reason: expect.stringContaining("the reviewer exited 3"),
      },
    ]);
  });

  test("records a crashed reviewer with the harness explanation", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "crashed-review");

    await expect(
      runStation(db, "order-1", reviewStation, operator, {
        dir,
        harness: "codex",
        adapter: fakeHarness("crash"),
        env: {
          ...machine,
          [WORKER_NAME_VAR]: operator,
        },
      }),
    ).rejects.toThrow("fake process crashed");

    expect(
      db
        .query(
          `SELECT a.reason, w.role FROM factory_order_attempt a JOIN factory_worker w ON w.name = a.worker
           WHERE a.station = 'review' AND a.kind = 'finished'`,
        )
        .get(),
    ).toEqual({ reason: expect.stringContaining("fake process crashed"), role: "reviewer" });
  });

  test("fails a reviewer stopped by a usage limit with the limit, and records it limited with its reset", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "limited-review");

    const failure = await runStation(db, "order-1", reviewStation, operator, {
      dir,
      harness: "codex",
      adapter: fakeHarness("limited"),
      env: { ...machine, [WORKER_NAME_VAR]: operator },
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "usage_limited" });
    expect(failure).toMatchObject({
      message:
        "codex stopped at its usage limit until 2026-09-27T16:50:00.000Z; delegate again after the reset with --harness codex, or name another of <codex|claude|grok>",
    });
    expect(
      db
        .query(
          "SELECT kind, outcome, resets_at FROM factory_order_attempt WHERE order_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get("order-1"),
    ).toEqual({ kind: "finished", outcome: "limited", resets_at: "2026-09-27T16:50:00.000Z" });
    expect(db.query("SELECT outcome FROM factory_order_review").get()).toEqual({ outcome: "aborted" });
  });

  test("records a harness failure after opening a round but before reviewer assignment", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "unavailable-review");
    const adapter = {
      ...fakeHarness("review"),
      start: async () => {
        throw new Error("harness unavailable");
      },
    };

    await expect(
      runStation(db, "order-1", reviewStation, operator, { dir, harness: "codex", adapter, env: machine }),
    ).rejects.toThrow("harness unavailable");
    expect(db.query("SELECT outcome FROM factory_order_review").get()).toEqual({ outcome: "aborted" });
    expect(
      db.query("SELECT worker, station, reason FROM factory_order_event WHERE kind = 'failed'").get(),
    ).toEqual({ worker: null, station: "review", reason: "harness unavailable" });
    expect(
      db.query("SELECT count(*) AS n FROM factory_order_attempt WHERE station = 'review'").get(),
    ).toEqual({
      n: 0,
    });
    expect(await review(db, operator, dir, answering(reviewOutput()))).toMatchObject({ findings: 0 });
  });

  test("a reviewer run that ends before assignment leaves review retryable", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "bootstrap-review");

    await expect(
      runStation(db, "order-1", reviewStation, operator, {
        dir,
        harness: "codex",
        adapter: fakeHarness("bootstrap-failure"),
        env: machine,
      }),
    ).rejects.toThrow("worker bootstrap failed");
    expect(
      db.query("SELECT worker, station, reason FROM factory_order_event WHERE kind = 'failed'").get(),
    ).toEqual({
      worker: null,
      station: "review",
      reason: expect.stringContaining("worker bootstrap failed"),
    });
    expect(db.query("SELECT outcome FROM factory_order_review").get()).toEqual({ outcome: "aborted" });
    expect(await review(db, operator, dir, answering(reviewOutput()))).toMatchObject({ findings: 0 });
  });

  test("a resumed reviewer that ends before assignment leaves review retryable", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "bootstrap-resume-review");
    await review(db, operator, dir, answering(reviewOutput()));
    runOrderCommand(db, ["return", "order-1", "--reason", "review again"], null, dir, {
      ...machine,
      [WORKER_NAME_VAR]: operator,
    });

    await expect(
      runStation(db, "order-1", reviewStation, operator, {
        dir,
        harness: "codex",
        adapter: fakeHarness("bootstrap-failure"),
        env: machine,
      }),
    ).rejects.toThrow("worker bootstrap failed");
    expect(db.query("SELECT worker, station FROM factory_order_event WHERE kind = 'failed'").get()).toEqual({
      worker: null,
      station: "review",
    });
    expect(await review(db, operator, dir, answering(reviewOutput()))).toMatchObject({ findings: 0 });
  });

  test("records the reviewer's structured result through the factory", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "review-result");
    const outcome = await runStation(db, "order-1", reviewStation, operator, {
      dir,
      harness: "codex",
      adapter: fakeHarness("review"),
      env: {
        ...machine,
        [WORKER_NAME_VAR]: operator,
      },
    });

    expect(outcome).toMatchObject({ findings: 0 });
    expect(
      db
        .query(
          "SELECT station, kind, outcome, worker FROM factory_order_attempt WHERE station = 'review' ORDER BY id",
        )
        .all(),
    ).toEqual([
      { station: "review", kind: "started", outcome: "running", worker: outcome.reviewer },
      { station: "review", kind: "finished", outcome: "succeeded", worker: outcome.reviewer },
    ]);
    expect(
      db
        .query(
          `SELECT a.body, w.worker FROM factory_order_artifact a
           JOIN factory_order_event w ON w.artifact_id = a.id AND w.kind = 'artifact_submitted'
           WHERE a.kind = 'review'`,
        )
        .get(),
    ).toEqual({
      body: expect.stringContaining("## Verdict\n\n**May advance.** The change is sound."),
      worker: outcome.reviewer,
    });
  });

  test("briefs a new reviewer after a review that did not finish a turn", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "review-first");
    const base = fakeHarness("crash");
    let starts = 0;
    let resumes = 0;
    const adapter = {
      ...base,
      start: async (request: Parameters<typeof base.start>[0]) => {
        starts += 1;
        return fakeHarness("crash", `fake-session-${starts}`).start(request);
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
    };

    const options = { dir, adapter, env, harness: "codex" as const };
    await expect(runStation(db, "order-1", reviewStation, operator, options)).rejects.toThrow(
      "fake process crashed",
    );
    slice(db, dir, worker, "review-second");
    await expect(runStation(db, "order-1", reviewStation, operator, options)).rejects.toThrow(
      "fake process crashed",
    );

    expect(
      db
        .query("SELECT count(DISTINCT worker) AS n FROM factory_order_attempt WHERE station = 'review'")
        .get(),
    ).toEqual({ n: 2 });
    expect(starts).toBe(2);
    expect(resumes).toBe(0);
    expect(db.query("SELECT count(*) AS n FROM factory_worker WHERE role = 'reviewer'").get()).toEqual({
      n: 2,
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

  test("the reviewer's environment carries its name as a label and no credential", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    let env: Readonly<Record<string, string>> = {};
    const seen = (request: HarnessRequest): ScriptedAnswer => {
      env = request.env;
      return { output: reviewOutput() };
    };
    const factoryVars = () => Object.keys(env).filter((name) => name.startsWith("DIM_WORKER"));

    await review(db, operator, dir, seen);

    expect(factoryVars()).toEqual([]);

    slice(db, dir, worker, "b");
    const done = await review(db, operator, dir, seen);

    expect(factoryVars()).toEqual(["DIM_WORKER_NAME"]);
    expect(env[WORKER_NAME_VAR]).toBe(done.reviewer);
  });

  test("a second round reads the whole order again, so a finding on an untouched file can be raised again", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    const first = await review(db, operator, dir, answering(reviewOutput()));
    const fixed = slice(db, dir, worker, "b");

    let read = "";
    await review(db, operator, dir, (request) => {
      read = argvOf(request).find((argument) => argument.includes("git diff ")) ?? "";
      return { output: reviewOutput() };
    });

    const firstBase = db
      .query<{ base_sha: string }, [number]>("SELECT base_sha FROM factory_order_review WHERE id = ?")
      .get(first.review);
    expect(read).toContain(`${firstBase?.base_sha}..${fixed}`);
  });

  test("a round is refused over a tree that can still move", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    writeFileSync(join(dir, "uncommitted.txt"), "still moving");

    await expect(review(db, operator, dir, answering(reviewOutput()))).rejects.toThrow(
      expect.objectContaining({ code: "worktree_dirty" }),
    );
    expect(db.query("SELECT count(*) AS n FROM factory_order_review").get()).toEqual({ n: 0 });
    expect(
      db.query("SELECT worker, station, reason FROM factory_order_event WHERE kind = 'failed'").get(),
    ).toEqual({
      worker: null,
      station: "review",
      reason: expect.stringContaining("uncommitted changes"),
    });
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

  test("a second reviewer is refused while the first runs", async () => {
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

    expect(await refusal).toMatchObject({ code: "order_held_by_run" });
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
    else expect(await run()).toMatchObject({ findings: 1 });
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

  test("the brief carries only the order, the diff and the plan, and names dim-review", () => {
    const brief = reviewerBrief(
      { id: "order-1", title: "Read a slice", description: null, line: "fix" },
      { base: "aaa", head: "bbb" },
      {
        plan: {
          body: "## Outcome\n\nRefuse empty tokens.",
          slices: [{ title: "Gate", outcome: "Empty refused." }],
        },
        earlier: [],
      },
    );
    expect(brief).toBe(
      [
        "You are the reviewer for factory order order-1 in this repository. Run dim-review.",
        "",
        "# Read a slice",
        "",
        "This order's line is fix.",
        "",
        "## Diff",
        "`git diff aaa..bbb`",
        "",
        "## Approved plan",
        "## Outcome\n\nRefuse empty tokens.",
        "",
        "## Plan slices",
        "1. Gate: Empty refused.",
      ].join("\n"),
    );
  });

  test("the brief lists each earlier finding with the builder's answer", () => {
    const brief = reviewerBrief(
      { id: "order-1", title: "Read a slice", description: null, line: "fix" },
      { base: "aaa", head: "bbb" },
      {
        plan: { body: "## Outcome\n\nRead it.", slices: [] },
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
        "## Earlier findings",
        "- Finding 7 (tests, src/example.ts:1): no test",
        "  - Fix asked for: add the test",
        "  - Builder's answer: refused: later slice",
      ].join("\n"),
    );
  });

  test("sends the order to build when the round after a return raises a finding", async () => {
    const { db, worker, operator, dir } = floor();
    slice(db, dir, worker, "a");
    const env = {
      ...machine,
      [WORKER_NAME_VAR]: operator,
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
