import { describe, expect, test } from "bun:test";
import { addShares, contextShares } from "./context-shares";

const call = (at: string, context: number, output: number) => ({ at, context, output });

describe("the context a session read, by what put it there", () => {
  test("charges each piece once for every call that read it, so the shares sum to the input", () => {
    const calls = [call("10:00", 1000, 50), call("10:02", 1350, 40), call("10:04", 1500, 10)];
    const shares = contextShares(calls, ["10:01", "10:01", "10:03"]);
    expect(shares).toEqual({ brief: 3000, tools: 710, messages: 140 });
    expect(shares.brief + shares.tools + shares.messages).toBe(1000 + 1350 + 1500);
  });

  test("counts growth with no tool result before it as messages", () => {
    expect(contextShares([call("10:00", 100, 5), call("10:01", 130, 5)], [])).toEqual({
      brief: 200,
      tools: 0,
      messages: 30,
    });
  });

  test("counts a context rebuilt smaller by compaction as messages, from then on", () => {
    const calls = [call("10:00", 1000, 0), call("10:01", 300, 0), call("10:02", 300, 0)];
    expect(contextShares(calls, [])).toEqual({ brief: 1000, tools: 0, messages: 600 });
  });

  test("is nothing for a session with no calls", () => {
    expect(contextShares([], ["10:00"])).toEqual({ brief: 0, tools: 0, messages: 0 });
  });

  test("adds the shares of several sessions", () => {
    expect(addShares({ brief: 10, tools: 1, messages: 2 }, { brief: 5, tools: 30, messages: 0 })).toEqual({
      brief: 15,
      tools: 31,
      messages: 2,
    });
  });
});
