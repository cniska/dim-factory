import { describe, expect, test } from "bun:test";
import { buildFailureReason } from "./order-build";

describe("builder failure explanations", () => {
  test("keeps the harness explanation beside the failure", () => {
    expect(
      buildFailureReason(
        "builder did not record a commit",
        "I stopped before committing because the check failed.",
      ),
    ).toBe("builder did not record a commit: I stopped before committing because the check failed.");
  });

  test("does not add an empty explanation", () => {
    expect(buildFailureReason("builder did not record a commit", "  ")).toBe(
      "builder did not record a commit",
    );
  });
});
