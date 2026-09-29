import { describe, expect, test } from "bun:test";
import { UsageError } from "./cli-contract";
import { resolveSince, windowFromArgs } from "./query-since";

const NOW = new Date("2026-09-16T12:00:00.000Z");

describe("window", () => {
  test("counts days back from now", () => {
    expect(resolveSince("30d", NOW)).toBe("2026-08-17T12:00:00.000Z");
    expect(resolveSince("1d", NOW)).toBe("2026-09-15T12:00:00.000Z");
  });

  test("rejects dates that normalize to another day and windows outside the date range", () => {
    expect(() => resolveSince("2026-02-30", NOW)).toThrow(UsageError);
    expect(() => resolveSince("2025-02-29", NOW)).toThrow(UsageError);
    expect(resolveSince("2024-02-29", NOW)).toBe("2024-02-29T00:00:00.000Z");
    expect(() => resolveSince("999999999999d", NOW)).toThrow(UsageError);
  });

  test("takes a date as the start of that day", () => {
    expect(resolveSince("2026-08-01", NOW)).toBe("2026-08-01T00:00:00.000Z");
  });

  test("refuses a spec it cannot read rather than guessing one", () => {
    expect(() => resolveSince("last week", NOW)).toThrow(UsageError);
    expect(() => resolveSince("30", NOW)).toThrow(UsageError);
    expect(() => resolveSince("2026-13-01", NOW)).toThrow(UsageError);
  });

  test("a recent query defaults to the last 30 days", () => {
    expect(windowFromArgs(["tools"], "recent", NOW)).toBe("2026-08-17T12:00:00.000Z");
  });

  test("--all widens to all of history, and beats a --since given alongside it", () => {
    expect(windowFromArgs(["tools", "--all"], "recent", NOW)).toBeNull();
    expect(windowFromArgs(["tools", "--all", "--since", "7d"], "recent", NOW)).toBeNull();
  });

  test("a query over history is not narrowed by the default, but takes an explicit window", () => {
    expect(windowFromArgs(["search"], "history", NOW)).toBeNull();
    expect(windowFromArgs(["search", "--since", "7d"], "history", NOW)).toBe("2026-09-09T12:00:00.000Z");
  });

  test("a query with no window refuses --since and --all instead of ignoring them", () => {
    expect(windowFromArgs(["running"], "none", NOW)).toBeNull();
    expect(() => windowFromArgs(["running", "--since", "7d"], "none", NOW)).toThrow(UsageError);
    expect(() => windowFromArgs(["running", "--all"], "none", NOW)).toThrow(UsageError);
  });

  test("--since with nothing after it fails instead of silently defaulting", () => {
    expect(() => windowFromArgs(["tools", "--since"], "recent", NOW)).toThrow(UsageError);
    expect(() => windowFromArgs(["tools", "--since", "--json"], "recent", NOW)).toThrow(UsageError);
  });
});
