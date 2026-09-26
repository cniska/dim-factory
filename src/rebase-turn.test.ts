import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitBuildTurn } from "./builder-commit";
import {
  claimOrder,
  currentOrderCommits,
  pendingRebaseConflict,
  queueOrder,
  type RecordedConflict,
  recordOrderCommit,
  shipOrder,
} from "./factory-order";
import { mintWorker, newWorkerSession } from "./factory-worker";
import {
  confiningCheckSandbox,
  declareCheck,
  integratedRepo,
  orderWorktree,
  scratchEnv,
  workerIn,
} from "./fixtures.test-support";
import { reviewRange } from "./order-review";
import { rebaseState } from "./rebase-onto-trunk";
import { continueRebaseTurn, reopenRebase } from "./rebase-turn";
import { SCHEMA_SQL } from "./schema";

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, args: string[]): string {
  return Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe" })
    .stdout.toString()
    .trim();
}

function commit(dir: string, file: string, contents: string, subject: string): string {
  writeFileSync(join(dir, file), contents);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", subject]);
  return git(dir, ["rev-parse", "HEAD"]);
}

// Headings underlined with seven `=` are lines of conflict-marker shape carried as content: one
// both sides share, and one only the order's commit adds.
const f = (d: string, notes = false) =>
  `Install\n=======\na\nb\nc\n${d}\ne\nf\ng\n${notes ? "h\nNotes\n=======\n" : ""}`;

/**
 * An order whose two recorded commits both collide with what the trunk did after the order
 * started, shipped once so the conflict is recorded and the order is back at build, then claimed
 * by the build turn that resolves it.
 */
function conflicted(check = "true", markerSize?: number) {
  const repo = integratedRepo();
  const claims = integratedRepo();
  const home = mkdtempSync(join(tmpdir(), "dim-rebase-turn-"));
  cleanup.push(repo.dir, claims.dir, home);
  if (markerSize) {
    writeFileSync(join(repo.dir, ".git", "info", "attributes"), `* conflict-marker-size=${markerSize}\n`);
  }
  declareCheck(repo.dir, check);
  commit(repo.dir, "f.txt", f("d"), "feat: add f");
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  const builder = workerIn(db);
  const operator = mintWorker(db, { role: "operator", sessionId: newWorkerSession("test-operator") }).name;
  const claim = (runId: string) =>
    claimOrder(
      db,
      "order-1",
      { runId, sessionId: runId, station: "dim-station-build", operatorWorker: operator },
      builder,
      undefined,
      claims.dir,
    );
  queueOrder(db, { id: "order-1", project: "cniska/dim-factory", title: "Collide" }, builder);
  claim("run-1");
  const wt = orderWorktree(repo.dir, "order-1");
  cleanup.push(wt);
  const first = commit(wt, "f.txt", f("D", true), "feat: change d");
  const second = commit(wt, "g.txt", "order g\n", "feat: add g");
  recordOrderCommit(db, "order-1", first, builder, "feat: change d");
  recordOrderCommit(db, "order-1", second, builder, "feat: add g");
  commit(repo.dir, "f.txt", f("X"), "feat: change d on the trunk");
  const trunkTip = commit(repo.dir, "g.txt", "trunk g\n", "feat: add g on the trunk");
  const env = scratchEnv(home);
  const sandbox = confiningCheckSandbox();
  let refused: unknown;
  try {
    shipOrder(db, "order-1", wt, operator, { env, checkSandbox: sandbox });
  } catch (error) {
    refused = error;
  }
  claim("run-2");
  const recorded = pendingRebaseConflict(db, "order-1") as RecordedConflict;
  const turn = (paths: string[] = ["f.txt"], conflict = recorded) =>
    continueRebaseTurn({
      db,
      orderId: "order-1",
      runId: "run-2",
      operator,
      worktree: wt,
      conflict,
      paths,
      env,
      checkSandbox: sandbox,
    });
  return { repo, wt, db, builder, operator, first, second, trunkTip, refused, recorded, turn };
}

