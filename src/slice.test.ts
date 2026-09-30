import { describe, expect, test } from "bun:test";
import { checkVerdict, submittedVerdict } from "./slice";

const FACTS = {
  head: "h0",
  parents: ["h0"],
  checkChanged: false,
  clean: true,
} as const;

describe("a submitted slice", () => {
  test("goes on to the check when it is one new commit on the recorded head, the check unchanged and the workspace clean", () => {
    expect(submittedVerdict(FACTS)).toBeNull();
  });

  test("is refused as a moved head unless its tip is exactly one commit on the recorded head", () => {
    expect(submittedVerdict({ ...FACTS, parents: ["other"] })).toBe("head_moved");
    expect(submittedVerdict({ ...FACTS, parents: ["h0", "m1"] })).toBe("head_moved");
  });

  test("is refused when it changes the check's definition, and then when its workspace holds uncommitted changes", () => {
    expect(submittedVerdict({ ...FACTS, checkChanged: true, clean: false })).toBe("check_changed");
    expect(submittedVerdict({ ...FACTS, clean: false })).toBe("workspace_dirty");
  });

  test("the moved head is judged before anything else", () => {
    expect(submittedVerdict({ ...FACTS, parents: [], checkChanged: true, clean: false })).toBe("head_moved");
  });
});

describe("a checked slice", () => {
  test("is committed when the check passed and left the workspace clean", () => {
    expect(checkVerdict(0, true)).toBeNull();
  });

  test("is refused when the check failed, or passed but rewrote the workspace", () => {
    expect(checkVerdict(1, true)).toBe("check_failed");
    expect(checkVerdict(null, true)).toBe("check_failed");
    expect(checkVerdict(0, false)).toBe("check_rewrote");
  });
});
