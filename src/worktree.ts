import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { runWorkerHook, type WorkerEnvironmentPhase, type WorkerHookReport } from "./worker-environment";

export const WORKTREE_SEGMENT = "/.claude/worktrees/";

export function worktreeOf(path: string | null | undefined): string | null {
  if (!path) return null;
  const at = path.indexOf(WORKTREE_SEGMENT);
  if (at === -1) return null;
  const rest = path.slice(at + WORKTREE_SEGMENT.length);
  const name = rest.split("/")[0];
  return name && name.length > 0 ? name : null;
}

export const withoutWorktree = (col: string): string => {
  const at = `instr(${col}, '${WORKTREE_SEGMENT}')`;
  const root = `substr(${col}, 1, ${at} - 1)`;
  const rest = `substr(${col}, ${at} + ${WORKTREE_SEGMENT.length})`;
  const tail = `instr(${rest}, '/')`;
  return `CASE
  WHEN ${at} = 0 THEN ${col}
  WHEN ${tail} = 0 THEN ${root}
  ELSE ${root} || substr(${rest}, ${tail})
  END`;
};

export type WtFailure = { code: "teardown_failed"; exitCode: number } | { code: "worktree_missing" };

export class WtError extends Error {
  constructor(
    message: string,
    readonly failure?: WtFailure,
    readonly report?: WorkerHookReport,
  ) {
    super(message);
  }
}

export type CreatedWorktree = { path: string; reused: boolean; setup: WorkerHookReport | null };
export type RemovedWorktree = { path: string; teardown: WorkerHookReport | null };

function hookStatus(report: WorkerHookReport): number {
  return report.exitCode ?? 128;
}

function die(message: string, failure?: WtFailure, report?: WorkerHookReport): never {
  throw new WtError(message, failure, report);
}

function git(args: string[], cwd?: string): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "inherit",
  });
  return { ok: proc.success, out: new TextDecoder().decode(proc.stdout).trim() };
}

export function repoRoot(cwd: string = process.cwd()): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (!proc.success) die("not inside a git repository");
  return dirname(new TextDecoder().decode(proc.stdout).trim());
}

function isExecutable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hookIn(dir: string, phase: WorkerEnvironmentPhase): string | null {
  const hook = join(dir, "scripts", `worktree-${phase}.sh`);
  return isExecutable(hook) ? hook : null;
}

function bootstrap(path: string): WorkerHookReport | null {
  const hook = hookIn(path, "setup");
  if (!hook) return null;
  const report = runWorkerHook("setup", hook, path);
  const rc = hookStatus(report);
  if (rc !== 0) die(`bootstrap failed (exit ${rc})`, undefined, report);
  return report;
}

function teardown(root: string, path: string, force: boolean): WorkerHookReport | null {
  const hook = hookIn(root, "teardown");
  if (!hook) return null;
  const report = runWorkerHook("teardown", hook, path);
  const rc = hookStatus(report);
  if (rc !== 0 && !force) {
    die(
      `teardown failed (exit ${rc}) — worktree kept; fix it, or re-run with --force`,
      { code: "teardown_failed", exitCode: rc },
      report,
    );
  }
  return report;
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function worktreesDir(root: string): string {
  return join(root, ".claude", "worktrees");
}

export function validateWorktreeBranch(branch: string): void {
  const checked = Bun.spawnSync(["git", "check-ref-format", "--branch", branch], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const valid =
    branch !== "" &&
    !branch.includes("/") &&
    !branch.includes("@{") &&
    !branch.startsWith("-") &&
    checked.success &&
    new TextDecoder().decode(checked.stdout).trim() === branch;
  if (!valid) die(`invalid branch name: ${branch}`);
}

export function worktreePath(root: string, branch: string): string {
  validateWorktreeBranch(branch);
  return join(worktreesDir(root), branch);
}

function registeredWorktree(root: string, path: string, branch: string): boolean {
  const listed = git(["-C", root, "worktree", "list", "--porcelain"]);
  if (!listed.ok) die("could not list worktrees");
  return listed.out.split("\n\n").some((entry) => {
    const lines = entry.split("\n");
    return lines.includes(`worktree ${path}`) && lines.includes(`branch refs/heads/${branch}`);
  });
}

export function createWorktree(branch: string, cwd: string = process.cwd()): CreatedWorktree {
  if (!branch) die("branch name required");
  const root = repoRoot(cwd);
  const path = worktreePath(root, branch);

  if (isDirectory(path)) {
    if (!registeredWorktree(root, path, branch)) die(`${path} is not a registered worktree for ${branch}`);
    return { path, reused: true, setup: null };
  }
  const known = git(["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
  const add = known
    ? ["-C", root, "worktree", "add", path, branch]
    : ["-C", root, "worktree", "add", path, "-b", branch];
  if (!git(add).ok) die(`could not create a worktree at ${path}`);

  const initialTip = git(["-C", root, "rev-parse", `refs/heads/${branch}`]).out;
  try {
    return { path, reused: false, setup: bootstrap(path) };
  } catch (error) {
    const report = error instanceof WtError ? error.report : undefined;
    const changedTip = git(["-C", root, "rev-parse", `refs/heads/${branch}`]).out !== initialTip;
    if (!git(["-C", root, "worktree", "remove", "--force", path]).ok) {
      die(`bootstrap failed and could not remove the incomplete worktree at ${path}`, undefined, report);
    }
    if (!known && !changedTip && !git(["-C", root, "branch", "-D", branch]).ok) {
      die(`bootstrap failed and could not remove the incomplete branch ${branch}`, undefined, report);
    }
    if (changedTip)
      die(`bootstrap failed; branch ${branch} kept because setup changed it`, undefined, report);
    throw error;
  }
}

export function removeWorktree(
  branch: string,
  options: { force?: boolean; cwd?: string } = {},
): RemovedWorktree {
  if (!branch) die("branch name required");
  const force = options.force ?? false;
  const root = repoRoot(options.cwd);
  const path = worktreePath(root, branch);
  if (!isDirectory(path)) die(`no worktree at ${path}`, { code: "worktree_missing" });
  if (!registeredWorktree(root, path, branch)) die(`${path} is not a registered worktree for ${branch}`);

  const report = teardown(root, path, force);
  const args = force
    ? ["-C", root, "worktree", "remove", "--force", path]
    : ["-C", root, "worktree", "remove", path];
  if (!git(args).ok) die(`could not remove the worktree at ${path}`, undefined, report ?? undefined);
  return { path, teardown: report };
}

export function taskWorktrees(root: string): { branch: string; path: string }[] {
  const dir = worktreesDir(root);
  if (!isDirectory(dir)) return [];
  const listed = git(["-C", root, "worktree", "list", "--porcelain"]);
  if (!listed.ok) die("could not list worktrees");
  const found: { branch: string; path: string }[] = [];
  let at = "";
  for (const line of listed.out.split("\n")) {
    if (line.startsWith("worktree ")) at = line.slice("worktree ".length);
    else if (line.startsWith("branch ") && at.startsWith(`${dir}/`)) {
      found.push({ branch: line.slice("branch ".length).replace("refs/heads/", ""), path: at });
    }
  }
  return found;
}

export function pruneWorktrees(root: string): void {
  git(["-C", root, "worktree", "prune"]);
}
