import { describe, expect, test } from "bun:test";
import { ndcgAtK, recallAtK } from "./rank-metrics";

describe("recall@k", () => {
  test("counts the relevant rows that made the cut, over every relevant row", () => {
    expect(recallAtK(["a", "b", "c"], new Set(["a", "d"]), 3)).toBe(0.5);
  });

  test("looks no further down the list than k", () => {
    expect(recallAtK(["x", "a"], new Set(["a"]), 1)).toBe(0);
    expect(recallAtK(["x", "a"], new Set(["a"]), 2)).toBe(1);
  });

  // Zero is what a total miss earns, so scoring an unanswerable question zero
  // makes a corpus defect indistinguishable from a retrieval failure.
  test("a question with no relevant row is refused, not scored", () => {
    expect(() => recallAtK(["a"], new Set(), 5)).toThrow("at least one relevant row");
  });

  test("a row returned twice is counted once", () => {
    expect(recallAtK(["a", "a"], new Set(["a", "b"]), 2)).toBe(0.5);
  });
});

describe("nDCG@k", () => {
  test("is 1 when the graded rows come back in their best order", () => {
    const grades = new Map([
      ["a", 2],
      ["b", 1],
    ]);
    expect(ndcgAtK(["a", "b"], grades, 2)).toBe(1);
  });

  // The whole point of grading over counting: the same rows in a worse order
  // must score lower, or ranking changes are invisible to the measure.
  test("falls when the same rows come back in a worse order", () => {
    const grades = new Map([
      ["a", 2],
      ["b", 1],
    ]);
    const best = ndcgAtK(["a", "b"], grades, 2);
    const worse = ndcgAtK(["b", "a"], grades, 2);
    expect(worse).toBeLessThan(best);
    expect(worse).toBeGreaterThan(0);
  });

  test("a row nobody graded contributes nothing", () => {
    const grades = new Map([["a", 3]]);
    expect(ndcgAtK(["junk", "a"], grades, 2)).toBeLessThan(1);
    expect(ndcgAtK(["junk"], grades, 1)).toBe(0);
  });

  test("a question with no row graded above zero is refused, not scored", () => {
    expect(() => ndcgAtK(["a"], new Map(), 5)).toThrow("graded above zero");
    expect(() => ndcgAtK(["a"], new Map([["a", 0]]), 5)).toThrow("graded above zero");
  });

  test("looks no further down the list than k", () => {
    expect(ndcgAtK(["b", "a"], new Map([["a", 3]]), 1)).toBe(0);
    expect(ndcgAtK(["b", "a"], new Map([["a", 3]]), 2)).toBeGreaterThan(0);
  });

  // Without the cutoff on the ideal order, grading more rows than k depresses
  // every score — and a corpus grades more than k as a matter of course.
  test("compares against the best possible k rows, not against every graded row", () => {
    const grades = new Map([
      ["a", 3],
      ["b", 2],
      ["c", 1],
    ]);
    expect(ndcgAtK(["a"], grades, 1)).toBe(1);
  });

  // nDCG is bounded to [0,1] by construction, so a ranker that emits the same
  // row twice must not score better than one that returns it once.
  test("cannot exceed one when a row comes back more than once", () => {
    expect(ndcgAtK(["a", "a"], new Map([["a", 3]]), 2)).toBe(1);
    expect(ndcgAtK(["a", "a", "a", "a", "a"], new Map([["a", 3]]), 5)).toBe(1);
  });

  test("ranks a high grade above a low one at the same position", () => {
    const grades = new Map([
      ["high", 3],
      ["low", 1],
    ]);
    expect(ndcgAtK(["high"], grades, 1)).toBeGreaterThan(ndcgAtK(["low"], grades, 1));
  });
});
