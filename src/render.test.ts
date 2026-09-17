import { describe, expect, test } from "bun:test";
import { DEFAULT_MAX_ROWS, renderTable, rowsFromArgs } from "./render";

const result = {
  denominator: "3 rows",
  columns: ["session", "edits"],
  rows: [
    ["a-very-long-session-id", 1],
    ["short", 200],
  ] as (string | number | null)[][],
};

describe("the table an agent reads", () => {
  // Padding buys a reader columns that line up and costs the agent that reads
  // this a run of spaces on every row of every result.
  test("separates cells without padding them out to the column width", () => {
    const lines = renderTable(result).split("\n");
    expect(lines).toContain("a-very-long-session-id  1");
    expect(lines).toContain("short  200");
  });

  test("prints an em dash for a null, so an empty cell is never a missing column", () => {
    const withNull = { ...result, rows: [["x", null]] as (string | number | null)[][] };
    expect(renderTable(withNull).split("\n")).toContain("x  —");
  });

  test("names the flag that widens the window when rows were cut", () => {
    const many = { ...result, rows: Array.from({ length: 5 }, (_, i) => ["s", i]) };
    const out = renderTable(many, 2);
    expect(out).toContain("… 3 more rows; --rows <n> to widen");
    expect(out.split("\n").filter((l) => l.startsWith("s  "))).toHaveLength(2);
  });

  test("says nothing about more rows when every row fit", () => {
    expect(renderTable(result)).not.toContain("more rows");
  });

  test("shows the note instead of an empty table, so no evidence never reads as a zero", () => {
    const empty = { ...result, rows: [], note: "no session reported a cost" };
    expect(renderTable(empty)).toContain("no session reported a cost");
  });
});

describe("--rows", () => {
  test("defaults to the cap, and takes a count", () => {
    expect(rowsFromArgs(["q", "sessions"])).toBe(DEFAULT_MAX_ROWS);
    expect(rowsFromArgs(["q", "sessions", "--rows", "200"])).toBe(200);
  });

  // A bad count silently falling back to the default would print a short table
  // that reads as the whole answer.
  test("refuses a count that is not one", () => {
    expect(() => rowsFromArgs(["--rows", "many"])).toThrow("not a count");
    expect(() => rowsFromArgs(["--rows", "0"])).toThrow("not a count");
    expect(() => rowsFromArgs(["--rows"])).toThrow("not a count");
  });
});
