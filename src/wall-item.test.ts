import { describe, expect, test } from "bun:test";
import { ITEM_KIND_LABELS, shortSha } from "./wall-item";

describe("factory wall item view", () => {
  test("calls a record's kinds what a person calls them, not what the column holds", () => {
    expect(ITEM_KIND_LABELS.commit_created).toBe("Commit");
    expect(ITEM_KIND_LABELS.finding_raised).toBe("Finding raised");
    expect(ITEM_KIND_LABELS.finding_answered).toBe("Finding answered");
    expect(ITEM_KIND_LABELS.environment_reported).toBe("Worker environment");
    expect(ITEM_KIND_LABELS.moved).toBe("Moved");
    expect(Object.values(ITEM_KIND_LABELS).every((label) => !label.includes("_"))).toBe(true);
  });

  test("shortens a sha to what a person compares", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
  });
});
