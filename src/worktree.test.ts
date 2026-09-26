import { describe, expect, test } from "bun:test";
import { worktreeOf } from "./worktree";

describe("naming the worktree a path sits in", () => {
  test("names it, and nothing for a primary checkout", () => {
    expect(worktreeOf("/h/code/one/.claude/worktrees/side/lib/x.dart")).toBe("side");
    expect(worktreeOf("/h/code/one/.claude/worktrees/side")).toBe("side");
    expect(worktreeOf("/h/code/one/lib/x.dart")).toBeNull();
    expect(worktreeOf("/h/code/one/.claude/settings.json")).toBeNull();
    expect(worktreeOf(null)).toBeNull();
  });
});
