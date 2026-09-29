import { reachesTrunk } from "./git-trunk";
import type { ShipTeardown } from "./ship-contract";
import type { WorkerHookReport } from "./worker-environment";
import { removeWorktree, repoRoot, WtError } from "./worktree";

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const run = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: run.success, out: (run.success ? run.stdout : run.stderr).toString().trim() };
}

function branchKept(root: string, branch: string): string | undefined {
  const tip = git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  if (!tip.ok) return undefined;
  const trunk = reachesTrunk(root, tip.out);
  if (trunk.reach === "unknown") return trunk.why;
  if (trunk.reach !== "reached") return `its tip ${tip.out} has not landed on the default branch`;
  const deleted = git(root, ["branch", "-D", branch]);
  if (!deleted.ok) return `git refused to delete it: ${deleted.out.split("\n")[0]}`;
  return undefined;
}

export function removeShippedBranch(branch: string, cwd: string): ShipTeardown {
  const root = repoRoot(cwd);
  let teardown: WorkerHookReport | undefined;
  try {
    teardown = removeWorktree(branch, { cwd: root }).teardown ?? undefined;
  } catch (error) {
    if (!(error instanceof WtError)) throw error;
    if (error.failure?.code !== "worktree_missing") {
      const worktreeKept =
        error.failure?.code === "teardown_failed"
          ? `its teardown hook exited ${error.failure.exitCode}`
          : error.message;
      return { worktreeKept, branchKept: "its worktree still holds it", teardown: error.report };
    }
  }
  const kept = branchKept(root, branch);
  return { ...(kept === undefined ? {} : { branchKept: kept }), teardown };
}
