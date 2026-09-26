import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { SCHEMA_SQL } from "./db-schema";
import { integratedRepo, reviewIn, workerIn } from "./fixtures.test-support";
import { workerFailureReason } from "./harness-launch";
import {
  answerOrderFindings,
  raiseOrderFinding,
  recordOwnerRuling,
  ruleOnOrderFinding,
} from "./order-finding";
import { claimOrder, queueOrder } from "./order-lifecycle";
import { closeOrderReview } from "./order-review";
import { builderBrief, rebaseConflictBrief, reviewFindingsForBuild } from "./station-build";
import { parseBuildTurn } from "./station-build-turn";
import schema from "./station-build-turn.schema.json";

const trunk = integratedRepo();
afterAll(() => rmSync(trunk.dir, { recursive: true, force: true }));

describe("the review findings a builder is handed", () => {
  function reviewed(answers: ("fixed" | "refused" | null)[]) {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const builder = workerIn(db);
    const operator = workerIn(db, "operator");
    queueOrder(db, { id: "order-1", project: "cniska/dim-factory", title: "Brief" }, operator);
    claimOrder(
      db,
      "order-1",
      { runId: "run-1", station: "review", operatorWorker: operator },
      operator,
      undefined,
      trunk.dir,
    );
    const round = reviewIn(db, "order-1", operator);
    const findings = answers.map((answer, index) => {
      const id = raiseOrderFinding(
        db,
        "order-1",
        {
          dimension: "tests",
          file: "src/gate.ts",
          line: index + 1,
          failure: `gap ${index}`,
          fix: `close gap ${index}`,
          severity: "high",
        },
        round.reviewer,
      );
      return { id, answer };
    });
    closeOrderReview(db, round.review, "closed", round.reviewer);
    answerOrderFindings(
      db,
      "order-1",
      "build-1",
      findings.flatMap(({ id, answer }) =>
        answer === null
          ? []
          : [{ finding: id, answer, resolution: answer === "refused" ? "out of scope" : null }],
      ),
      builder,
    );
    return { db, builder, operator, findings: findings.map((finding) => finding.id) };
  }

  const brief = (db: Database) =>
    builderBrief(
      { id: "order-1", title: "Brief", description: null },
      { body: "## Outcome\n\nBrief.", slices: [] },
      null,
      null,
      undefined,
      undefined,
      reviewFindingsForBuild(db, "order-1"),
    );

  test("hands over an unanswered finding as work by id and a standing refusal apart from it", () => {
    const { db, findings } = reviewed([null, "refused"]);
    const [open, refused] = findings as [number, number];
    expect(reviewFindingsForBuild(db, "order-1")).toEqual({
      work: [{ finding: open, brief: `Finding ${open} (tests, src/gate.ts:1): gap 0\n  Fix: close gap 0` }],
      refused: [`Finding ${refused} (tests, src/gate.ts:2): gap 1\n  Your refusal: out of scope`],
    });
    const text = brief(db);
    const work = text.split("# Refused findings")[0] ?? "";
    expect(work).toContain(`# Review findings\n- Finding ${open} `);
    expect(work).toContain("Answer every finding listed here in the turn's `answers`, by its id");
    expect(work).not.toContain(`Finding ${refused} `);
    expect(text).toContain(
      "# Refused findings\nThese are refusals you gave that still stand. They are not work: change nothing for them and leave them out of `answers`. The reviewer rules on each one next round.",
    );
  });

  test("hands over no work once the builder answered every finding", () => {
    const { db } = reviewed(["fixed"]);
    expect(reviewFindingsForBuild(db, "order-1")).toEqual({ work: [], refused: [] });
  });

  test("hands over no work while the latest round is still open", () => {
    const { db, operator } = reviewed([null]);
    reviewIn(db, "order-1", operator);
    expect(reviewFindingsForBuild(db, "order-1")).toEqual({ work: [], refused: [] });
  });

  test("hands over a fix the next round found not addressed as work again, with the reviewer's reason", () => {
    const { db, operator, findings } = reviewed(["fixed"]);
    const second = reviewIn(db, "order-1", operator);
    ruleOnOrderFinding(
      db,
      findings[0] as number,
      { ruling: "not_addressed", reason: "still no test" },
      second.reviewer,
    );
    closeOrderReview(db, second.review, "closed", second.reviewer);
    expect(reviewFindingsForBuild(db, "order-1").work).toEqual([
      {
        finding: findings[0] as number,
        brief: `Finding ${findings[0]} (tests, src/gate.ts:1): gap 0\n  Fix: close gap 0\n  The reviewer found it not addressed: still no test`,
      },
    ]);
  });

  function contested() {
    const reviewedOrder = reviewed(["refused"]);
    const { db, operator, findings } = reviewedOrder;
    const second = reviewIn(db, "order-1", operator);
    ruleOnOrderFinding(
      db,
      findings[0] as number,
      { ruling: "refusal_contested", reason: "in scope" },
      second.reviewer,
    );
    closeOrderReview(db, second.review, "closed", second.reviewer);
    return reviewedOrder;
  }

  test("hands over a contested refusal only once the owner overturns it", () => {
    const { db, operator, findings } = contested();
    expect(reviewFindingsForBuild(db, "order-1")).toEqual({ work: [], refused: [] });
    recordOwnerRuling(
      db,
      findings[0] as number,
      { ruling: "refusal_overturned", reason: "fix it" },
      operator,
    );
    expect(reviewFindingsForBuild(db, "order-1").work).toEqual([
      {
        finding: findings[0] as number,
        brief: [
          `Finding ${findings[0]} (tests, src/gate.ts:1): gap 0`,
          "  Fix: close gap 0",
          "  The owner overturned your refusal, so answer it fixed: fix it",
        ].join("\n"),
      },
    ]);
  });

  test("gives an overturned refusal a later round found not addressed both reasons", () => {
    const { db, builder, operator, findings } = contested();
    const finding = findings[0] as number;
    recordOwnerRuling(db, finding, { ruling: "refusal_overturned", reason: "fix it" }, operator);
    answerOrderFindings(db, "order-1", "build-2", [{ finding, answer: "fixed", resolution: null }], builder);
    const third = reviewIn(db, "order-1", operator);
    ruleOnOrderFinding(db, finding, { ruling: "not_addressed", reason: "still open" }, third.reviewer);
    closeOrderReview(db, third.review, "closed", third.reviewer);
    expect(reviewFindingsForBuild(db, "order-1").work.map((one) => one.brief)).toEqual([
      [
        `Finding ${finding} (tests, src/gate.ts:1): gap 0`,
        "  Fix: close gap 0",
        "  The owner overturned your refusal, so answer it fixed: fix it",
        "  The reviewer found it not addressed: still open",
      ].join("\n"),
    ]);
  });

  test("leaves out a finding a later round settled", () => {
    const { db, operator, findings } = reviewed(["fixed"]);
    const second = reviewIn(db, "order-1", operator);
    ruleOnOrderFinding(db, findings[0] as number, { ruling: "addressed" }, second.reviewer);
    closeOrderReview(db, second.review, "closed", second.reviewer);
    expect(reviewFindingsForBuild(db, "order-1")).toEqual({ work: [], refused: [] });
  });
});

