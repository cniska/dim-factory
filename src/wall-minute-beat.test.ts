import { describe, expect, test } from "bun:test";
import { msUntilNextMinute } from "./wall-minute-beat";

describe("waiting for the minute to turn", () => {
  test("a fresh minute waits the whole one out", () => {
    expect(msUntilNextMinute(Date.parse("2026-09-19T13:30:00.000Z"))).toBe(60_000);
  });

  test("a moment before the turn waits only what is left", () => {
    expect(msUntilNextMinute(Date.parse("2026-09-19T13:30:59.750Z"))).toBe(250);
  });

  test("the wait is never zero", () => {
    for (const ms of [0, 1, 59_999, 60_000, 1_758_288_600_000]) {
      expect(msUntilNextMinute(ms)).toBeGreaterThan(0);
    }
  });
});
