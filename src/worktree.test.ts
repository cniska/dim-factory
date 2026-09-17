import { describe, expect, test } from "bun:test";
import { worktreeOf } from "./worktree";

describe("naming the worktree a path sits in", () => {
  test("names it, and nothing for a primary checkout", () => {
    expect(worktreeOf("/h/code/apps/.claude/worktrees/neochess/lib/x.dart")).toBe("neochess");
    expect(worktreeOf("/h/code/apps/.claude/worktrees/neochess")).toBe("neochess");
    expect(worktreeOf("/h/code/apps/lib/x.dart")).toBeNull();
    // `.claude` alone is not a worktree, or every settings file would name one.
    expect(worktreeOf("/h/code/apps/.claude/settings.json")).toBeNull();
    expect(worktreeOf(null)).toBeNull();
  });
});
