import { invariant } from "./assert";
import type { Env } from "./paths";

export function git(worktree: string, args: string[], options: { env?: Env; stdin?: string } = {}) {
  const run = Bun.spawnSync(["git", "-C", worktree, ...args], {
    env: options.env,
    stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: run.success, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() };
}

export function remoteHeadBranch(worktree: string, remote: string): string | null {
  const head = git(worktree, ["symbolic-ref", "--short", "-q", `refs/remotes/${remote}/HEAD`]).out;
  if (head === "") return null;
  return head.startsWith(`${remote}/`) ? head.slice(remote.length + 1) : head;
}

export function ran(cwd: string, args: readonly string[], env?: Env): string {
  const result = git(cwd, [...args], env === undefined ? {} : { env });
  invariant(result.ok, `git ${args.join(" ")} in ${cwd}: ${result.err}`);
  return result.out;
}

export function tipOf(repo: string, branch: string): string {
  return ran(repo, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
}

export function moveRef(repo: string, branch: string, to: string, from: string): void {
  ran(repo, ["update-ref", `refs/heads/${branch}`, to, from]);
}

export function isClean(repo: string, untracked: "all" | "no"): boolean {
  return ran(repo, ["status", "--porcelain", `--untracked-files=${untracked}`]) === "";
}

export function diffSince(repo: string, defaultBranch: string, head: string): string {
  return ran(repo, ["diff", "--no-ext-diff", "--no-color", `refs/heads/${defaultBranch}...${head}`]);
}
