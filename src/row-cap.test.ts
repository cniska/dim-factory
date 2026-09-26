import { describe, expect, test } from "bun:test";
import { capRows, DEFAULT_MAX_ROWS, rowsFromArgs } from "./row-cap";

describe("--rows", () => {
  test("defaults to the cap, and takes a count", () => {
    expect(rowsFromArgs(["q", "sessions"])).toBe(DEFAULT_MAX_ROWS);
    expect(rowsFromArgs(["q", "sessions", "--rows", "200"])).toBe(200);
  });

  test("refuses a count that is not one", () => {
    expect(() => rowsFromArgs(["--rows", "many"])).toThrow("not a count");
    expect(() => rowsFromArgs(["--rows", "0"])).toThrow("not a count");
    expect(() => rowsFromArgs(["--rows"])).toThrow("not a count");
  });
});

describe("capping the rows an agent is handed", () => {
  test("names the flag that widens it when rows were cut", () => {
    const capped = capRows([1, 2, 3, 4, 5], 2);
    expect(capped).toEqual({ rows: [1, 2], more: "3 more rows; --rows <n> to widen" });
  });

  test("says nothing about more rows when every row fit", () => {
    expect(capRows([1, 2], 2).more).toBeNull();
  });
});
