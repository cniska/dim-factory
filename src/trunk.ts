import { join } from "node:path";

/**
 * Whether a commit has reached the repo's trunk, read from git rather than from
 * the record: nothing in the database knows what has been merged since.
 *
 * Every way the read can come back short is its own answer, because each one
 * sends the operator somewhere different and a git command that failed is not
 * evidence that the work is unmerged.
 */
export type TrunkReach =
  | { reach: "reached" }
  | { reach: "unreached" }
  /** The repo does not have that commit at all, so nothing here can place it. */
  | { reach: "absent" }
  /** Nothing here can say what integration means; `why` is written for the operator. */
  | { reach: "unknown"; why: string };

function git(dir: string, args: string[]): { success: boolean; out: string } {
  const run = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
  return { success: run.success, out: run.stdout.toString().trim() };
}

/**
 * `refs/remotes/origin/HEAD` is what `git clone` writes and nothing else does, so
 * it is the one place a repo states its own trunk instead of an agent assuming a
 * name. A repo started with `git init` has no such ref, which `dim doctor`
 * already reports through `unarmedCheckouts`.
 */
export function trunkBranch(dir: string): { name: string } | { why: string } {
  if (!git(dir, ["rev-parse", "--git-dir"]).success) {
    return { why: `${dir} is not a git repo that can be read` };
  }
  const head = git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const name = head.success ? head.out.slice(head.out.indexOf("/") + 1) : "";
  if (!name) {
    return { why: `${dir} does not name a trunk; set it with \`git remote set-head origin -a\`` };
  }
  if (!git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).success) {
    return { why: `${dir} names ${name} as its trunk but has no local branch by that name` };
  }
  return { name };
}

/**
 * The local trunk rather than the remote's, because a commit is integrated when
 * it is on the branch the next worker will start from.
 */
export function reachesTrunk(dir: string, sha: string): TrunkReach {
  const trunk = trunkBranch(dir);
  if ("why" in trunk) return { reach: "unknown", why: trunk.why };
  // Asked before the ancestry, which exits non-zero for an unknown object too and
  // would otherwise report a sha this repo never had as a branch left unmerged.
  if (!git(dir, ["cat-file", "-e", `${sha}^{commit}`]).success) return { reach: "absent" };
  return git(dir, ["merge-base", "--is-ancestor", sha, `refs/heads/${trunk.name}`]).success
    ? { reach: "reached" }
    : { reach: "unreached" };
}

/**
 * The refs that decide what the trunk holds and which branch it is: its own ref, the packed
 * refs that can hold it, and the remote HEAD that names it. A worker moving any of them would
 * land work outside review and ship. The trunk's own ref is named only where the repo states
 * a trunk, and these are file paths, so they hold under git's files ref storage and not under
 * reftable.
 */
export function trunkRefPaths(dir: string, commonDir: string): string[] {
  const trunk = trunkBranch(dir);
  return [
    join(commonDir, "packed-refs"),
    join(commonDir, "refs", "remotes", "origin", "HEAD"),
    ...("name" in trunk ? [join(commonDir, "refs", "heads", trunk.name)] : []),
  ];
}
