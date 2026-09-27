import { reachesTrunk } from "./git-trunk";
import { removeWorktree, repoRoot } from "./wt-command";

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const run = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: run.success, out: (run.success ? run.stdout : run.stderr).toString().trim() };
}

export function removeShippedBranch(branch: string, cwd: string): void {
  const root = repoRoot(cwd);
  removeWorktree(branch, { cwd: root });
  const tip = git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).out;
  if (reachesTrunk(root, tip).reach !== "reached") return;
  const deleted = git(root, ["branch", "-D", branch]);
  if (!deleted.ok) throw new Error(`could not delete the branch ${branch}: ${deleted.out}`);
}
