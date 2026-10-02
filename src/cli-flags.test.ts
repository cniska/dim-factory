import { describe, expect, test } from "bun:test";
import { type ArgSpec, parseArgs } from "./cli-flags";

const fail = "dim order run";

describe("a command's arguments", () => {
  const spec: ArgSpec<"reason" | "decided"> = { positionals: [1, 1], flags: ["reason", "decided"] };

  test("reads each flag's value and the positionals around them", () => {
    expect(parseArgs(["k7", "--reason", "fine", "--decided", "owner"], spec, fail)).toEqual({
      positionals: ["k7"],
      flags: { reason: "fine", decided: "owner" },
      switches: new Set(),
    });
  });

  test("reads a switch as present without taking the next argument as its value", () => {
    const write: ArgSpec<never, "write"> = { positionals: [0, 2], flags: [], switches: ["write"] };
    expect(parseArgs(["--write", "a.ts"], write, fail)).toEqual({
      positionals: ["a.ts"],
      flags: {},
      switches: new Set(["write"]),
    });
    expect(parseArgs(["a.ts"], write, fail).switches.has("write")).toBe(false);
    expect(() => parseArgs(["--write", "--write"], write, fail)).toThrow("takes --write once");
    expect(() => parseArgs(["--wirte"], write, fail)).toThrow("does not take --wirte");
  });

  test("finds a positional by position, so one equal to a flag's value survives", () => {
    const rows: ArgSpec<"rows"> = { positionals: [0, 1], flags: ["rows"] };
    expect(parseArgs(["5", "--rows", "5"], rows, fail).positionals).toEqual(["5"]);
    expect(parseArgs(["--rows", "5"], rows, fail).positionals).toEqual([]);
  });

  test("refuses a flag the command does not take, one given twice, or one with no value", () => {
    expect(() => parseArgs(["k7", "--by", "someone"], spec, fail)).toThrow("does not take --by");
    expect(() => parseArgs(["k7", "--reason", "a", "--reason", "b"], spec, fail)).toThrow("once");
    expect(() => parseArgs(["k7", "--reason"], spec, fail)).toThrow("needs a value");
    expect(() => parseArgs(["k7", "--reason", "--decided", "owner"], spec, fail)).toThrow("needs a value");
  });

  test("refuses with a usage error that names the command", () => {
    expect(() => parseArgs([], spec, fail)).toThrow(
      expect.objectContaining({ code: "usage", message: "dim order run takes 1 argument(s), and got 0: " }),
    );
  });

  test("refuses more or fewer positionals than the command takes", () => {
    expect(() => parseArgs([], spec, fail)).toThrow("takes 1 argument(s), and got 0");
    expect(() => parseArgs(["k7", "plan"], spec, fail)).toThrow("got 2: k7 plan");
    expect(() => parseArgs(["a", "b"], { positionals: [0, 1], flags: [] }, fail)).toThrow("takes 0 to 1");
  });
});
