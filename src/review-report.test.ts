import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { claimOrder, queueOrder } from "./factory-order-lifecycle";
import { closeOrderReview } from "./factory-order-review";
import { integratedRepo, reviewIn, reviewOutput, workerIn } from "./fixtures.test-support";
import { answerOrderFindings, raiseOrderFinding, ruleOnOrderFinding } from "./order-finding";
import { parseReviewReport } from "./review-artifact";
import { renderReviewReport } from "./review-report";
import { SCHEMA_SQL } from "./schema";

const trunk = integratedRepo();
afterAll(() => rmSync(trunk.dir, { recursive: true, force: true }));

function contested(): { db: Database; review: number; finding: number } {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  const builder = workerIn(db);
  const operator = workerIn(db, "operator");
  queueOrder(db, { id: "order-1", project: "cniska/dim-factory", title: "Render" }, operator);
  claimOrder(
    db,
    "order-1",
    { runId: "run-1", station: "review", operatorWorker: operator },
    operator,
    undefined,
    trunk.dir,
  );
  const first = reviewIn(db, "order-1", operator);
  const finding = raiseOrderFinding(
    db,
    "order-1",
    {
      dimension: "tests",
      file: "src/gate.ts",
      line: 4,
      failure: "no test holds the gate",
      fix: "add a test that fails without it",
      severity: "medium",
    },
    first.reviewer,
  );
  closeOrderReview(db, first.review, "closed", first.reviewer);
  answerOrderFindings(
    db,
    "order-1",
    "build-1",
    [{ finding, answer: "refused", resolution: "the gate is a later slice" }],
    builder,
  );
  const second = reviewIn(db, "order-1", operator);
  ruleOnOrderFinding(
    db,
    finding,
    { ruling: "refusal_contested", reason: "the gate is this slice" },
    second.reviewer,
  );
  return { db, review: second.review, finding };
}

describe("the rendered Review artifact", () => {
  test("puts the sections in the order the owner decides in", () => {
    const { db, review } = contested();
    const body = renderReviewReport(db, review, parseReviewReport(reviewOutput()));
    const headings = [...body.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual([
      "Verdict",
      "Blocking findings",
      "Owner rulings",
      "Earlier findings",
      "Plan conformance",
      "Coverage",
      "What was not judged",
      "Observations",
    ]);
  });

  test("holds for an owner ruling and shows both positions on a contested refusal", () => {
    const { db, review, finding } = contested();
    const body = renderReviewReport(db, review, parseReviewReport(reviewOutput()));
    expect(body).toStartWith(
      "## Verdict\n\n**Held for an owner ruling.** The change does what the plan asked.",
    );
    expect(body).toContain(
      [
        `- Finding ${finding}, \`src/gate.ts:4\`: no test holds the gate`,
        "  - Builder's refusal: the gate is a later slice",
        "  - Reviewer's reason: the gate is this slice",
      ].join("\n"),
    );
    expect(body).toContain(
      `- Finding ${finding}, \`src/gate.ts:4\`: no test holds the gate **refusal_contested**: the gate is this slice`,
    );
  });

  test("keeps showing a contested refusal in a later round that does not rule on it", () => {
    const { db, review, finding } = contested();
    const reviewer = db
      .query<{ reviewer: string }, [number]>("SELECT reviewer FROM factory_order_review WHERE id = ?")
      .get(review)?.reviewer as string;
    closeOrderReview(db, review, "closed", reviewer);
    const operator = db
      .query<{ name: string }, []>("SELECT name FROM factory_worker WHERE role = 'operator'")
      .get()?.name as string;
    const third = reviewIn(db, "order-1", operator);
    const body = renderReviewReport(db, third.review, parseReviewReport(reviewOutput()));
    expect(body).toStartWith("## Verdict\n\n**Held for an owner ruling.**");
    expect(body).toContain(`## Owner rulings\n\n- Finding ${finding}, \`src/gate.ts:4\``);
    expect(body).toContain("## Earlier findings\n\nNone.");
  });

  test("renders the reviewer's conformance, coverage and what it did not judge", () => {
    const { db, review } = contested();
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
    const { db, review } = contested();
    const body = renderReviewReport(db, review, parseReviewReport(reviewOutput()));
    expect(body).toContain("## Blocking findings\n\nNone.");
    expect(body).toContain("## Observations\n\nNone.");
  });
});
