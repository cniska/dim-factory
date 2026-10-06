import { describe, expect, test } from "bun:test";
import { rebasedVerdict, submittedVerdict } from "./slice";

const FACTS = {
  tip: "t1",
  head: "h0",
  parents: ["h0"],
  checkChanged: false,
} as const;

const code = (verdict: { readonly code: string } | null) => verdict?.code ?? null;

describe("a submitted slice", () => {
  test("is taken when it is one new commit on the recorded head with the check unchanged", () => {
    expect(submittedVerdict(FACTS)).toBeNull();
  });

  test("is refused as a moved head unless its tip is exactly one commit on the recorded head", () => {
    expect(submittedVerdict({ ...FACTS, parents: ["other"] })).toEqual({
      action: "slice_refused",
      code: "head_moved",
      details: { tip: "t1", head: "h0" },
    });
    expect(code(submittedVerdict({ ...FACTS, parents: ["h0", "m1"] }))).toBe("head_moved");
  });

  test("is refused when it changes the check's definition", () => {
    expect(submittedVerdict({ ...FACTS, checkChanged: true })).toEqual({
      action: "slice_refused",
      code: "check_changed",
      details: { tip: "t1" },
    });
  });

  test("the moved head is judged before anything else", () => {
    expect(code(submittedVerdict({ ...FACTS, parents: [], checkChanged: true }))).toBe("head_moved");
  });
});

describe("a rebased slice", () => {
  const REBASED = {
    tip: "t2",
    onto: "o1",
    expected: 2,
    rebasing: false,
    onOnto: true,
    commits: 2,
    checkChanged: false,
  } as const;

  test("is taken when the order's commits sit on the target with the rebase finished", () => {
    expect(rebasedVerdict(REBASED)).toBeNull();
  });

  test("is refused as not rebased, naming the target and the commits it should carry", () => {
    expect(rebasedVerdict({ ...REBASED, commits: 1 })).toEqual({
      action: "slice_refused",
      code: "not_rebased",
      details: { tip: "t2", onto: "o1", commits: 2 },
    });
    expect(code(rebasedVerdict({ ...REBASED, rebasing: true }))).toBe("not_rebased");
    expect(code(rebasedVerdict({ ...REBASED, onOnto: false }))).toBe("not_rebased");
  });

  test("is refused when it changes the check's definition", () => {
    expect(code(rebasedVerdict({ ...REBASED, checkChanged: true }))).toBe("check_changed");
  });
});
