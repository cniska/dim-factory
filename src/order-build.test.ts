import { describe, expect, test } from "bun:test";
import { workerFailureReason } from "./harness-command";
import { builderBrief } from "./order-build";

describe("worker failure explanations", () => {
  test("tells the builder to fix a red check before finishing", () => {
    expect(
      builderBrief({ id: "order-1", title: "Build it", description: null }, "## Outcome\n\nBuild it.", null),
    ).toContain("A red check is feedback, not completion");
    expect(
      builderBrief({ id: "order-1", title: "Build it", description: null }, "## Outcome\n\nBuild it.", null),
    ).toContain("Do not run dim order stop");
    expect(
      builderBrief(
        { id: "order-1", title: "Build it", description: "The wall is out of scope." },
        "## Outcome\n\nBuild it.",
        null,
      ),
    ).toContain("explicitly exclude a workspace surface");
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
