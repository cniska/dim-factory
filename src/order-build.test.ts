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
