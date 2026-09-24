import { describe, expect, test } from "bun:test";
import { workerFailureReason } from "./harness-command";
import { builderBrief } from "./order-build";

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
    expect(brief).toContain("dim order commit order-1 --sha <latest-commit-sha>");
    expect(brief).toContain("dim order check order-1 --command");
    expect(brief).toContain("dim order build-artifact order-1 --body");
    expect(brief).toContain("After the final slice, record one Build artifact for the whole order");
    expect(brief).toContain("not the command transcript");
  });

  test("keeps the harness explanation beside the failure", () => {
    expect(
      workerFailureReason(
        "worker did not finish",
        "I stopped before committing because the check failed.",
        "Codex turn failed",
      ),
    ).toBe("worker did not finish: Codex turn failed; I stopped before committing because the check failed.");
  });

  test("does not add empty explanations", () => {
    expect(workerFailureReason("worker did not finish", "  ", undefined)).toBe("worker did not finish");
  });
});
