import { describe, expect, test } from "bun:test";
import { checkVerdict, rebasedVerdict, submittedVerdict } from "./slice";

const FACTS = {
  tip: "t1",
  head: "h0",
  parents: ["h0"],
  checkChanged: false,
  clean: true,
} as const;

const code = (verdict: { readonly code: string } | null) => verdict?.code ?? null;

describe("a submitted slice", () => {
  test("goes on to the check when it is one new commit on the recorded head, the check unchanged and the workspace clean", () => {
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

  test("is refused when it changes the check's definition, and then when its workspace holds uncommitted changes", () => {
    expect(submittedVerdict({ ...FACTS, checkChanged: true, clean: false })).toEqual({
      action: "slice_refused",
      code: "check_changed",
      details: { tip: "t1" },
    });
    expect(code(submittedVerdict({ ...FACTS, clean: false }))).toBe("workspace_dirty");
  });

  test("the moved head is judged before anything else", () => {
    expect(code(submittedVerdict({ ...FACTS, parents: [], checkChanged: true, clean: false }))).toBe(
      "head_moved",
    );
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
    clean: true,
  } as const;

  test("goes on to the check when the order's commits sit on the target with the rebase finished", () => {
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
});

describe("a checked slice", () => {
  const check = (exitCode: number | null) =>
    ({ kind: "check", command: "bun run verify", exitCode, output: "out" }) as const;

  test("is committed when the check passed and left the workspace clean", () => {
    expect(checkVerdict("t1", check(0), true)).toBeNull();
  });

  test("is refused when the check failed, keeping the check as evidence", () => {
    expect(checkVerdict("t1", check(1), true)).toEqual({
      action: "slice_refused",
      code: "check_failed",
      details: { tip: "t1", command: "bun run verify", exitCode: 1 },
      evidence: [check(1)],
    });
    expect(code(checkVerdict("t1", check(null), true))).toBe("check_failed");
  });

  test("is refused when the check passed but rewrote the workspace", () => {
    expect(checkVerdict("t1", check(0), false)).toEqual({
      action: "slice_refused",
      code: "check_rewrote",
      details: { tip: "t1", command: "bun run verify" },
      evidence: [check(0)],
    });
  });
});
