import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SCHEMA_SQL } from "./db-schema";
import { workerIn } from "./fixtures.test-support";
import { assertNext, type OrderAct, type OrderActRefused, orderState } from "./order-state";

const ORDER = "order-1";

function record() {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  const worker = workerIn(db, "operator");
  let tick = 0;
  const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  db.run(
    `INSERT INTO factory_order (id, project, title, created_at, updated_at)
     VALUES (?, 'cniska/dim-factory', 'Read the state', ?, ?)`,
    [ORDER, at(), at()],
  );
  const event = (kind: string, fields: Record<string, string | number> = {}): void => {
    const columns = Object.keys(fields);
    db.run(
      `INSERT INTO factory_order_event (order_id, ts, kind, worker${columns.map((one) => `, ${one}`).join("")})
       VALUES (?, ?, ?, ?${columns.map(() => ", ?").join("")})`,
      [ORDER, at(), kind, worker, ...Object.values(fields)],
    );
  };
  event("started");
  const revision = (kind: string): number =>
    (db
      .query<{ n: number }, [string]>(
        "SELECT coalesce(max(revision), 0) + 1 AS n FROM factory_order_artifact WHERE kind = ?",
      )
      .get(kind)?.n ?? 1) as number;
  const artifact = (kind: string, headSha: string | null, reviewId: number | null): number => {
    const id = Number(
      db.run(
        "INSERT INTO factory_order_artifact (order_id, kind, revision, body, head_sha, review_id) VALUES (?, ?, ?, 'body', ?, ?)",
        [ORDER, kind, revision(kind), headSha, reviewId],
      ).lastInsertRowid,
    );
    event("artifact_written", { artifact_id: id });
    return id;
  };
  const approve = (artifactId: number): void => event("artifact_approved", { artifact_id: artifactId });
  const giveBack = (artifactId: number): void =>
    event("artifact_returned", { artifact_id: artifactId, reason: "not yet" });
  const check = (): number =>
    Number(
      db.run(
        "INSERT INTO factory_order_check (order_id, command, exit_code, finished_at, recorded_at) VALUES (?, 'bun run verify', 0, ?, ?)",
        [ORDER, at(), at()],
      ).lastInsertRowid,
    );
  const r = {
    db,
    worker,
    event,
    plan(slices = 1): { id: number; slices: number[] } {
      const id = artifact("plan", null, null);
      const ids = Array.from({ length: slices }, (_, index) =>
        Number(
          db.run(
            "INSERT INTO factory_order_slice (artifact_id, ordinal, title, outcome) VALUES (?, ?, 'slice', 'done')",
            [id, index + 1],
          ).lastInsertRowid,
        ),
      );
      return { id, slices: ids };
    },
    approve,
    giveBack,
    complete(sliceId: number): void {
      db.run("INSERT INTO factory_order_slice_completion (slice_id, worker, completed_at) VALUES (?, ?, ?)", [
        sliceId,
        worker,
        at(),
      ]);
    },
    commit(sha: string): void {
      db.run("INSERT INTO factory_order_commit (order_id, sha, recorded_at) VALUES (?, ?, ?)", [
        ORDER,
        sha,
        at(),
      ]);
      event("commit_created", { commit_sha: sha });
    },
    build: (head: string): number => artifact("build", head, null),
    round(head: string): number {
      const round = db
        .query<{ n: number }, []>("SELECT coalesce(max(round), 0) + 1 AS n FROM factory_order_review")
        .get()?.n as number;
      return Number(
        db.run(
          `INSERT INTO factory_order_review (order_id, round, reviewer, base_sha, head_sha, opened_at, closed_at, outcome)
           VALUES (?, ?, ?, 'base', ?, ?, ?, 'closed')`,
          [ORDER, round, worker, head, at(), at()],
        ).lastInsertRowid,
      );
    },
    review(roundId: number): number {
      const head = db
        .query<{ head_sha: string }, [number]>("SELECT head_sha FROM factory_order_review WHERE id = ?")
        .get(roundId)?.head_sha as string;
      return artifact("review", head, roundId);
    },
    finding(roundId: number): number {
      return Number(
        db.run(
          `INSERT INTO factory_order_finding (review_id, dimension, file, line, failure, fix, severity, raised_at)
           VALUES (?, 'tests', 'src/a.ts', 1, 'no test', 'add one', 'medium', ?)`,
          [roundId, at()],
        ).lastInsertRowid,
      );
    },
    answer(findingId: number, answer: "fixed" | "refused"): void {
      db.run(
        "INSERT INTO factory_order_finding_answer (finding_id, run_id, answer, resolution, recorded_at) VALUES (?, ?, ?, ?, ?)",
        [findingId, `build-${tick}`, answer, answer === "refused" ? "out of scope" : null, at()],
      );
    },
    rewrite(oldHead: string, newHead: string, patchEqual: boolean): void {
      db.run("INSERT INTO factory_order_commit (order_id, sha, recorded_at) VALUES (?, ?, ?)", [
        ORDER,
        newHead,
        at(),
      ]);
      event("commit_rewritten", { commit_sha: newHead, evidence: JSON.stringify({ from: oldHead }) });
      db.run(
        `INSERT INTO factory_order_rewrite
         (order_id, old_base, new_base, old_head, new_head, patch_equal, check_id, worker, recorded_at)
         VALUES (?, 'base', 'trunk', ?, ?, ?, ?, ?, ?)`,
        [ORDER, oldHead, newHead, patchEqual ? 1 : 0, check(), worker, at()],
      );
    },
    conflict(): void {
      event("ship_failed", {
        evidence: JSON.stringify({
          code: "ship_rebase_conflict",
          oldBase: "base",
          newBase: "trunk",
          oldHead: "c1",
          stoppedAt: "c1",
          paths: JSON.stringify(["src/a.ts"]),
        }),
      });
    },
  };
  return r;
}