describe("a conflict at ship", () => {
  test("is recorded with its paths and the rebase it stopped, leaves the worktree mid-rebase, and returns the order to build", () => {
    const { repo, wt, db, second, trunkTip, refused, recorded } = conflicted();

    expect(refused).toMatchObject({ code: "ship_rebase_conflict" });
    expect(git(repo.dir, ["rev-parse", "HEAD"])).toBe(trunkTip);
    expect(recorded).toMatchObject({ paths: ["f.txt"], newBase: trunkTip, oldHead: second });
    expect(rebaseState(wt)).toMatchObject({ origHead: second, onto: trunkTip });
    expect(
      db.query("SELECT kind, outcome, reason FROM factory_order_delivery WHERE order_id = 'order-1'").all(),
    ).toEqual([{ kind: "delivery", outcome: "failed", reason: expect.stringContaining("f.txt") }]);
    expect(db.query("SELECT station FROM factory_order WHERE id = 'order-1'").get()).toEqual({
      station: "dim-station-build",
    });
  });

  test("cannot be shipped past before the builder resolves it", () => {
    const { wt, db, operator, second, recorded } = conflicted();

    expect(() => shipOrder(db, "order-1", wt, operator)).toThrow(
      expect.objectContaining({ code: "ship_rebase_conflict", message: expect.stringContaining("f.txt") }),
    );
    expect(pendingRebaseConflict(db, "order-1")).toEqual(recorded);
    expect(rebaseState(wt)).toMatchObject({ origHead: second, onto: recorded.newBase });
  });

  test("refuses a commit of the build turn while the rebase is in progress", () => {
    const { wt, db, builder, operator } = conflicted();

    expect(() =>
      commitBuildTurn({
        db,
        orderId: "order-1",
        runId: "run-2",
        builder,
        operator,
        worktree: wt,
        turn: { subject: "fix: resolve", artifact: "" },
        finalSlice: false,
        checkSandbox: confiningCheckSandbox(),
      }),
    ).toThrow(expect.objectContaining({ code: "rebase_in_progress" }));
  });
});

