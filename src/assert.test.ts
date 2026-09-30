import { expect, test } from "bun:test";
import { invariant, unreachable } from "./assert";

test("unreachable throws, naming the value that reached it", () => {
  expect(() => unreachable("stray" as never)).toThrow('unreachable: "stray"');
});

test("invariant passes a held condition and throws on a broken one, naming it", () => {
  expect(() => invariant(true, "held")).not.toThrow();
  expect(() => invariant(null, "the row exists")).toThrow("invariant failed: the row exists");
});
