import { describe, expect, test } from "bun:test";
import { workerFailureReason } from "./harness-command";

describe("worker failure explanations", () => {
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
