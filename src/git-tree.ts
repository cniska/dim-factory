import { join } from "node:path";
import { invariant } from "./assert";
import type { Env } from "./paths";

export function git(repo: string, args: string[], options: { env?: Env; stdin?: string } = {}) {
  const run = Bun.spawnSync(["git", "-C", repo, ...args], {
    env: options.env,
    stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: run.success, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() };
}

export function remoteHeadBranch(repo: string, remote: string): string | null {
  const head = git(repo, ["symbolic-ref", "--short", "-q", `refs/remotes/${remote}/HEAD`]).out;
  if (head === "") return null;
  return head.startsWith(`${remote}/`) ? head.slice(remote.length + 1) : head;
}

export function ran(repo: string, args: readonly string[], env?: Env): string {
  const result = git(repo, [...args], env === undefined ? {} : { env });
  invariant(result.ok, `git ${args.join(" ")} in ${repo}: ${result.err}`);
  return result.out;
}

export function sharedConfigOf(repo: string): string {
  return join(ran(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "config");
}

export type Identity = { readonly name: string; readonly email: string };

export function identityOf(repo: string, env: Env): Identity | null {
  const name = git(repo, ["config", "--get", "user.name"], { env });
  const email = git(repo, ["config", "--get", "user.email"], { env });
  return name.ok && email.ok ? { name: name.out, email: email.out } : null;
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
