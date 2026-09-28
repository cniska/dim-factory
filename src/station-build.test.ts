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
import { builderBrief, reviewFindingsForBuild } from "./station-build";
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
    const round = reviewIn(db, "order-1");
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
    closeOrderReview(db, round.review, "closed");
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
      { id: "order-1", title: "Brief", description: null, line: "feat" },
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
    expect(text).toContain(`## Review findings\n- Finding ${open} `);
    expect(text).not.toContain(`Finding ${refused} `);
  });

  test("hands over no work once the builder answered every finding", () => {
    const { db } = reviewed(["fixed"]);
    expect(reviewFindingsForBuild(db, "order-1")).toEqual({ work: [] });
  });

  test("hands over no work while the latest round is still open", () => {
    const { db } = reviewed([null]);
    reviewIn(db, "order-1");
    expect(reviewFindingsForBuild(db, "order-1")).toEqual({ work: [] });
  });
});

describe("the build turn", () => {
  const turn = (fields: Record<string, unknown>) =>
    parseBuildTurn(JSON.stringify({ subject: "fix: it", artifact: "", answers: [], tests: [], ...fields }));

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

  test("requires a tests list of non-empty paths", () => {
    expect(() => parseBuildTurn(JSON.stringify({ subject: "fix: it", artifact: "", answers: [] }))).toThrow(
      "builder output must contain a tests list",
    );
    expect(() => turn({ tests: ["src/a.test.ts", 3] })).toThrow("test 2 must be a non-empty path");
    expect(() => turn({ tests: [""] })).toThrow("test 1 must be a non-empty path");
    expect(turn({ tests: ["src/a b.test.ts"] }).tests).toEqual(["src/a b.test.ts"]);
  });

  test("is held by the output schema to a tests list of non-empty paths", () => {
    expect(schema.required).toContain("tests");
    expect(schema.properties.tests).toEqual({ type: "array", items: { type: "string", minLength: 1 } });
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

describe("the builder's brief", () => {
  const plan = {
    body: "## Outcome\n\nBuild it.",
    slices: [
      { title: "First cut", outcome: "The cut is verified." },
      { title: "Second cut", outcome: "The rest is verified." },
    ],
  };
  const order = { id: "order-1", title: "Build it", description: null, line: "feat" } as const;
  const current = { id: 1, ordinal: 1, title: "First cut", outcome: "The cut is verified." };

  test("carries only the order, the workspace, the plan and the slice, and names dim-build", () => {
    expect(builderBrief(order, plan, current, null)).toBe(
      [
        "You are the builder for factory order order-1 in this repository. Run dim-build.",
        "",
        "# Build it",
        "",
        "This order's line is feat.",
        "",
        "## Workspace",
        "The workspace profile could not be read.",
        "",
        "## Approved plan",
        "## Outcome\n\nBuild it.",
        "",
        "## Slices",
        "1. First cut: The cut is verified.",
        "2. Second cut: The rest is verified.",
        "",
        "## Current slice",
        "1. First cut: The cut is verified.",
      ].join("\n"),
    );
  });

  test("hands a returned Build artifact and the owner's feedback to the builder", () => {
    const brief = builderBrief(order, plan, null, null, {
      body: "## Outcome\n\nThe artifact was a wall of text.",
      feedback: "Make it readable.",
    });

    expect(brief).toContain("## Returned Build artifact\n## Outcome\n\nThe artifact was a wall of text.");
    expect(brief).toContain("## Owner feedback\nMake it readable.");
  });

  test("carries a rebase conflict's paths and a red check's output as the turn's state", () => {
    const resolving = builderBrief(order, plan, null, null, undefined, undefined, undefined, undefined, [
      "src/a.ts",
    ]);
    expect(resolving).toContain("## Rebase conflict\n- src/a.ts");
    expect(resolving).not.toContain("This order's line is");

    const red = builderBrief(order, plan, null, null, undefined, undefined, undefined, undefined, null, {
      command: "bun run verify",
      exitCode: 1,
      result: "1 fail",
    });
    expect(red).toContain("## Red check\n`bun run verify` exited 1:\n```\n1 fail\n```");
  });

  test("tells the builder the order's line, except while it resolves a rebase", () => {
    const plan = {
      body: "## Outcome\n\nFix it.",
      slices: [{ title: "Fix it", outcome: "The crash is gone." }],
    };
    const order = { id: "order-1", title: "Fix it", description: null, line: "fix" } as const;

    expect(builderBrief(order, plan, null, null)).toContain("This order's line is fix.");
    expect(
      builderBrief(order, plan, null, null, undefined, undefined, undefined, undefined, ["src/a.ts"]),
    ).not.toContain("This order's line is");
  });

  test("includes the prior failed attempt when the builder resumes", () => {
    const brief = builderBrief(
      { id: "order-1", title: "Build it", description: null, line: "feat" },
      {
        body: "## Outcome\n\nBuild it.",
        slices: [{ title: "Build it", outcome: "The result is verified." }],
      },
      { id: 1, ordinal: 1, title: "Build it", outcome: "The result is verified." },
      null,
      undefined,
      "bun run verify exited 1 in the check sandbox.",
    );

    expect(brief).toContain(
      "## Previous failed Build attempt\nbun run verify exited 1 in the check sandbox.",
    );
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
