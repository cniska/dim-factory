export type TrunkReach =
  | { reach: "reached" }
  | { reach: "unreached" }
  | { reach: "absent" }
  | { reach: "unknown"; why: string };

function git(dir: string, args: string[]): { success: boolean; out: string } {
  const run = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
  return { success: run.success, out: run.stdout.toString().trim() };
}

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

export function reachesTrunk(dir: string, sha: string): TrunkReach {
  const trunk = trunkBranch(dir);
  if ("why" in trunk) return { reach: "unknown", why: trunk.why };
  if (!git(dir, ["cat-file", "-e", `${sha}^{commit}`]).success) return { reach: "absent" };
  return git(dir, ["merge-base", "--is-ancestor", sha, `refs/heads/${trunk.name}`]).success
    ? { reach: "reached" }
    : { reach: "unreached" };
}
