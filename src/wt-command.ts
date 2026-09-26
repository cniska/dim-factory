import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { warn } from "./warn";
import { runWorkerHook, type WorkerEnvironmentPhase, type WorkerHookReport } from "./worker-environment";

const USAGE = `wt — parallel-task worktrees, one per agent.

Usage:
  dim wt <branch>      create (or reuse) a worktree and print its path
  dim wt ls            list this repo's task worktrees
  dim wt path <branch> print the worktree path (for \`cd "$(dim wt path x)"\`)
  dim wt rm [--force] <branch>
                       remove the worktree
  dim wt prune         prune stale worktree admin entries

Worktrees live at <repo>/.claude/worktrees/<branch>. On creation, wt runs the
repo's scripts/worktree-setup.sh if present (dependency install, etc.); on
removal it runs the primary checkout's scripts/worktree-teardown.sh inside the
worktree first, and keeps the worktree if that fails unless --force.`;

export class WtError extends Error {}

function hookStatus(proc: { exitCode: number | null }): number {
  return proc.exitCode ?? 128;
}

function die(message: string): never {
  throw new WtError(message);
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

function reportHook(report: WorkerHookReport): void {
  if (report.stdout) process.stdout.write(report.stdout);
  if (report.stderr) process.stderr.write(report.stderr);
  console.log(`wt: ${report.phase} report ${JSON.stringify(report)}`);
}

function runHook(hook: string, phase: WorkerEnvironmentPhase, cwd: string): WorkerHookReport {
  const report = runWorkerHook(phase, hook, cwd);
  reportHook(report);
  return report;
}

function bootstrap(path: string): void {
  const hook = join(path, "scripts", "worktree-setup.sh");
  if (!isExecutable(hook)) return;
  console.log("wt: bootstrapping worktree via scripts/worktree-setup.sh");
  const rc = hookStatus(runHook(hook, "setup", path));
  if (rc === 0) console.log("wt: bootstrap complete");
  else warn(`wt: bootstrap failed (exit ${rc}) — worktree created; fix and re-run the hook`);
}

function teardown(root: string, path: string, force: boolean): void {
  const hook = join(root, "scripts", "worktree-teardown.sh");
  if (!isExecutable(hook)) return;
  console.log("wt: tearing down worktree via scripts/worktree-teardown.sh");
  const rc = hookStatus(runHook(hook, "teardown", path));
  if (rc === 0) return;
  if (!force) die(`teardown failed (exit ${rc}) — worktree kept; fix it, or re-run with --force`);
  warn(`wt: teardown failed (exit ${rc}) — removing anyway (--force)`);
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function worktreesDir(root: string): string {
  return join(root, ".claude", "worktrees");
}

export function worktreePath(root: string, branch: string): string {
  return join(worktreesDir(root), branch);
}

export function createWorktree(branch: string, cwd: string = process.cwd()): string {
  if (!branch) die("branch name required");
  const root = repoRoot(cwd);
  const path = worktreePath(root, branch);

  let created = false;
  if (isDirectory(path)) {
    console.log(`wt: reusing existing worktree ${path}`);
  } else {
    const known = git(["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
    const add = known
      ? ["-C", root, "worktree", "add", path, branch]
      : ["-C", root, "worktree", "add", path, "-b", branch];
    if (!git(add).ok) die(`could not create a worktree at ${path}`);
    created = true;
  }

  if (created) bootstrap(path);
  return path;
}

function open(branch: string): void {
  const path = createWorktree(branch);
  console.log("wt: worktree ready at:");
  console.log(`    ${path}`);
}

function list(): void {
  const root = repoRoot();
  const dir = worktreesDir(root);
  if (!isDirectory(dir)) {
    console.log("wt: no task worktrees");
    return;
  }
  const listed = git(["-C", root, "worktree", "list", "--porcelain"]);
  if (!listed.ok) die("could not list worktrees");
  const out = listed.out;
  let at = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) at = line.slice("worktree ".length);
    else if (line.startsWith("branch ")) {
      const branch = line.slice("branch ".length).replace("refs/heads/", "");
      if (at.startsWith(`${dir}/`)) console.log(`  ${branch.padEnd(24)} ${at}`);
    }
  }
}

export function removeWorktree(branch: string, options: { force?: boolean; cwd?: string } = {}): void {
  if (!branch) die("branch name required");
  const force = options.force ?? false;
  const root = repoRoot(options.cwd);
  const path = worktreePath(root, branch);
  if (!isDirectory(path)) die(`no worktree at ${path}`);

  teardown(root, path, force);
  const args2 = force
    ? ["-C", root, "worktree", "remove", "--force", path]
    : ["-C", root, "worktree", "remove", path];
  if (!git(args2).ok) die(`could not remove the worktree at ${path}`);
  console.log(`wt: removed worktree ${path}`);
  console.log(`wt: branch '${branch}' kept — delete with 'git -C ${root} branch -d ${branch}' once merged`);
}

function remove(args: string[]): void {
  let force = false;
  let branch = "";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--force" || arg === "-f") force = true;
    else if (arg === "--") {
      branch = args[i + 1] ?? "";
      break;
    } else if (arg.startsWith("-")) die(`unknown rm option: ${arg}`);
    else {
      if (branch) die("branch name specified more than once");
      branch = arg;
    }
  }
  removeWorktree(branch, { force });
}

export function runWt(args: string[]): void {
  const [command, ...rest] = args;
  switch (command) {
    case undefined:
    case "":
    case "-h":
    case "--help":
    case "help":
      console.log(USAGE);
      return;
    case "ls":
      list();
      return;
    case "path": {
      const branch = rest[0] ?? "";
      if (!branch) die("branch name required");
      console.log(join(worktreesDir(repoRoot()), branch));
      return;
    }
    case "rm":
      remove(rest);
      return;
    case "prune":
      git(["-C", repoRoot(), "worktree", "prune"]);
      console.log("wt: pruned stale worktree entries");
      return;
    default:
      open(command);
      return;
  }
}