describe("the build turn", () => {
  const turn = (fields: Record<string, unknown>) =>
    parseBuildTurn(JSON.stringify({ subject: "fix: it", artifact: "", answers: [], ...fields }));

  test("carries each answer with its finding, trimming a resolution and leaving an absent one null", () => {
    expect(
      turn({
        answers: [
          { finding: 3, answer: "fixed", resolution: null },
          { finding: 4, answer: "refused", resolution: " out of scope " },
        ],
      }).answers,
    ).toEqual([
      { finding: 3, answer: "fixed", resolution: null },
      { finding: 4, answer: "refused", resolution: "out of scope" },
    ]);
  });

  test("requires an answers list", () => {
    expect(() => parseBuildTurn(JSON.stringify({ subject: "fix: it", artifact: "" }))).toThrow(
      "builder output must contain an answers list",
    );
  });

  test("refuses a refusal without a resolution and an answer outside fixed and refused", () => {
    expect(() => turn({ answers: [{ finding: 3, answer: "refused", resolution: " " }] })).toThrow(
      "refuses finding 3 without saying why",
    );
    expect(() => turn({ answers: [{ finding: 3, answer: "waived", resolution: null }] })).toThrow(
      "must be fixed or refused",
    );
  });
});

describe("the rebase conflict brief", () => {
  test("asks for the output the build turn's schema accepts", () => {
    const ending = rebaseConflictBrief(["f.txt"]).find((line) => line.startsWith("End the turn")) ?? "";
    const asked = JSON.parse(/`(\{.*?\})`/.exec(ending)?.[1] ?? "null") as Record<string, unknown>;

    expect(Object.keys(asked).sort()).toEqual([...schema.required].sort());
    expect(String(asked.subject).length).toBeGreaterThanOrEqual(schema.properties.subject.minLength);
    expect(asked.subject).toMatch(new RegExp(schema.properties.subject.pattern));
    expect(typeof asked.artifact).toBe("string");
    expect(asked.answers).toEqual([]);
  });
});

