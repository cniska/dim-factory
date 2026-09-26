import { describe, expect, test } from "bun:test";
import { BadWindowError, resolveSince, windowFromArgs } from "./query-since";

const NOW = new Date("2026-09-16T12:00:00.000Z");

describe("window", () => {
  test("counts days back from now", () => {
    expect(resolveSince("30d", NOW)).toBe("2026-08-17T12:00:00.000Z");
    expect(resolveSince("1d", NOW)).toBe("2026-09-15T12:00:00.000Z");
  });

  test("takes a date as the start of that day", () => {
    expect(resolveSince("2026-08-01", NOW)).toBe("2026-08-01T00:00:00.000Z");
  });

  test("refuses a spec it cannot read rather than guessing one", () => {
    expect(() => resolveSince("last week", NOW)).toThrow(BadWindowError);
    expect(() => resolveSince("30", NOW)).toThrow(BadWindowError);
    expect(() => resolveSince("2026-13-01", NOW)).toThrow(BadWindowError);
  });

  test("defaults to the last 30 days", () => {
    expect(windowFromArgs(["tools"], {}, NOW)).toBe("2026-08-17T12:00:00.000Z");
  });

  test("--all widens to all of history, and beats a --since given alongside it", () => {
    expect(windowFromArgs(["tools", "--all"], {}, NOW)).toBeUndefined();
    expect(windowFromArgs(["tools", "--all", "--since", "7d"], {}, NOW)).toBeUndefined();
  });

  test("a time series is not narrowed by the default, but takes an explicit window", () => {
    expect(windowFromArgs(["models"], { spansHistory: true }, NOW)).toBeUndefined();
    expect(windowFromArgs(["models", "--since", "7d"], { spansHistory: true }, NOW)).toBe(
      "2026-09-09T12:00:00.000Z",
    );
  });

  test("--since with nothing after it fails instead of silently defaulting", () => {
    expect(() => windowFromArgs(["tools", "--since"], {}, NOW)).toThrow(BadWindowError);
    expect(() => windowFromArgs(["tools", "--since", "--json"], {}, NOW)).toThrow(BadWindowError);
  });
});