function built() {
  const r = record();
  const plan = r.plan();
  r.approve(plan.id);
  r.commit("c1");
  r.complete(plan.slices[0] as number);
  return r;
}

function buildApproved() {
  const r = built();
  r.approve(r.build("c1"));
  return r;
}

function reviewed() {
  const r = buildApproved();
  const round = r.round("c1");
  return { ...r, round, artifact: r.review(round) };
}

function shippable() {
  const r = reviewed();
  r.approve(r.artifact);
  return r;
}

describe("the plan station", () => {
  test("runs the planner while no plan is written", () => {
    expect(orderState(record().db, ORDER)).toEqual({ station: "plan", next: "run" });
  });

  test("waits on approval of a written plan", () => {
    const r = record();
    r.plan();
    expect(orderState(r.db, ORDER)).toEqual({ station: "plan", next: "approve" });
  });

  test("runs the planner again after its plan was returned", () => {
    const r = record();
    r.giveBack(r.plan().id);
    expect(orderState(r.db, ORDER)).toEqual({ station: "plan", next: "run" });
  });
});

describe("the build station", () => {
  test("runs the builder while a slice of the approved plan is left", () => {
    const r = record();
    const plan = r.plan(2);
    r.approve(plan.id);
    r.commit("c1");
    r.complete(plan.slices[0] as number);
    r.approve(r.build("c1"));
    expect(orderState(r.db, ORDER)).toEqual({ station: "build", next: "run" });
  });

  test("runs the builder while a rebase conflict is unresolved", () => {
    const r = shippable();
    r.conflict();
    expect(orderState(r.db, ORDER)).toEqual({ station: "build", next: "run" });
  });

  test("runs the builder while it owes a finding an answer", () => {
    const r = buildApproved();
    const round = r.round("c1");
    r.finding(round);
    r.review(round);
    expect(orderState(r.db, ORDER)).toEqual({ station: "build", next: "run" });
  });

  test("runs the builder while no Build artifact is written for the head", () => {
    expect(orderState(built().db, ORDER)).toEqual({ station: "build", next: "run" });
  });

  test("runs the builder when the latest Build artifact is for an earlier commit", () => {
    const r = built();
    r.build("c1");
    r.commit("c2");
    expect(orderState(r.db, ORDER)).toEqual({ station: "build", next: "run" });
  });

  test("waits on approval of the Build artifact for the head", () => {
    const r = built();
    r.build("c1");
    expect(orderState(r.db, ORDER)).toEqual({ station: "build", next: "approve" });
  });

  test("runs the builder again after its Build artifact was returned", () => {
    const r = built();
    r.giveBack(r.build("c1"));
    expect(orderState(r.db, ORDER)).toEqual({ station: "build", next: "run" });
  });

  test("keeps the build approval through a rebase that changed a patch", () => {
    const r = shippable();
    r.rewrite("c1", "c1b", false);
    expect(orderState(r.db, ORDER)).toEqual({ station: "review", next: "run" });
  });
});