describe("worker failure explanations", () => {
  test("gives a returned Build artifact readable sections", () => {
    const brief = builderBrief(
      { id: "order-1", title: "Build it", description: null },
      {
        body: "## Outcome\n\nBuild it.",
        slices: [{ title: "Build it", outcome: "The result is verified." }],
      },
      null,
      null,
      { body: "## Outcome\n\nThe artifact was a wall of text.", feedback: "Make it readable." },
    );

    expect(brief).toContain(
      "separate Markdown headings: Outcome, Implementation, Why this shape, Verification, and Owner attention",
    );
  });

  test("tells the builder to fix a red check before finishing", () => {
    expect(
      builderBrief(
        { id: "order-1", title: "Build it", description: null },
        {
          body: "## Outcome\n\nBuild it.",
          slices: [{ title: "Build it", outcome: "The result is verified." }],
        },
        { id: 1, ordinal: 1, title: "Build it", outcome: "The result is verified." },
        null,
      ),
    ).toContain("A red check is feedback, not completion");
    expect(
      builderBrief(
        { id: "order-1", title: "Build it", description: null },
        {
          body: "## Outcome\n\nBuild it.",
          slices: [{ title: "Build it", outcome: "The result is verified." }],
        },
        { id: 1, ordinal: 1, title: "Build it", outcome: "The result is verified." },
        null,
      ),
    ).toContain("Do not run dim order stop");
    expect(
      builderBrief(
        { id: "order-1", title: "Build it", description: "The wall is out of scope." },
        {
          body: "## Outcome\n\nBuild it.",
          slices: [{ title: "Build it", outcome: "The result is verified." }],
        },
        { id: 1, ordinal: 1, title: "Build it", outcome: "The result is verified." },
        null,
      ),
    ).toContain("explicitly exclude a workspace surface");
    expect(
      builderBrief(
        { id: "order-1", title: "Build it", description: null },
        {
          body: "## Outcome\n\nBuild it.",
          slices: [{ title: "First cut", outcome: "The cut is verified." }],
        },
        { id: 1, ordinal: 1, title: "First cut", outcome: "The cut is verified." },
        null,
      ),
    ).toContain("1. First cut: The cut is verified.");
    const brief = builderBrief(
      { id: "order-1", title: "Build it", description: null },
      {
        body: "## Outcome\n\nBuild it.",
        slices: [{ title: "Build it", outcome: "The result is verified." }],
      },
      { id: 1, ordinal: 1, title: "Build it", outcome: "The result is verified." },
      null,
    );
    expect(brief).toContain("Do not register or bootstrap another worker");
    expect(brief).toContain("Leave every change uncommitted in the worktree");
    expect(brief).toContain("Do not run git commit, git stash");
    expect(brief).toContain("commits the worktree with the repository's own git identity and signing config");
    expect(brief).toContain("Stay on the order's branch");
    expect(brief).toContain('returning JSON `{"subject": "...", "artifact": "...", "answers": [...]}`');
    expect(brief).toContain("review findings are answered in the turn's `answers`, never through dim order");
    expect(brief).toContain("the Build artifact for the whole order when this turn finishes the final slice");
    expect(brief).toContain("rather than the command transcript");
    expect(brief).not.toContain("dim order commit");
    expect(brief).not.toContain("dim order check");
    expect(brief).not.toContain("dim order build-artifact");
  });

  test("includes the prior failed attempt when the builder resumes", () => {
    const brief = builderBrief(
      { id: "order-1", title: "Build it", description: null },
      {
        body: "## Outcome\n\nBuild it.",
        slices: [{ title: "Build it", outcome: "The result is verified." }],
      },
      { id: 1, ordinal: 1, title: "Build it", outcome: "The result is verified." },
      null,
      undefined,
      "bun run verify exited 1 in the check sandbox.",
    );

    expect(brief).toContain("# Previous failed Build attempt");
    expect(brief).toContain("bun run verify exited 1");
    expect(brief).toContain("Continue from this feedback and leave the worktree passing the declared check");
  });

  test("keeps the harness explanation beside the failure", () => {
    expect(
      workerFailureReason(
        "worker did not finish",
        "I stopped before committing because the check failed.",
        "Codex turn failed",
      ),
    ).toBe(
      "worker did not finish: Codex turn failed; its last message: I stopped before committing because the check failed.",
    );
  });

  test("does not add empty explanations", () => {
    expect(workerFailureReason("worker did not finish", "  ", undefined)).toBe("worker did not finish");
  });
});
