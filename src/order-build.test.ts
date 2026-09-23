import { describe, expect, test } from "bun:test";
import { workerFailureReason } from "./harness-command";
import { builderBrief } from "./order-build";

describe("worker failure explanations", () => {
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
