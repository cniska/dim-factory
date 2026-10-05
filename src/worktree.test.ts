import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { withoutWorktree, worktreeOf } from "./worktree";

describe("naming the worktree a path sits in", () => {
  test("names it, and nothing for a primary checkout", () => {
    expect(worktreeOf("/h/code/one/.claude/worktrees/side/lib/x.dart")).toBe("side");
    expect(worktreeOf("/h/code/one/.claude/worktrees/side")).toBe("side");
    expect(worktreeOf("/h/code/one/lib/x.dart")).toBeNull();
    expect(worktreeOf("/h/code/one/.claude/settings.json")).toBeNull();
    expect(worktreeOf(null)).toBeNull();
  });

  test("a worktree checkout collapses onto the file it is a copy of", () => {
    const db = new Database(":memory:");
    try {
      const expr = withoutWorktree("p");
      const one = (p: string) =>
        db.query<{ out: string }, [string]>(`SELECT ${expr} AS out FROM (SELECT ? AS p)`).get(p)?.out;

      expect(one("/h/code/one/.claude/worktrees/side/docs/x.md")).toBe("/h/code/one/docs/x.md");
      expect(one("/h/code/one/docs/x.md")).toBe("/h/code/one/docs/x.md");
      expect(one("/h/code/one/.claude/settings.json")).toBe("/h/code/one/.claude/settings.json");
      expect(one("/h/code/one/.claude/worktrees/side")).toBe("/h/code/one");
    } finally {
      db.close();
    }
  });
});
