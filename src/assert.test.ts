import { expect, test } from "bun:test";
import { invariant, unreachable } from "./assert";

test("unreachable refuses with its code, naming the value that reached it", () => {
  expect(() => unreachable("stray" as never)).toThrow(
    expect.objectContaining({ code: "unreachable", message: 'unreachable: "stray"' }),
  );
});

test("invariant passes a held condition and refuses a broken one with its code, naming it", () => {
  expect(() => invariant(true, "held")).not.toThrow();
  expect(() => invariant(null, "the row exists")).toThrow(
    expect.objectContaining({ code: "invariant_failed", message: "invariant failed: the row exists" }),
  );
});
