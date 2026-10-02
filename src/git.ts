import { refuseGit } from "./git-contract";
import type { Env } from "./paths";

export type GitRun = { readonly status: number; readonly out: string; readonly err: string };

type GitOptions = { readonly env?: Env; readonly stdin?: string };

export function git(repo: string, args: readonly string[], options: GitOptions = {}): GitRun {
  const run = Bun.spawnSync(["git", "-C", repo, ...args], {
    env: options.env,
    stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { status: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString().trim() };
}

export function refused(repo: string, args: readonly string[], run: GitRun) {
  return refuseGit("git_unreadable", {
    root: repo,
    what: `git ${args.join(" ")}`,
    detail: run.err === "" ? `exit ${run.status}` : run.err,
  });
}

export function ranRaw(repo: string, args: readonly string[], options: GitOptions = {}): string {
  const run = git(repo, args, options);
  if (run.status !== 0) throw refused(repo, args, run);
  return run.out;
}

export function ran(repo: string, args: readonly string[], options: GitOptions = {}): string {
  return ranRaw(repo, args, options).trim();
}

function answered(repo: string, args: readonly string[], options: GitOptions = {}): string | null {
  const run = git(repo, args, options);
  if (run.status === 1) return null;
  if (run.status !== 0) throw refused(repo, args, run);
  return run.out.trim();
}

export function nulFields(output: string, command: string): string[] {
  if (output === "") return [];
  if (!output.endsWith("\0")) {
    throw refuseGit("git_output_malformed", { command, problem: "a record that does not end in NUL" });
  }
  return output.slice(0, -1).split("\0");
}

export function remoteHeadBranch(repo: string, remote: string): string | null {
  const head = answered(repo, ["symbolic-ref", "--short", "-q", `refs/remotes/${remote}/HEAD`]);
  if (head === null) return null;
  return head.startsWith(`${remote}/`) ? head.slice(remote.length + 1) : head;
}

export function checkedOutBranch(repo: string): string | null {
  return answered(repo, ["symbolic-ref", "-q", "--short", "HEAD"]);
}

export function gitCommonDir(repo: string): string {
  return ran(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

export type Identity = { readonly name: string; readonly email: string };

export function identityOf(repo: string, env: Env): Identity | null {
  const name = answered(repo, ["config", "--get", "user.name"], { env });
  const email = answered(repo, ["config", "--get", "user.email"], { env });
  return name === null || email === null ? null : { name, email };
}

export function configValue(repo: string, key: string): string | null {
  return answered(repo, ["config", "--get", key]);
}

export function hasCommit(repo: string, at: string): boolean {
  return answered(repo, ["rev-parse", "--verify", "-q", `${at}^{commit}`]) !== null;
}

export function tipOf(repo: string, branch: string): string {
  return ran(repo, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
}

export function commitsBetween(repo: string, base: string, head: string): readonly string[] {
  const listed = ran(repo, ["rev-list", "--reverse", `${base}..${head}`]);
  return listed === "" ? [] : listed.split("\n");
}

export function isAncestor(repo: string, ancestor: string, commit: string): boolean {
  return answered(repo, ["merge-base", "--is-ancestor", ancestor, commit]) !== null;
}

export function isClean(repo: string, untracked: "all" | "no"): boolean {
  return ran(repo, ["status", "--porcelain", `--untracked-files=${untracked}`]) === "";
}

export function diffSince(repo: string, defaultBranch: string, head: string): string {
  return ran(repo, ["diff", "--no-ext-diff", "--no-color", `refs/heads/${defaultBranch}...${head}`]);
}
