import { describe, expect, test } from "bun:test";
import { ACTION_LABELS, DECIDED_LABELS, itemLabel } from "./item";

describe("factory wall item view", () => {
  test("calls each logged action what a person calls it, not what the log stores", () => {
    expect(ACTION_LABELS.order_added).toBe("Added");
    expect(ACTION_LABELS.slice_accepted).toBe("Slice accepted");
    expect(ACTION_LABELS.finding_answered).toBe("Finding answered");
    expect(ACTION_LABELS.ship_landed).toBe("Shipped");
    const labels = [...Object.values(ACTION_LABELS), ...Object.values(DECIDED_LABELS)];
    expect(labels.every((label) => !label.includes("_"))).toBe(true);
  });

  test("names a decision by the station whose artifact it decided", () => {
    expect(itemLabel({ action: "artifact_approved", station: "build" })).toBe("Build approved");
    expect(itemLabel({ action: "artifact_returned", station: "review" })).toBe("Review returned");
    expect(itemLabel({ action: "order_returned", station: "plan" })).toBe("Plan returned the order");
    expect(itemLabel({ action: "slice_accepted", station: "build" })).toBe("Slice accepted");
  });
});
