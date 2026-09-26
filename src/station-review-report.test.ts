import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { SCHEMA_SQL } from "./db-schema";
import { integratedRepo, reviewIn, reviewOutput, workerIn } from "./fixtures.test-support";
import { answerOrderFindings, raiseOrderFinding } from "./order-finding";
import { queueOrder, startOrder } from "./order-lifecycle";
import { closeOrderReview } from "./order-review";
import { parseReviewReport } from "./station-review-artifact";
import { renderReviewReport } from "./station-review-report";

const trunk = integratedRepo();
afterAll(() => rmSync(trunk.dir, { recursive: true, force: true }));

const GATE = {
  dimension: "tests",
  file: "src/gate.ts",
  line: 4,
  failure: "no test holds the gate",
  fix: "add a test that fails without it",
  severity: "medium",
} as const;

function refused(): { db: Database; review: number; finding: number } {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  const builder = workerIn(db);
  const operator = workerIn(db, "operator");
  queueOrder(db, { id: "order-1", project: "cniska/dim-factory", title: "Render" }, operator);
  startOrder(db, "order-1", operator, undefined, trunk.dir);
  const first = reviewIn(db, "order-1", operator);
  const finding = raiseOrderFinding(db, "order-1", GATE, first.reviewer);
  closeOrderReview(db, first.review, "closed", first.reviewer);
  answerOrderFindings(
    db,
    "order-1",
    "build-1",
    [{ finding, answer: "refused", resolution: "the gate is a later slice" }],
    builder,
  );
  const second = reviewIn(db, "order-1", operator);
  return { db, review: second.review, finding };
}

describe("the rendered Review artifact", () => {
  test("puts the sections in the order the owner decides in", () => {
    const { db, review } = refused();
    const body = renderReviewReport(db, review, parseReviewReport(reviewOutput()));
    const headings = [...body.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual([
      "Verdict",
      "Blocking findings",
      "Earlier findings",
      "Plan conformance",
      "Coverage",
      "What was not judged",
      "Observations",
    ]);
  });

  test("may advance after a round that raised nothing, showing how earlier findings were answered", () => {
    const { db, review, finding } = refused();
    const body = renderReviewReport(db, review, parseReviewReport(reviewOutput()));
    expect(body).toStartWith("## Verdict\n\n**May advance.** The change does what the plan asked.");
    expect(body).toContain(
      `## Earlier findings\n\n- Finding ${finding}, \`src/gate.ts:4\`: no test holds the gate **refused**: the gate is a later slice`,
    );
  });

  test("returns to the builder when the round raised a finding", () => {
    const { db, review } = refused();
    const reviewer = db
      .query<{ reviewer: string }, [number]>("SELECT reviewer FROM factory_order_review WHERE id = ?")
      .get(review)?.reviewer as string;
    const raised = raiseOrderFinding(db, "order-1", GATE, reviewer);
    const body = renderReviewReport(db, review, parseReviewReport(reviewOutput({ findings: [GATE] })));
    expect(body).toStartWith("## Verdict\n\n**Returns to the builder.**");
    expect(body).toContain(
      `## Blocking findings\n\n- **medium** \`src/gate.ts:4\` (tests, finding ${raised}): no test holds the gate Fix: add a test that fails without it`,
    );
  });

  test("renders the reviewer's conformance, coverage and what it did not judge", () => {
    const { db, review } = refused();
    const body = renderReviewReport(
      db,
      review,
      parseReviewReport(
        reviewOutput({
          conformance: [{ kind: "extra", slice: "The gate", detail: "A wall control nobody asked for." }],
          set_aside: [{ item: "the wall", why: "The plan keeps it read-only." }],
          unverified: [{ claim: "Codex accepts the schema", would_settle: "a Codex review run" }],
          observations: ["The helper could be inlined."],
        }),
      ),
    );
    expect(body).toContain("## Plan conformance\n\n- **extra** (The gate): A wall control nobody asked for.");
    expect(body).toContain("| correctness | clean |  |");
    expect(body).toContain(
      [
        "## What was not judged",
        "",
        "- Set aside: the wall. The plan keeps it read-only.",
        "- Not verified: Codex accepts the schema. Would settle it: a Codex review run",
      ].join("\n"),
    );
    expect(body).toContain("## Observations\n\n- The helper could be inlined.");
  });

  test("says None under a section with nothing in it", () => {
    const { db, review } = refused();
    const body = renderReviewReport(db, review, parseReviewReport(reviewOutput()));
    expect(body).toContain("## Blocking findings\n\nNone.");
    expect(body).toContain("## Observations\n\nNone.");
  });
});
