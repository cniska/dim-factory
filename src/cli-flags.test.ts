import { describe, expect, test } from "bun:test";
import { positionalArg } from "./cli-flags";

const fail = (message: string) => new Error(message);

describe("the one positional argument", () => {
  test("is found by position, so a value equal to a flag's value or a command name survives", () => {
    expect(positionalArg(["30d", "--since", "30d"], ["--since"], fail)).toBe("30d");
    expect(positionalArg(["--rows", "5", "thread"], ["--rows"], fail)).toBe("thread");
  });

  test("skips a flag's value and a switch", () => {
    expect(positionalArg(["--all", "--since", "7d"], ["--since"], fail)).toBeUndefined();
    expect(positionalArg(["words", "--all"], ["--since"], fail)).toBe("words");
  });

  test("refuses a second positional rather than dropping it", () => {
    expect(() => positionalArg(["two", "words"], [], fail)).toThrow(
      "takes one argument, and got 2: two words",
    );
  });
});
