import { describe, expect, test } from "bun:test";
import { capRows, DEFAULT_MAX_ROWS, rowsOf } from "./query-row-cap";

describe("--rows", () => {
  test("defaults to the cap, and takes a count", () => {
    expect(rowsOf(undefined)).toBe(DEFAULT_MAX_ROWS);
    expect(rowsOf("200")).toBe(200);
  });

  test("refuses a count that is not one", () => {
    expect(() => rowsOf("many")).toThrow("not a count");
    expect(() => rowsOf("0")).toThrow("not a count");
    expect(() => rowsOf("")).toThrow("not a count");
  });
});

describe("capping the rows an agent is handed", () => {
  test("names the flag that widens it when rows were cut", () => {
    const capped = capRows([1, 2, 3, 4, 5], 2);
    expect(capped).toEqual({ rows: [1, 2], more: "more rows than 2; --rows <n> to widen" });
  });

  test("says nothing about more rows when every row fit", () => {
    expect(capRows([1, 2], 2).more).toBeNull();
  });
});
