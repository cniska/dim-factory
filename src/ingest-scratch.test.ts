import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isFactoryWorkspace, isScratchRepo } from "./ingest-scratch";

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

  test("the resolved spelling of the temp directory counts too", () => {
    expect(isScratchRepo(join(realpathSync(tmpdir()), "dim-git-abc123"))).toBe(true);
  });

  test("a per-user darwin temp tree counts", () => {
    expect(isScratchRepo("/private/var/folders/v5/9g9nzrss/T/dim-git-abc123")).toBe(true);
    expect(isScratchRepo("/var/folders/v5/9g9nzrss/T/dim-git-abc123")).toBe(true);
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

  test("a temp directory that is gone does not stop the module loading", () => {
    const script = `import { isScratchRepo } from ${JSON.stringify(join(import.meta.dir, "ingest-scratch.ts"))};
      if (isScratchRepo("/Users/someone/code/dim-factory")) process.exit(2);`;
    const proc = Bun.spawnSync(["bun", "-e", script], {
      env: { ...process.env, TMPDIR: "/dim-temp-directory-that-is-gone" },
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(proc.exitCode).toBe(0);
  });

  test("a relative path is judged where it actually resolves", () => {
    const cwd = process.cwd();
    try {
      process.chdir("/");
      expect(isScratchRepo("code/dim-factory")).toBe(false);
      process.chdir(realpathSync(tmpdir()));
      expect(isScratchRepo("code/dim-factory")).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("a factory workspace is not the work", () => {
  const env = { XDG_DATA_HOME: "/Users/someone/stash" };
  const root = "/Users/someone/stash/dim-factory/workspaces";

  test("a workspace and anything below it is one", () => {
    expect(isFactoryWorkspace(`${root}/acme/widgets/abc123`, env)).toBe(true);
    expect(isFactoryWorkspace(`${root}/acme/widgets/abc123/src`, env)).toBe(true);
  });

  test("a worker's home, a sibling checkout and a worktree checkout are not", () => {
    expect(isFactoryWorkspace("/Users/someone/stash/dim-factory/workers/w-1/home", env)).toBe(false);
    expect(isFactoryWorkspace("/Users/someone/code/widgets", env)).toBe(false);
    expect(isFactoryWorkspace("/Users/someone/code/widgets/.claude/worktrees/task-a", env)).toBe(false);
    expect(isFactoryWorkspace("/Users/someone/stash/dim-factory/workspaces-old/acme", env)).toBe(false);
  });

  test("a path is judged resolved", () => {
    expect(isFactoryWorkspace(`${root}/acme/../../workers/w-1`, env)).toBe(false);
    expect(isFactoryWorkspace(`${root}/../workspaces/acme/widgets/abc123`, env)).toBe(true);
  });

  test("a workspace named through a symlinked data directory is judged by its real path", () => {
    const real = mkdtempSync(join(realpathSync(tmpdir()), "dim-ws-real-"));
    const link = `${real}-link`;
    try {
      symlinkSync(real, link);
      mkdirSync(join(real, "dim-factory", "workspaces", "acme", "widgets", "abc123"), { recursive: true });
      const linked = { XDG_DATA_HOME: link };
      expect(isFactoryWorkspace(join(real, "dim-factory/workspaces/acme/widgets/abc123"), linked)).toBe(true);
      expect(isFactoryWorkspace(join(link, "dim-factory/workspaces/acme/widgets/abc123"), linked)).toBe(true);
      expect(isFactoryWorkspace(join(real, "dim-factory/workers/w-1"), linked)).toBe(false);
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });
});