describe("continueRebaseTurn", () => {
  test("continues through each conflicting commit, records the rewrite as unequal and returns the order to review for the whole order", () => {
    const { repo, wt, db, first, second, trunkTip, turn } = conflicted();
    writeFileSync(join(wt, "f.txt"), f("D X", true));

    expect(turn()).toEqual({ conflicts: ["g.txt"] });

    writeFileSync(join(wt, "g.txt"), "trunk g\norder g\n");
    const finished = turn(["g.txt"]);

    expect(rebaseState(wt)).toBeNull();
    const current = currentOrderCommits(db, "order-1").map((c) => c.sha);
    expect(current).toHaveLength(2);
    expect(current).not.toContain(first);
    expect(current).not.toContain(second);
    expect(finished).toEqual({ sha: current[1] as string });
    expect(`${git(wt, ["show", `${current[1]}:f.txt`])}\n`).toBe(f("D X", true));
    expect(git(repo.dir, ["rev-parse", "HEAD"])).toBe(trunkTip);
    expect(db.query("SELECT patch_equal FROM factory_order_rewrite").all()).toEqual([{ patch_equal: 0 }]);
    expect(db.query("SELECT station, run_id FROM factory_order WHERE id = 'order-1'").get()).toEqual({
      station: "dim-station-review",
      run_id: null,
    });
    expect(pendingRebaseConflict(db, "order-1")).toBeNull();
    expect(reviewRange(db, "order-1", wt)).toEqual({ base: trunkTip, head: current[1] as string });
  });

  test("refuses a resolution that still carries conflict markers and leaves the rebase where it stopped", () => {
    const { wt, second, turn } = conflicted();

    expect(turn).toThrow(expect.objectContaining({ code: "conflict_unresolved" }));
    expect(rebaseState(wt)).toMatchObject({ origHead: second });
  });

  test("refuses a resolution staged with its markers left in, and the next turn is still told which paths", () => {
    const { wt, recorded, turn } = conflicted();
    git(wt, ["add", "-A"]);

    expect(() => turn()).toThrow(expect.objectContaining({ code: "conflict_unresolved" }));
    expect(reopenRebase(wt, "order-1", recorded)).toEqual(["f.txt"]);
  });

  test("refuses a resolution that removed the labelled markers but left the separator", () => {
    const { wt, turn } = conflicted();
    const left = f("D", true).replace("D\n", "D\n=======\nX\n");
    writeFileSync(join(wt, "f.txt"), left);

    expect(() => turn()).toThrow(expect.objectContaining({ code: "conflict_unresolved" }));
  });

  test("refuses markers git wrote longer than seven where the repository sets conflict-marker-size", () => {
    const { wt, turn } = conflicted("true", 10);

    expect(git(wt, ["show", ":2:f.txt"])).not.toBe("");
    expect(() => turn()).toThrow(expect.objectContaining({ code: "conflict_unresolved" }));
  });

  test("names the stopped commit's paths when the unmerged ones were staged away", () => {
    const { wt, recorded } = conflicted();
    writeFileSync(join(wt, "f.txt"), f("D X", true));
    writeFileSync(join(wt, "landed.txt"), "touched outside the conflict");
    git(wt, ["add", "-A"]);

    expect(reopenRebase(wt, "order-1", recorded)).toEqual(["f.txt"]);
  });

  test("names the later stop's paths when its unmerged ones were staged away", () => {
    const { wt, recorded, turn } = conflicted();
    writeFileSync(join(wt, "f.txt"), f("D X", true));
    turn();
    git(wt, ["add", "-A"]);

    expect(reopenRebase(wt, "order-1", recorded)).toEqual(["g.txt"]);
    expect(() => turn(["g.txt"])).toThrow(expect.objectContaining({ code: "conflict_unresolved" }));
  });

  test("continues a resolution that keeps only the trunk's side but adds a file of its own", () => {
    const { wt, turn } = conflicted();
    writeFileSync(join(wt, "f.txt"), f("X"));
    writeFileSync(join(wt, "note.txt"), "why the trunk's side stands");

    expect(turn()).toEqual({ conflicts: ["g.txt"] });
  });

  test("refuses a resolution that drops the order's change, before anything is staged", () => {
    const { wt, turn } = conflicted();
    writeFileSync(join(wt, "f.txt"), f("X"));

    expect(() => turn()).toThrow(
      expect.objectContaining({ code: "conflict_unresolved", message: expect.stringContaining("empty") }),
    );
    expect(git(wt, ["diff", "--name-only", "--diff-filter=U"])).toBe("f.txt");
  });

  test("refuses a rebase in progress that is not the one the ship recorded", () => {
    const { recorded, turn } = conflicted();
    const nowhere = "0000000000000000000000000000000000000000";

    expect(() => turn(["f.txt"], { ...recorded, oldHead: nowhere })).toThrow(
      expect.objectContaining({ code: "rebase_mismatch" }),
    );
    expect(() => turn(["f.txt"], { ...recorded, newBase: nowhere })).toThrow(
      expect.objectContaining({ code: "rebase_mismatch" }),
    );
  });

  test("does not reopen a rebase once the branch has moved off the head the ship recorded", () => {
    const { wt, recorded, turn } = conflicted("exit 5");
    writeFileSync(join(wt, "f.txt"), f("D X", true));
    turn();
    writeFileSync(join(wt, "g.txt"), "trunk g\norder g\n");
    expect(turn).toThrow(expect.objectContaining({ code: "check_failed" }));
    commit(wt, "h.txt", "h", "feat: add h outside the runner");

    expect(() => reopenRebase(wt, "order-1", recorded)).toThrow(
      expect.objectContaining({ code: "rebase_mismatch" }),
    );
    expect(rebaseState(wt)).toBeNull();
  });

  test("a red check takes the finished rebase back, and the next turn reopens it where the ship stopped", () => {
    const { wt, db, second, recorded, turn } = conflicted("exit 5");
    writeFileSync(join(wt, "f.txt"), f("D X", true));
    turn();
    writeFileSync(join(wt, "g.txt"), "trunk g\norder g\n");

    expect(turn).toThrow(expect.objectContaining({ code: "check_failed" }));

    expect(rebaseState(wt)).toBeNull();
    expect(git(wt, ["rev-parse", "HEAD"])).toBe(second);
    expect(db.query("SELECT count(*) AS n FROM factory_order_rewrite").get()).toEqual({ n: 0 });
    expect(db.query("SELECT exit_code FROM factory_order_check").all()).toEqual([{ exit_code: 5 }]);
    expect(pendingRebaseConflict(db, "order-1")).toEqual(recorded);

    expect(reopenRebase(wt, "order-1", recorded)).toEqual(["f.txt"]);
    expect(rebaseState(wt)).toMatchObject({ origHead: second, onto: recorded.newBase });
  });
});
