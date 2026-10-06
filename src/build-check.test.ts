import { describe, expect, test } from "bun:test";
import { buildCheckVerdict } from "./build-check";

const check = (exitCode: number | null) =>
  ({ kind: "check", command: "bun run check", exitCode, output: "out" }) as const;

describe("a returned build's check", () => {
  test("is recorded as passed with its evidence when it passed and left the workspace clean", () => {
    expect(buildCheckVerdict("h1", check(0), true)).toEqual({
      action: "build_checked",
      details: { head: "h1" },
      evidence: [check(0)],
    });
  });

  test("refuses the build when the check failed or was cut off, keeping the check as evidence", () => {
    expect(buildCheckVerdict("h1", check(1), true)).toEqual({
      action: "build_refused",
      code: "check_failed",
      details: { head: "h1", command: "bun run check", exitCode: 1 },
      evidence: [check(1)],
    });
    expect(buildCheckVerdict("h1", check(null), true)).toMatchObject({ code: "check_failed" });
  });

  test("refuses the build when the check passed but rewrote the workspace", () => {
    expect(buildCheckVerdict("h1", check(0), false)).toEqual({
      action: "build_refused",
      code: "check_rewrote",
      details: { head: "h1", command: "bun run check" },
      evidence: [check(0)],
    });
  });
});
