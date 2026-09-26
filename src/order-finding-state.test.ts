import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import { SCHEMA_SQL } from "./db-schema";
import { attemptIn, integratedRepo, located, reviewIn, workerIn } from "./fixtures.test-support";
import { rebuild } from "./ingest-sync";
import { recordOrderCommit } from "./order-evidence";
import { answerOrderFindings, raiseOrderFinding } from "./order-finding";
import { displayedAnswer, type FindingStanding, findingStanding } from "./order-finding-state";
import { queueOrder, startOrder } from "./order-lifecycle";
import { closeOrderReview, recordOrderReviewArtifact } from "./order-review";
import { describeState, orderState } from "./order-state";
import { dbPath } from "./paths";
import { approveFinalBuildAt, approvePlan } from "./station-approvals.test-support";

const trunk = integratedRepo();
afterAll(() => rmSync(trunk.dir, { recursive: true, force: true }));

type Floor = { db: Database; builder: string; operator: string };

function floor(db = new Database(":memory:"), schema = true): Floor {
  if (schema) db.run(SCHEMA_SQL);
  const builder = workerIn(db);
  const operator = workerIn(db, "operator");
  queueOrder(db, { id: "order-1", project: "cniska/dim-factory", title: "Answer findings" }, operator);
  startOrder(db, "order-1", operator, undefined, trunk.dir);
  approvePlan(db, "order-1", operator);
  recordOrderCommit(db, "order-1", "base0000", builder);
  attemptIn(db, "order-1", builder, operator);
  approveFinalBuildAt(db, "order-1", "base0000", builder, operator);
  return { db, builder, operator };
}

function answer(f: Floor, finding: number, given: "fixed" | "refused", run = "build-1"): void {
  answerOrderFindings(
    f.db,
    "order-1",
    run,
    [{ finding, answer: given, resolution: given === "refused" ? "the gate is a later slice" : null }],
    f.builder,
  );
}

function raised(f: Floor): number {
  const round = reviewIn(f.db, "order-1", f.operator);
  const finding = raiseOrderFinding(
    f.db,
    "order-1",
    located({ dimension: "tests", failure: "no test holds the gate" }),
    round.reviewer,
  );
  closeOrderReview(f.db, round.review, "closed", round.reviewer);
  return finding;
}

describe("the answer a finding shows", () => {
  test("is unanswered until the builder answers it, and the answer after", () => {
    const f = floor();
    const finding = raised(f);
    expect(displayedAnswer(findingStanding(f.db, finding) as FindingStanding)).toBe("unanswered");
    answer(f, finding, "refused");
    expect(findingStanding(f.db, finding)).toMatchObject({
      answer: "refused",
      resolution: "the gate is a later slice",
    });
    expect(displayedAnswer(findingStanding(f.db, finding) as FindingStanding)).toBe("refused");
  });
});

describe("recording an answer", () => {
  test("writes the answer under the run and a finding_answered event under the builder", () => {
    const f = floor();
    const finding = raised(f);
    answerOrderFindings(
      f.db,
      "order-1",
      "build-7",
      [{ finding, answer: "refused", resolution: "no doc names it" }],
      f.builder,
      "2026-09-26T10:00:00.000Z",
    );
    expect(
      f.db.query("SELECT finding_id, run_id, answer, resolution FROM factory_order_finding_answer").all(),
    ).toEqual([{ finding_id: finding, run_id: "build-7", answer: "refused", resolution: "no doc names it" }]);
    expect(
      f.db.query("SELECT worker, finding_id FROM factory_order_event WHERE kind = 'finding_answered'").all(),
    ).toEqual([{ worker: f.builder, finding_id: finding }]);
  });

  test("is refused from any hand but a builder", () => {
    const f = floor();
    const finding = raised(f);
    expect(() =>
      answerOrderFindings(
        f.db,
        "order-1",
        "build-1",
        [{ finding, answer: "fixed", resolution: null }],
        f.operator,
      ),
    ).toThrow(expect.objectContaining({ code: "worker_not_builder" }));
  });

  test("is refused on a finding already answered", () => {
    const f = floor();
    const finding = raised(f);
    answer(f, finding, "fixed");
    expect(() => answer(f, finding, "refused", "build-2")).toThrow(
      expect.objectContaining({ code: "answer_not_owed" }),
    );
  });

  test("is refused on a finding of another order or none", () => {
    const f = floor();
    expect(() => answer(f, 999, "fixed")).toThrow(expect.objectContaining({ code: "finding_unknown" }));
  });

  test("leaves a refusal without a resolution to the table's check", () => {
    const f = floor();
    const finding = raised(f);
    expect(() =>
      answerOrderFindings(
        f.db,
        "order-1",
        "build-1",
        [{ finding, answer: "refused", resolution: " " }],
        f.builder,
      ),
    ).toThrow("CHECK constraint failed");
  });
});

describe("closing a round", () => {
  const next = (f: Floor) => describeState(orderState(f.db, "order-1"));

  test("returns to the builder when the round raised a finding", () => {
    const f = floor();
    raised(f);
    expect(next(f)).toBe("run at build");
  });

  test("waits on review approval when a round after the answers raised nothing", () => {
    const f = floor();
    answer(f, raised(f), "refused");
    const round = reviewIn(f.db, "order-1", f.operator);
    recordOrderReviewArtifact(f.db, "order-1", "## Outcome\n\nClean.", round.reviewer);
    closeOrderReview(f.db, round.review, "closed", round.reviewer);
    expect(next(f)).toBe("approve at review");
  });
});

describe("the finding tables", () => {
  test("hold a severity to critical, high or medium", () => {
    const f = floor();
    const finding = raised(f);
    f.db.run("UPDATE factory_order_finding SET severity = 'high' WHERE id = ?", [finding]);
    expect(() =>
      f.db.run("UPDATE factory_order_finding SET severity = 'low' WHERE id = ?", [finding]),
    ).toThrow("CHECK constraint failed");
  });

  test("hold one answer per finding, with a resolution on a refusal", () => {
    const f = floor();
    const finding = raised(f);
    const insert = (run: string, given: string, resolution: string | null) =>
      f.db.run(
        `INSERT INTO factory_order_finding_answer (finding_id, run_id, answer, resolution, recorded_at)
         VALUES (?, ?, ?, ?, '2026-09-26T10:00:00.000Z')`,
        [finding, run, given, resolution],
      );
    expect(() => insert("build-1", "refused", " ")).toThrow("CHECK constraint failed");
    expect(() => insert("build-1", "waived", null)).toThrow("CHECK constraint failed");
    insert("build-1", "fixed", null);
    expect(() => insert("build-2", "refused", "out of scope")).toThrow("UNIQUE constraint failed");
  });

  test("keep answers through rebuild", () => {
    const home = mkdtempSync(join(tmpdir(), "dim-answer-"));
    const environment = { HOME: home, DIM_HOME: home };
    const f = floor(openDb(dbPath(environment)), false);
    const finding = raised(f);
    answer(f, finding, "refused");
    closeDb(f.db);
    const rebuilt = openDb(dbPath(environment), { forRebuild: true });
    rebuild(rebuilt, environment);
    expect(findingStanding(rebuilt, finding)).toMatchObject({ answer: "refused" });
    closeDb(rebuilt);
    rmSync(home, { recursive: true, force: true });
  });
});
