import { lstatSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

function git(worktree: string, args: string[]) {
  const run = Bun.spawnSync(["git", "-C", worktree, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: run.success, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() };
}

function containsGitDir(dir: string): string | null {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry.toLowerCase() === ".git") return path;
    const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const found = containsGitDir(path);
      if (found) return found;
    }
  }
  return null;
}

export function nestedRepository(worktree: string): string | null {
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
