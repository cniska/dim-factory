import { describe, expect, test } from "bun:test";
import { positionalArg } from "./cli-flags";

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
