import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isScratchRepo } from "./scratch";

describe("a scratch tree is not the work", () => {
  test("an agent's own scratchpad is one", () => {
    expect(isScratchRepo("/private/tmp/claude-501/a-project/a-session/scratchpad/runs/run-103")).toBe(true);
  });

  test("the symlink and its target both count, because a cwd records either", () => {
    expect(isScratchRepo("/tmp/experiment")).toBe(true);
    expect(isScratchRepo("/private/tmp/experiment")).toBe(true);
  });

  test("whatever this machine calls its temp directory counts", () => {
    expect(isScratchRepo(join(tmpdir(), "dim-git-abc123"))).toBe(true);
  });

  test("the temp root itself counts", () => {
    expect(isScratchRepo(resolve(tmpdir()))).toBe(true);
  });

  test("a checkout the person keeps does not", () => {
    expect(isScratchRepo("/Users/someone/code/dim-factory")).toBe(false);
    expect(isScratchRepo("/Users/someone/code/one/.claude/worktrees/task-a")).toBe(false);
  });

  test("a path that merely begins with the same letters does not", () => {
    expect(isScratchRepo("/tmpfiles/code/thing")).toBe(false);
    expect(isScratchRepo("/private/tmpfoo/thing")).toBe(false);
  });

  test("a relative path is judged where it actually resolves", () => {
    expect(isScratchRepo("code/dim-factory")).toBe(false);
  });
});
