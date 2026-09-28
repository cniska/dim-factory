import type { Command } from "./cli-contract";
import { warn } from "./cli-warn";
import type { WorkerHookReport } from "./worker-environment";
import {
  createWorktree,
  pruneWorktrees,
  removeWorktree,
  repoRoot,
  taskWorktrees,
  WtError,
  worktreePath,
} from "./worktree";

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
setup failure, it removes the incomplete worktree and a new branch unless setup
changed its tip. On removal it runs the primary checkout's
scripts/worktree-teardown.sh inside the
worktree first, and keeps the worktree if that fails unless --force.`;

function printReport(report: WorkerHookReport): void {
  if (report.stdout) process.stdout.write(report.stdout);
  if (report.stderr) process.stderr.write(report.stderr);
  console.log(`wt: ${report.phase} report ${JSON.stringify(report)}`);
}

function printSetup(report: WorkerHookReport): void {
  console.log("wt: bootstrapping worktree via scripts/worktree-setup.sh");
  printReport(report);
}

function printTeardown(report: WorkerHookReport): void {
  console.log("wt: tearing down worktree via scripts/worktree-teardown.sh");
  printReport(report);
}

function open(branch: string): void {
  let created: ReturnType<typeof createWorktree>;
  try {
    created = createWorktree(branch);
  } catch (error) {
    if (error instanceof WtError && error.report) printSetup(error.report);
    throw error;
  }
  if (created.reused) console.log(`wt: reusing existing worktree ${created.path}`);
  if (created.setup) {
    printSetup(created.setup);
    console.log("wt: bootstrap complete");
  }
  console.log("wt: worktree ready at:");
  console.log(`    ${created.path}`);
}

function list(): void {
  const worktrees = taskWorktrees(repoRoot());
  if (worktrees.length === 0) {
    console.log("wt: no task worktrees");
    return;
  }
  for (const { branch, path } of worktrees) console.log(`  ${branch.padEnd(24)} ${path}`);
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
    } else if (arg.startsWith("-")) throw new WtError(`unknown rm option: ${arg}`);
    else {
      if (branch) throw new WtError("branch name specified more than once");
      branch = arg;
    }
  }
  const root = repoRoot();
  let removed: ReturnType<typeof removeWorktree>;
  try {
    removed = removeWorktree(branch, { force, cwd: root });
  } catch (error) {
    if (error instanceof WtError && error.report) printTeardown(error.report);
    throw error;
  }
  if (removed.teardown) {
    printTeardown(removed.teardown);
    const rc = removed.teardown.exitCode ?? 128;
    if (rc !== 0) warn(`wt: teardown failed (exit ${rc}) — removing anyway (--force)`);
  }
  console.log(`wt: removed worktree ${removed.path}`);
  console.log(`wt: branch '${branch}' kept — delete with 'git -C ${root} branch -d ${branch}' once merged`);
}

export const wtCommand: Command = {
  name: "wt",
  usage:
    "usage: dim wt <branch> | dim wt ls | dim wt path <branch> | dim wt rm [--force] <branch> | dim wt prune",
  summary: "parallel-task worktrees, one per agent",
  raw: () => true,
  run(args) {
    try {
      runWt(args);
    } catch (error) {
      if (!(error instanceof WtError)) throw error;
      warn(`wt: ${error.message}`);
      process.exit(1);
    }
  },
};

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
      if (!branch) throw new WtError("branch name required");
      console.log(worktreePath(repoRoot(), branch));
      return;
    }
    case "rm":
      remove(rest);
      return;
    case "prune":
      pruneWorktrees(repoRoot());
      console.log("wt: pruned stale worktree entries");
      return;
    default:
      open(command);
      return;
  }
}
