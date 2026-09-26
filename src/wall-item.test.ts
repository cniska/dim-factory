import { describe, expect, test } from "bun:test";
import { findingKey, ITEM_KIND_LABELS, itemKindLabel, shortSha } from "./wall-item";

describe("factory wall item view", () => {
  test("calls a record's kinds what a person calls them, not what the column holds", () => {
    expect(ITEM_KIND_LABELS.commit_created).toBe("Commit");
    expect(ITEM_KIND_LABELS.finding_raised).toBe("Finding raised");
    expect(ITEM_KIND_LABELS.finding_answered).toBe("Finding answered");
    expect(ITEM_KIND_LABELS.environment_reported).toBe("Worker environment");
    expect(ITEM_KIND_LABELS.moved).toBe("Moved");
    expect(Object.values(ITEM_KIND_LABELS).every((label) => !label.includes("_"))).toBe(true);
  });

  test("names an artifact event by the station whose artifact it is", () => {
    expect(itemKindLabel({ kind: "artifact_written", station: "plan" })).toBe("Plan written");
    expect(itemKindLabel({ kind: "artifact_approved", station: "build" })).toBe("Build approved");
    expect(itemKindLabel({ kind: "artifact_returned", station: "review" })).toBe("Review returned");
    expect(itemKindLabel({ kind: "commit_created", station: "build" })).toBe("Commit");
  });

  test("shortens a sha to what a person compares", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
  });

  test("identifies repeated finding text without merging the audit events", () => {
    const first = { finding: { dimension: "tests", answer: "raised", failure: "missing check" } };
    const answer = { finding: { dimension: "tests", answer: "fixed", failure: "missing check" } };
    const other = { finding: { dimension: "tests", answer: "raised", failure: "different" } };

    expect(findingKey(first)).toBe(findingKey(answer));
    expect(findingKey(first)).not.toBe(findingKey(other));
    expect(findingKey({})).toBeNull();
  });
});
