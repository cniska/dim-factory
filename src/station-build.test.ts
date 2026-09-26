import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { SCHEMA_SQL } from "./db-schema";
import { attemptIn, integratedRepo, reviewIn, workerIn } from "./fixtures.test-support";
import { workerFailureReason } from "./harness-launch";
import { recordOrderCommit } from "./order-evidence";
import { answerOrderFindings, raiseOrderFinding } from "./order-finding";
import { queueOrder, startOrder } from "./order-lifecycle";
import { closeOrderReview } from "./order-review";
import { approveFinalBuildAt, approvePlan } from "./station-approvals.test-support";
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
    startOrder(db, "order-1", operator, undefined, trunk.dir);
    approvePlan(db, "order-1", operator);
    attemptIn(db, "order-1", builder, operator);
    recordOrderCommit(db, "order-1", "head0001", builder, "feat: brief");
    approveFinalBuildAt(db, "order-1", "head0001", builder, operator);
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

  test("hands over each unanswered finding as work by id, and none the builder answered", () => {
    const { db, findings } = reviewed([null, "refused"]);
    const [open, refused] = findings as [number, number];
    expect(reviewFindingsForBuild(db, "order-1")).toEqual({
      work: [{ finding: open, brief: `Finding ${open} (tests, src/gate.ts:1): gap 0\n  Fix: close gap 0` }],
    });
    const text = brief(db);
    expect(text).toContain(`# Review findings\n- Finding ${open} `);
    expect(text).toContain("Answer every finding listed here in the turn's `answers`, by its id");
    expect(text).not.toContain(`Finding ${refused} `);
  });

  test("hands over no work once the builder answered every finding", () => {
    const { db } = reviewed(["fixed"]);
    expect(reviewFindingsForBuild(db, "order-1")).toEqual({ work: [] });
  });

  test("hands over no work while the latest round is still open", () => {
    const { db, operator } = reviewed([null]);
    reviewIn(db, "order-1", operator);
    expect(reviewFindingsForBuild(db, "order-1")).toEqual({ work: [] });
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
