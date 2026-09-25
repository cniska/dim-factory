import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

function git(cwd: string, ...args: string[]): string[] | null {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) return null;
  return result.stdout
    .toString()
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
}

/** A worktree's own git dir and the common dir it shares, which a committing worker must reach. */
export function gitMetadataDirs(cwd: string): string[] {
  const dirs = git(cwd, "rev-parse", "--git-dir", "--git-common-dir") ?? [];
  return [...new Set(dirs)].map((gitDir) => (isAbsolute(gitDir) ? gitDir : resolve(cwd, gitDir)));
}

/**
 * What inside that metadata decides the commands the operator's own git runs there, outside
 * any sandbox, and what it shows: a config (a hooks path, an fsmonitor, a filter driver), a
 * hook, `info/` (which can exclude a file from every status), the replace refs and shallow
 * list (which can show a reviewer one commit while another ships), and every pointer that
 * sends git to another git dir or config — the worktree's `.git` file, each worktree's
 * `commondir` and `gitdir`, and the submodules' git dirs. Committing writes none of them.
 * The worktree entries are patterns, not the worktrees that exist now, because a worktree
 * the operator adds while a builder runs is reachable too.
 */
export function protectedGitPaths(cwd: string): string[] {
  const common = gitMetadataDirs(cwd).at(-1);
  if (!common) return [];
  const paths = [
    join(common, "config"),
    join(common, "config.worktree"),
    join(common, "hooks"),
    join(common, "info"),
    join(common, "modules"),
    join(common, "refs", "replace"),
    join(common, "shallow"),
    ...["commondir", "gitdir", "config.worktree"].map((name) => join(common, "worktrees", "*", name)),
  ];
  const top = git(cwd, "rev-parse", "--show-toplevel")?.[0];
  const pointer = top ? join(top, ".git") : null;
  if (pointer && existsSync(pointer) && statSync(pointer).isFile()) paths.push(pointer);
  return paths;
}
