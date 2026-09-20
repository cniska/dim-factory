import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimOrder, queueOrder, raiseOrderFinding, recordOrderCommit } from "./factory-order";
import { WORKER_NAME_VAR, WORKER_TOKEN_VAR } from "./factory-worker";
import { integratedRepo, orderWorktree, workerIn } from "./fixtures.test-support";
import { REVIEWER_TOOLS, type ReviewerSpawn, ReviewRefused, runOrderReview } from "./order-review";
import { SCHEMA_SQL } from "./schema";

const trunk = integratedRepo();
const worktrees: string[] = [];
const opened: Database[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  for (const path of worktrees) rmSync(path, { recursive: true, force: true });
  rmSync(trunk.dir, { recursive: true, force: true });
});

// A harness map, because routing resolves the reviewer's model through one and refuses
// without it. The names are the map's, never a model this repo knows.
const machine = (() => {
  const home = orderWorktree(trunk.dir, "routing-home");
  worktrees.push(home);
  writeFileSync(join(home, "routing.json"), '{ "cheap": "s", "standard": "m", "deep": "l" }');
  return { DIM_HOME: home };
})();

function floor(): { db: Database; worker: string; dir: string } {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  opened.push(db);
  const worker = workerIn(db);
  const dir = orderWorktree(trunk.dir, `review-${opened.length}`);
  worktrees.push(dir);
  queueOrder(db, { id: "order-1", project: "cniska/dim-factory", title: "Read a slice" }, worker);
  claimOrder(db, "order-1", { runId: "run-1", station: "dim-station-build" }, worker, undefined, trunk.dir);
  return { db, worker, dir };
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
  return sha;
}

describe("a review round", () => {
  // The whole of the fix: the hand that writes the finding is one the builder was handed
  // no token for, and the record can tell them apart afterwards.
  test("the finding names the spawned reviewer and not the builder that asked for it", () => {
    const { db, worker, dir } = floor();
    slice(db, dir, worker, "a");
    const spawn: ReviewerSpawn = (_argv, env) => {
      raiseOrderFinding(
        db,
        "order-1",
        { dimension: "correctness", summary: "the guard is the wrong way round" },
        env[WORKER_NAME_VAR] as string,
      );
      return { exitCode: 0 };
    };

    const done = runOrderReview(db, "order-1", worker, { dir, spawn, env: machine });

    expect(done).toMatchObject({ findings: 1, outcome: "closed" });
    expect(done.reviewer).not.toBe(worker);
    const row = db
      .query(
        "SELECT e.worker, w.role FROM factory_order_event e JOIN factory_worker w ON w.name = e.worker WHERE e.kind = 'finding_raised'",
      )
      .get();
    expect(row).toEqual({ worker: done.reviewer, role: "reviewer" });
  });

  test("the builder cannot raise one under its own name", () => {
    const { db, worker, dir } = floor();
    slice(db, dir, worker, "a");
    const spawn: ReviewerSpawn = () => ({ exitCode: 0 });
    runOrderReview(db, "order-1", worker, { dir, spawn, env: machine });

    expect(() => raiseOrderFinding(db, "order-1", { dimension: "tests", summary: "mine" }, worker)).toThrow(
      /no review open/,
    );
  });

  test("a reviewer that did not finish leaves an aborted round, not a clean one", () => {
    const { db, worker, dir } = floor();
    slice(db, dir, worker, "a");
    const spawn: ReviewerSpawn = () => ({ exitCode: 3 });

    const done = runOrderReview(db, "order-1", worker, { dir, spawn, env: machine });

    expect(done).toMatchObject({ findings: 0, outcome: "aborted" });
    expect(db.query("SELECT outcome FROM factory_order_review WHERE id = ?").get(done.review)).toEqual({
      outcome: "aborted",
    });
  });

  test("the reviewer is handed no tool that could edit", () => {
    const { db, worker, dir } = floor();
    slice(db, dir, worker, "a");
    let handed: string[] = [];
    const spawn: ReviewerSpawn = (argv) => {
      handed = argv;
      return { exitCode: 0 };
    };

    runOrderReview(db, "order-1", worker, { dir, spawn, env: machine });

    const allowed = (handed[handed.indexOf("--allowedTools") + 1] as string).split(",");
    expect(allowed).toEqual(REVIEWER_TOOLS);
    for (const tool of ["Edit", "Write", "NotebookEdit", "Bash", "Bash(*)"]) {
      expect(allowed).not.toContain(tool);
    }
  });

  // The token is the whole of the separation, so it must reach the child's environment and
  // nothing the builder's process can read back off the command line.
  test("the reviewer's token rides in its environment and not its argv", () => {
    const { db, worker, dir } = floor();
    slice(db, dir, worker, "a");
    let argv: string[] = [];
    let env: Record<string, string> = {};
    const spawn: ReviewerSpawn = (given, environment) => {
      argv = given;
      env = environment;
      return { exitCode: 0 };
    };

    const done = runOrderReview(db, "order-1", worker, { dir, spawn, env: machine });

    expect(env[WORKER_NAME_VAR]).toBe(done.reviewer);
    expect(env[WORKER_TOKEN_VAR]).toMatch(/^[0-9a-f]{32}$/);
    expect(argv.join(" ")).not.toContain(env[WORKER_TOKEN_VAR] as string);
  });

  test("a second round reads only what the first one did not", () => {
    const { db, worker, dir } = floor();
    slice(db, dir, worker, "a");
    const quiet: ReviewerSpawn = () => ({ exitCode: 0 });
    const first = runOrderReview(db, "order-1", worker, { dir, spawn: quiet, env: machine });
    const fixed = slice(db, dir, worker, "b");

    let read = "";
    runOrderReview(db, "order-1", worker, {
      dir,
      env: machine,
      spawn: (argv) => {
        read = argv[2] as string;
        return { exitCode: 0 };
      },
    });

    const firstHead = db
      .query<{ head_sha: string }, [number]>("SELECT head_sha FROM factory_order_review WHERE id = ?")
      .get(first.review);
    expect(read).toContain(`${firstHead?.head_sha}..${fixed}`);
  });

  test("a round is refused over a tree that can still move", () => {
    const { db, worker, dir } = floor();
    slice(db, dir, worker, "a");
    writeFileSync(join(dir, "uncommitted.txt"), "still moving");

    expect(() => runOrderReview(db, "order-1", worker, { dir, env: machine })).toThrow(ReviewRefused);
    expect(db.query("SELECT count(*) AS n FROM factory_order_review").get()).toEqual({ n: 0 });
  });

  test("a round is refused over a head the order never recorded", () => {
    const { db, worker, dir } = floor();
    slice(db, dir, worker, "a");
    writeFileSync(join(dir, "unrecorded.txt"), "b");
    Bun.spawnSync(["git", "-C", dir, "add", "."]);
    Bun.spawnSync(["git", "-C", dir, "commit", "-q", "-m", "feat: unrecorded"]);

    expect(() => runOrderReview(db, "order-1", worker, { dir, env: machine })).toThrow(
      /is not a commit order order-1 recorded/,
    );
  });

  test("two rounds cannot be open over one order", () => {
    const { db, worker, dir } = floor();
    slice(db, dir, worker, "a");
    const spawn: ReviewerSpawn = () => {
      expect(() => runOrderReview(db, "order-1", worker, { dir, env: machine })).toThrow(
        /already has review/,
      );
      return { exitCode: 0 };
    };

    runOrderReview(db, "order-1", worker, { dir, spawn, env: machine });
  });
});
