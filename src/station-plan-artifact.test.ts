import { describe, expect, test } from "bun:test";
import { parsePlanArtifact } from "./station-plan-artifact";

describe("plan artifacts", () => {
  test("parses the owner's Markdown plan and ordered slices", () => {
    expect(
      parsePlanArtifact(
        JSON.stringify({
          body: "## Outcome\n\nBuild the requested result.",
          slices: [
            { title: "Persist the contract", outcome: "The schema and tests pass." },
            { title: "Run the workflow", outcome: "Two slices complete in order." },
          ],
        }),
      ),
    ).toEqual({
      body: "## Outcome\n\nBuild the requested result.",
      slices: [
        { title: "Persist the contract", outcome: "The schema and tests pass." },
        { title: "Run the workflow", outcome: "Two slices complete in order." },
      ],
    });
  });

  test("refuses a plan without an ordered slice list", () => {
    expect(() => parsePlanArtifact(JSON.stringify({ body: "## Outcome" }))).toThrow(
      "planner output must contain at least one slice",
    );
  });
});