describe("the review station", () => {
  test("runs the reviewer once the build is approved", () => {
    expect(orderState(buildApproved().db, ORDER)).toEqual({ station: "review", next: "run" });
  });

  test("runs the reviewer again once the builder answered every finding", () => {
    const r = buildApproved();
    const round = r.round("c1");
    const finding = r.finding(round);
    r.review(round);
    r.answer(finding, "refused");
    expect(orderState(r.db, ORDER)).toEqual({ station: "review", next: "run" });
  });

  test("waits on approval of a clean round's Review artifact", () => {
    expect(orderState(reviewed().db, ORDER)).toEqual({ station: "review", next: "approve" });
  });

  test("runs the reviewer again after its Review artifact was returned", () => {
    const r = reviewed();
    r.giveBack(r.artifact);
    expect(orderState(r.db, ORDER)).toEqual({ station: "review", next: "run" });
  });

  test("drops the review approval when a rebase changed a patch", () => {
    const r = shippable();
    r.rewrite("c1", "c1b", false);
    expect(orderState(r.db, ORDER).station).toBe("review");
  });
});

describe("after the stations", () => {
  test("ships once the plan, the build and the review are approved at the head", () => {
    expect(orderState(shippable().db, ORDER)).toEqual({ station: null, next: "ship" });
  });

  test("keeps both approvals through a rebase with equal patches", () => {
    const r = shippable();
    r.rewrite("c1", "c1b", true);
    expect(orderState(r.db, ORDER)).toEqual({ station: null, next: "ship" });
  });

  test("ships after a refused finding once a later clean round is approved", () => {
    const r = buildApproved();
    r.answer(r.finding(r.round("c1")), "refused");
    r.approve(r.review(r.round("c1")));
    expect(orderState(r.db, ORDER)).toEqual({ station: null, next: "ship" });
  });
});

const ACTS: OrderAct[] = ["plan", "build", "review", "approve", "return", "ship"];

function admitted(r: { db: Database }): OrderAct[] {
  return ACTS.filter((act) => {
    try {
      assertNext(r.db, ORDER, act);
      return true;
    } catch (error) {
      expect((error as OrderActRefused).code).toBe("not_next");
      return false;
    }
  });
}

describe("an act's entry", () => {
  test("admits only planning while no plan is written", () => {
    expect(admitted(record())).toEqual(["plan"]);
  });

  test("admits only approval or return of a written plan", () => {
    const r = record();
    r.plan();
    expect(admitted(r)).toEqual(["approve", "return"]);
  });

  test("admits only building while a slice is left", () => {
    const r = record();
    r.approve(r.plan().id);
    expect(admitted(r)).toEqual(["build"]);
  });

  test("admits only reviewing once the build is approved", () => {
    expect(admitted(buildApproved())).toEqual(["review"]);
  });

  test("admits only shipping once every station's artifact is approved", () => {
    expect(admitted(shippable())).toEqual(["ship"]);
  });

  test("admits nothing once the order shipped, and says so", () => {
    const r = shippable();
    r.event("shipped");
    expect(admitted(r)).toEqual([]);
    expect(() => assertNext(r.db, ORDER, "ship")).toThrow("order order-1 is done, so it cannot ship");
  });

  test("names the act the order waits on when it refuses another", () => {
    const r = built();
    r.build("c1");
    expect(() => assertNext(r.db, ORDER, "review")).toThrow(
      "order order-1 waits on approve at build, so it cannot review",
    );
  });
});
