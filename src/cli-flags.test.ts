import { describe, expect, test } from "bun:test";
import { parseArgs, positionalArg } from "./cli-flags";

const fail = (message: string) => new Error(message);

describe("the one positional argument", () => {
  test("is found by position, so a value equal to a flag's value survives", () => {
    expect(positionalArg(["5", "--rows", "5"], ["--rows"], fail)).toBe("5");
    expect(positionalArg(["--rows", "5", "thread"], ["--rows"], fail)).toBe("thread");
    expect(positionalArg(["--rows", "5"], ["--rows"], fail)).toBeUndefined();
  });

  test("refuses a flag it was not given rather than skipping it", () => {
    expect(() => positionalArg(["words", "--since", "7d"], ["--rows"], fail)).toThrow(
      "does not take --since",
    );
  });

  test("refuses a second positional rather than dropping it", () => {
    expect(() => positionalArg(["two", "words"], [], fail)).toThrow(
      "takes one argument, and got 2: two words",
    );
  });
});

describe("a command's arguments", () => {
  const spec = { positionals: 1, flags: ["reason", "decided"] } as const;

  test("reads each flag's value and the positionals around them", () => {
    expect(parseArgs(["k7", "--reason", "fine", "--decided", "owner"], spec, fail)).toEqual({
      positionals: ["k7"],
      flags: { reason: "fine", decided: "owner" },
    });
  });

  test("refuses a flag the command does not take, one given twice, or one with no value", () => {
    expect(() => parseArgs(["k7", "--by", "someone"], spec, fail)).toThrow("does not take --by");
    expect(() => parseArgs(["k7", "--reason", "a", "--reason", "b"], spec, fail)).toThrow("once");
    expect(() => parseArgs(["k7", "--reason"], spec, fail)).toThrow("needs a value");
    expect(() => parseArgs(["k7", "--reason", "--decided", "owner"], spec, fail)).toThrow("needs a value");
  });

  test("refuses the wrong number of positionals", () => {
    expect(() => parseArgs([], spec, fail)).toThrow("got 0");
    expect(() => parseArgs(["k7", "plan"], spec, fail)).toThrow("got 2");
  });
});
