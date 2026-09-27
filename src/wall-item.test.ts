import { describe, expect, test } from "bun:test";
import { ITEM_KIND_LABELS, itemKindLabel } from "./wall-item";

describe("factory wall item view", () => {
  test("calls a record's kinds what a person calls them, not what the column holds", () => {
    expect(ITEM_KIND_LABELS.commit_created).toBe("Commit");
    expect(ITEM_KIND_LABELS.finding_raised).toBe("Finding raised");
    expect(ITEM_KIND_LABELS.finding_answered).toBe("Finding answered");
    expect(ITEM_KIND_LABELS.started).toBe("Order started");
    expect(Object.values(ITEM_KIND_LABELS).every((label) => !label.includes("_"))).toBe(true);
  });

  test("names an artifact event by the station whose artifact it is", () => {
    expect(itemKindLabel({ kind: "station_started", station: "plan" })).toBe("Plan started");
    expect(itemKindLabel({ kind: "artifact_submitted", station: "plan" })).toBe("Plan submitted");
    expect(itemKindLabel({ kind: "artifact_approved", station: "build" })).toBe("Build approved");
    expect(itemKindLabel({ kind: "artifact_returned", station: "review" })).toBe("Review returned");
    expect(itemKindLabel({ kind: "commit_created", station: "build" })).toBe("Commit");
    expect(itemKindLabel({ kind: "failed", station: "build" })).toBe("Build failed");
    expect(itemKindLabel({ kind: "failed", station: null })).toBe("Failed");
  });
});
