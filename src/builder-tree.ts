import { lstatSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

function git(worktree: string, args: string[]) {
  const run = Bun.spawnSync(["git", "-C", worktree, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: run.success, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() };
}

function containsGitDir(dir: string): string | null {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    // Git takes `.GIT` for `.git` on a filesystem that ignores case, as macOS's does by default.
    if (entry.toLowerCase() === ".git") return path;
    const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const found = containsGitDir(path);
      if (found) return found;
    }
  }
  return null;
}

/**
 * A repository nested in the tree is one the runner would stage as a gitlink, and the operator's
 * next `git status` would then run inside it, obeying that repository's config — its fsmonitor,
 * its filters — outside any sandbox. Found without entering one: tracked gitlinks from the index, and every untracked
 * directory git lists whole, walked for a `.git` without following links.
 */
export function nestedRepository(worktree: string): string | null {
  // NUL-separated, so a path git would otherwise quote comes back as itself.
  const tracked = git(worktree, ["ls-files", "-s", "-z"]);
  if (!tracked.ok) throw new Error(`cannot read the index of ${worktree}: ${tracked.err}`);
  const gitlink = tracked.out.split("\0").find((line) => line.startsWith("160000 "));
  if (gitlink) return gitlink.split("\t")[1] ?? gitlink;
  const untracked = git(worktree, ["ls-files", "-o", "--exclude-standard", "--directory", "-z"]);
  if (!untracked.ok) throw new Error(`cannot list what ${worktree} leaves untracked: ${untracked.err}`);
  for (const dir of untracked.out.split("\0").filter((path) => path.endsWith("/"))) {
    const found = containsGitDir(join(worktree, dir));
    if (found) return found.slice(worktree.length + 1);
  }
  return null;
}

/**
 * The hooks git runs over a builder's worktree. Where the repository keeps them in its tree —
 * `.husky` and the like — the worktree's copy is one the builder wrote, so the primary checkout's
 * copy of the same path runs instead; hooks kept anywhere else are the ones the repository already runs.
 */
export function hooksOutsideTree(worktree: string): string {
  const hooks = git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
  const top = git(worktree, ["rev-parse", "--show-toplevel"]);
  if (!hooks.ok || !top.ok)
    throw new Error(`cannot resolve the hooks of ${worktree}: ${hooks.err || top.err}`);
  const inTree = relative(top.out, hooks.out);
  if (inTree === "" || inTree.startsWith("..") || isAbsolute(inTree)) return hooks.out;
  const common = git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) throw new Error(`cannot find the primary checkout of ${worktree}: ${common.err}`);
  return join(dirname(common.out), inTree);
}
