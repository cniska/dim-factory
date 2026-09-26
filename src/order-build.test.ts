import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import schema from "./build-turn.schema.json";
import {
  answerOrderFinding,
  appendOrderEvent,
  claimOrder,
  closeOrderReview,
  decideOrderRefusal,
  queueOrder,
  raiseOrderFinding,
  ruleOnOrderFinding,
} from "./factory-order";
import { integratedRepo, reviewIn, workerIn } from "./fixtures.test-support";
import { workerFailureReason } from "./harness-command";
import { builderBrief, rebaseConflictBrief, reviewFindingsForBuild } from "./order-build";
import { SCHEMA_SQL } from "./schema";

const trunk = integratedRepo();
afterAll(() => rmSync(trunk.dir, { recursive: true, force: true }));

describe("the review findings a builder is handed", () => {
  /** An order whose closed first round raised one finding per answer, each answered as given. */
  function reviewed(answers: ("fixed" | "refused")[]) {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const builder = workerIn(db);
    const operator = workerIn(db, "operator");
    queueOrder(db, { id: "order-1", project: "cniska/dim-factory", title: "Brief" }, operator);
    claimOrder(
      db,
      "order-1",
      { runId: "run-1", station: "dim-station-review", operatorWorker: operator },
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
          summary: `gap ${index}`,
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
    for (const { id, answer } of findings) {
      answerOrderFinding(
        db,
        id,
        answer === "fixed" ? { answer } : { answer, resolution: "out of scope" },
        builder,
      );
    }
    return { db, operator, findings: findings.map((finding) => finding.id) };
  }

  test("lists a fixed finding as work and a standing refusal apart from it", () => {
    const { db, findings } = reviewed(["fixed", "refused"]);
    const [fixed, refused] = findings;
    expect(reviewFindingsForBuild(db, "order-1")).toEqual({
      work: [`Finding ${fixed} (tests, src/gate.ts:1): gap 0\n  Fix: close gap 0`],
      refused: [`Finding ${refused} (tests, src/gate.ts:2): gap 1\n  Your refusal: out of scope`],
    });
    const brief = builderBrief(
      { id: "order-1", title: "Brief", description: null },
      { body: "## Outcome\n\nBrief.", slices: [] },
      null,
      null,
      undefined,
      undefined,
      reviewFindingsForBuild(db, "order-1"),
    );
    const work = brief.split("# Refused findings")[0] ?? "";
    expect(work).toContain(`- Finding ${fixed} `);
    expect(work).not.toContain(`Finding ${refused} `);
    expect(brief).toContain(
      "# Refused findings\nThese are refusals you gave that still stand. They are not work: change nothing for them. The reviewer rules on each one next round.",
    );
  });

  test("keeps a round whose every finding was refused as a turn that answers the review", () => {
    const { db } = reviewed(["refused"]);
    const brief = builderBrief(
      { id: "order-1", title: "Brief", description: null },
      { body: "## Outcome\n\nBrief.", slices: [] },
      null,
      null,
      undefined,
      undefined,
      reviewFindingsForBuild(db, "order-1"),
    );
    expect(brief).not.toContain("# Review findings");
    expect(brief).toContain("# Refused findings");
    expect(brief).toContain("run the build station loop");
  });

  test("lists a fix the next round found not addressed as work with the reviewer's reason", () => {
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
      `Finding ${findings[0]} (tests, src/gate.ts:1): gap 0\n  Fix: close gap 0\n  The reviewer found it not addressed: still no test`,
    ]);
  });

  /** Round two contests the refusal and the owner overturns it. */
  function overturned() {
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
    decideOrderRefusal(
      db,
      findings[0] as number,
      { decision: "refusal_overturned", reason: "fix it" },
      operator,
    );
    return reviewedOrder;
  }

  test("gives an overturned refusal a later round found not addressed both reasons", () => {
    const { db, operator, findings } = overturned();
    const third = reviewIn(db, "order-1", operator);
    ruleOnOrderFinding(
      db,
      findings[0] as number,
      { ruling: "not_addressed", reason: "still open" },
      third.reviewer,
    );
    closeOrderReview(db, third.review, "closed", third.reviewer);
    expect(reviewFindingsForBuild(db, "order-1").work).toEqual([
      [
        `Finding ${findings[0]} (tests, src/gate.ts:1): gap 0`,
        "  Fix: close gap 0",
        "  The owner overturned your refusal: fix it",
        "  The reviewer found it not addressed: still open",
      ].join("\n"),
    ]);
  });

  test("hands over a refusal the owner overturned after the builder's last Build artifact", () => {
    const { db, operator, findings } = reviewed(["refused"]);
    const second = reviewIn(db, "order-1", operator);
    ruleOnOrderFinding(
      db,
      findings[0] as number,
      { ruling: "refusal_contested", reason: "in scope" },
      second.reviewer,
    );
    closeOrderReview(db, second.review, "closed", second.reviewer);
    appendOrderEvent(db, "order-1", { kind: "build_artifact_written", worker: operator });
    expect(reviewFindingsForBuild(db, "order-1")).toEqual({ work: [], refused: [] });
    decideOrderRefusal(
      db,
      findings[0] as number,
      { decision: "refusal_overturned", reason: "fix it" },
      operator,
    );
    expect(reviewFindingsForBuild(db, "order-1").work).toHaveLength(1);
  });

  test("hands over nothing once a Build artifact followed the review", () => {
    const { db, operator } = reviewed(["fixed"]);
    expect(reviewFindingsForBuild(db, "order-1").work).toHaveLength(1);
    appendOrderEvent(db, "order-1", { kind: "build_artifact_written", worker: operator });
    expect(reviewFindingsForBuild(db, "order-1")).toEqual({ work: [], refused: [] });
  });

  test("leaves out a finding a later round settled", () => {
    const { db, operator, findings } = reviewed(["fixed"]);
    const second = reviewIn(db, "order-1", operator);
    ruleOnOrderFinding(db, findings[0] as number, { ruling: "addressed" }, second.reviewer);
    closeOrderReview(db, second.review, "closed", second.reviewer);
    expect(reviewFindingsForBuild(db, "order-1")).toEqual({ work: [], refused: [] });
  });
});

describe("the rebase conflict brief", () => {
  test("asks for the output the build turn's schema accepts", () => {
    const ending = rebaseConflictBrief(["f.txt"]).find((line) => line.startsWith("End the turn")) ?? "";
    const asked = JSON.parse(/`(\{.*?\})`/.exec(ending)?.[1] ?? "null") as Record<string, string>;

    expect(Object.keys(asked).sort()).toEqual([...schema.required].sort());
    expect(asked.subject?.length).toBeGreaterThanOrEqual(schema.properties.subject.minLength);
    expect(asked.subject).toMatch(new RegExp(schema.properties.subject.pattern));
    expect(typeof asked.artifact).toBe("string");
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
    expect(brief).toContain('returning JSON `{"subject": "...", "artifact": "..."}`');
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
