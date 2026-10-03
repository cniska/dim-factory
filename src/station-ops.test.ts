import { describe, expect, test } from "bun:test";
import { turnReplyOf } from "./station-ops";

describe("a turn's reply to a worker's act", () => {
  test("is refused as no turn when the turn closed without replying", () => {
    expect(() => turnReplyOf("")).toThrow(expect.objectContaining({ code: "no_turn" }));
  });
});
