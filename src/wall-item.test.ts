import { describe, expect, test } from "bun:test";
import type { WallItemEntry } from "./factory-wall";
import { ITEM_KIND_LABELS, RAIL_MARK_GLYPH, railStops, shortSha } from "./wall-item";

const entry = (partial: Partial<WallItemEntry> & Pick<WallItemEntry, "kind">): WallItemEntry => ({
  at: "2026-09-18T10:00:00.000Z",
  ...partial,
});

describe("factory wall item view", () => {
  test("marks every repetition rather than collapsing it", () => {
    const stops = railStops([
      entry({ kind: "check_finished", at: "2026-09-18T10:01:00.000Z" }),
      entry({ kind: "check_finished", at: "2026-09-18T10:02:00.000Z" }),
      entry({ kind: "finding_raised", at: "2026-09-18T10:03:00.000Z" }),
      entry({ kind: "finding_answered", at: "2026-09-18T10:04:00.000Z" }),
    ]);

    expect(stops.map((stop) => stop.mark)).toEqual(["moment", "moment", "moment", "moment"]);
    expect(stops.map((stop) => stop.at)).toEqual([
      "2026-09-18T10:01:00.000Z",
      "2026-09-18T10:02:00.000Z",
      "2026-09-18T10:03:00.000Z",
      "2026-09-18T10:04:00.000Z",
    ]);
  });

  test("reads a station move as a handover and an outcome as an end", () => {
    const stops = railStops([
      entry({ kind: "claimed", worker: "copper-7" }),
      entry({ kind: "moved", worker: "rivet-2", station: "review" }),
      entry({ kind: "completed" }),
    ]);

    expect(stops.map((stop) => stop.mark)).toEqual(["moment", "handover", "outcome"]);
    expect(stops[1]?.worker).toBe("rivet-2");
    expect(stops[0]?.worker).toBe("copper-7");
  });

  test("leaves a moment recorded against no agent without a worker", () => {
    const stops = railStops([entry({ kind: "queued" })]);

    expect(stops[0]).toEqual({ at: "2026-09-18T10:00:00.000Z", mark: "moment" });
  });

  test("calls a record's kinds what a person calls them, not what the column holds", () => {
    expect(ITEM_KIND_LABELS.commit_created).toBe("Commit");
    expect(ITEM_KIND_LABELS.finding_raised).toBe("Finding raised");
    expect(ITEM_KIND_LABELS.finding_answered).toBe("Finding answered");
    expect(ITEM_KIND_LABELS.environment_reported).toBe("Worker environment");
    expect(Object.values(ITEM_KIND_LABELS).every((label) => !label.includes("_"))).toBe(true);
  });

  test("marks a station move, so an order that just reached one has news", () => {
    const stops = railStops([entry({ kind: "moved", station: "review" })]);

    expect(stops[0]?.mark).toBe("handover");
    expect(ITEM_KIND_LABELS.moved).toBe("Moved");
  });

  test("draws a handover and an end differently from an ordinary moment", () => {
    expect(new Set(Object.values(RAIL_MARK_GLYPH)).size).toBe(3);
    expect(RAIL_MARK_GLYPH.handover).toBe("→");
  });

  test("shortens a sha to what a person compares", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
  });
});
