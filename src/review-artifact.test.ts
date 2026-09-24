import { describe, expect, test } from "bun:test";
import { parseReviewArtifact } from "./review-artifact";

describe("review artifacts", () => {
  test("parses a readable artifact and attributed findings", () => {
    expect(
      parseReviewArtifact(
        '{"body":"## Outcome\\n\\nThe guard is reversed.","findings":[{"dimension":"correctness","summary":"The branch allows invalid input."}]}',
      ),
    ).toEqual({
      body: "## Outcome\n\nThe guard is reversed.",
      findings: [{ dimension: "correctness", summary: "The branch allows invalid input." }],
    });
  });

  test.each([
    ["invalid JSON", "not json", "reviewer output must be valid JSON"],
    ["an absent body", '{"findings":[]}', "reviewer output must contain a non-empty body"],
    ["absent findings", '{"body":"Review"}', "reviewer output must contain a findings array"],
    [
      "an empty dimension",
      '{"body":"Review","findings":[{"dimension":" ","summary":"Issue"}]}',
      "reviewer finding 1 must contain a non-empty dimension",
    ],
    [
      "an empty summary",
      '{"body":"Review","findings":[{"dimension":"tests","summary":" "}]}',
      "reviewer finding 1 must contain a non-empty summary",
    ],
  ])("refuses %s", (_name, raw, message) => {
    expect(() => parseReviewArtifact(raw)).toThrow(message);
  });
});
