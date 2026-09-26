import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ShipRefusal } from "./ship-refusal";
import { hooksOutsideTree, nestedRepository } from "./station-build-tree";

export type Replay = { worktree: string; oldBase: string; newBase: string; oldHead: string };

export type Rewrite = Replay & {
  newHead: string;
  commits: { from: string; to: string }[];
  patchEqual: boolean;
};

export class RebaseConflict extends ShipRefusal {
  constructor(
    readonly replay: Replay,
    readonly paths: string[],
    readonly stoppedAt: string,
    message: string,
  ) {
    super("ship_rebase_conflict", message);
  }
}

function git(dir: string, args: string[]): { ok: boolean; out: string; err: string } {
  const run = Bun.spawnSync(["git", "-C", dir, ...args], {
    env: { ...process.env, GIT_EDITOR: "true" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: run.success, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() };
}

function read(dir: string, args: string[]): string {
  const run = git(dir, args);
  if (!run.ok) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${run.err}`);
  return run.out;
}

function branchWorktree(root: string, branch: string): string | null {
  const records = read(root, ["worktree", "list", "--porcelain", "-z"]).split("\0\0");
  for (const record of records) {
    const fields = record.split("\0");
    if (fields.includes(`branch refs/heads/${branch}`)) {
      return fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length) ?? null;
    }
  }
  return null;
}

function commitsIn(dir: string, base: string, head: string): string[] {
  return read(dir, ["rev-list", "--reverse", `${base}..${head}`])
    .split("\n")
    .filter(Boolean);
}

export function patchesEqual(rangeDiff: string): boolean {
  const pairs = rangeDiff
    .split("\n")
    .map((line) => /^ {0,3}(?:\d+|-+): +(?:[0-9a-f]+|-+) ([=!<>]) /.exec(line)?.[1])
    .filter((mark) => mark !== undefined);
  return pairs.length > 0 && pairs.every((mark) => mark === "=");
}

export function restoreBranch(rewrite: Pick<Replay, "worktree" | "oldHead">): void {
  const reset = git(rewrite.worktree, ["reset", "-q", "--hard", rewrite.oldHead]);
  if (!reset.ok) {
    throw new Error(
      `the rebase could not be taken back, so ${rewrite.worktree} is not at ${rewrite.oldHead}: ${reset.err}`,
    );
  }
}

export function rebaseState(worktree: string): { origHead: string; onto: string; headName: string } | null {
  const dir = read(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge"]);
  if (!existsSync(dir)) return null;
  const field = (name: string) => readFileSync(join(dir, name), "utf8").trim();
  return { origHead: field("orig-head"), onto: field("onto"), headName: field("head-name") };
}

export function rebaseInProgress(worktree: string): boolean {
  return ["rebase-merge", "rebase-apply"].some((name) =>
    existsSync(read(worktree, ["rev-parse", "--path-format=absolute", "--git-path", name])),
  );
}

function pathsFrom(worktree: string, args: string[]): string[] {
  const run = Bun.spawnSync(["git", "-C", worktree, "-c", "core.quotePath=false", ...args, "-z"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!run.success)
    throw new Error(`git ${args.join(" ")} failed in ${worktree}: ${run.stderr.toString().trim()}`);
  return run.stdout.toString().split("\0").filter(Boolean);
}

export function conflictedPaths(worktree: string): string[] {
  return pathsFrom(worktree, ["diff", "--name-only", "--diff-filter=U"]);
}

export function changedPaths(worktree: string): string[] {
  return pathsFrom(worktree, ["diff", "HEAD", "--name-only"]);
}

const CONFLICT_MARKER = /^(?:<{7,}|\|{7,}|={7,}|>{7,})(?: |$)/;

export function stoppedPaths(worktree: string): string[] {
  const touched = pathsFrom(worktree, ["diff-tree", "--no-commit-id", "--name-only", "-r", "REBASE_HEAD"]);
  return [...new Set([...touched, ...changedPaths(worktree)])];
}

export function stoppedCommit(worktree: string): string {
  return read(worktree, ["rev-parse", "REBASE_HEAD"]);
}

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

function linesAt(worktree: string, revision: string, path: string): string[] {
  if (!git(worktree, ["rev-parse", "--verify", "--quiet", `${revision}:${path}`]).ok) return [];
  const shown = Bun.spawnSync(["git", "-C", worktree, "show", `${revision}:${path}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!shown.success)
    throw new Error(`cannot read ${path} at ${revision}: ${shown.stderr.toString().trim()}`);
  return lines(shown.stdout.toString());
}

function markerCounts(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines.filter((one) => CONFLICT_MARKER.test(one))) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

export function pathsAddingMarkers(worktree: string, paths: readonly string[]): string[] {
  return paths.filter((path) => {
    const file = join(worktree, path);
    if (!existsSync(file) || !lstatSync(file).isFile()) return false;
    const held = markerCounts(linesAt(worktree, "HEAD", path));
    const base = markerCounts(linesAt(worktree, "REBASE_HEAD^", path));
    for (const [line, count] of markerCounts(linesAt(worktree, "REBASE_HEAD", path))) {
      const added = count - (base.get(line) ?? 0);
      if (added > 0) held.set(line, (held.get(line) ?? 0) + added);
    }
    return [...markerCounts(lines(readFileSync(file, "utf8")))].some(
      ([line, count]) => count > (held.get(line) ?? 0),
    );
  });
}

function abortRebase(worktree: string): void {
  const abort = git(worktree, ["rebase", "--abort"]);
  if (!abort.ok) throw new Error(`the rebase in ${worktree} could not be aborted: ${abort.err}`);
}

function replayStep(worktree: string, args: string[]): { done: true } | { conflicts: string[] } {
  const run = git(worktree, [
    "-c",
    `core.hooksPath=${hooksOutsideTree(worktree)}`,
    "-c",
    "rerere.enabled=false",
    ...args,
  ]);
  if (run.ok && rebaseState(worktree) === null) return { done: true };
  let conflicts: string[];
  try {
    conflicts = conflictedPaths(worktree);
  } catch (error) {
    abortRebase(worktree);
    throw error;
  }
  if (conflicts.length > 0) return { conflicts };
  if (rebaseState(worktree) !== null) abortRebase(worktree);
  throw new ShipRefusal("ship_rebase_failed", `git could not rebase in ${worktree}: ${run.err}`);
}

export function startReplay(worktree: string, onto: string): { done: true } | { conflicts: string[] } {
  return replayStep(worktree, [
    "rebase",
    "--quiet",
    "--reapply-cherry-picks",
    "--empty=keep",
    "--no-autosquash",
    "--no-autostash",
    onto,
  ]);
}

export function continueReplay(worktree: string): { done: true } | { conflicts: string[] } {
  return replayStep(worktree, ["rebase", "--continue"]);
}

export function pairRewrite(replay: Replay): Rewrite {
  const { worktree, oldBase, newBase, oldHead } = replay;
  const newHead = read(worktree, ["rev-parse", "HEAD"]);
  const from = commitsIn(worktree, oldBase, oldHead);
  const to = commitsIn(worktree, newBase, newHead);
  if (from.length !== to.length) {
    restoreBranch(replay);
    throw new ShipRefusal(
      "ship_rebase_unpaired",
      `the rebase in ${worktree} turned ${from.length} commits into ${to.length}, so no replayed commit can be paired with the one it replaced; the rebase was taken back`,
    );
  }
  const rangeDiff = git(worktree, [
    "range-diff",
    "--no-color",
    `${oldBase}..${oldHead}`,
    `${newBase}..${newHead}`,
  ]);
  if (!rangeDiff.ok) {
    restoreBranch(replay);
    throw new Error(`git range-diff could not compare the rebase in ${worktree}: ${rangeDiff.err}`);
  }
  return {
    ...replay,
    newHead,
    commits: from.map((sha, index) => ({ from: sha, to: to[index] as string })),
    patchEqual: patchesEqual(rangeDiff.out),
  };
}

export function rebaseOntoTrunk(root: string, branch: string, trunk: string, tip: string): Rewrite {
  const worktree = branchWorktree(root, branch);
  if (!worktree) {
    throw new ShipRefusal(
      "ship_no_worktree",
      `${branch} is not checked out in any worktree of ${root}, so there is nowhere to rebase it`,
    );
  }
  const nested = nestedRepository(worktree);
  if (nested) {
    throw new ShipRefusal(
      "ship_nested_repository",
      `${nested} is a git repository inside ${worktree}, which a rebase there would run git in`,
    );
  }
  if (read(worktree, ["status", "--porcelain"]) !== "") {
    throw new ShipRefusal(
      "ship_dirty_worktree",
      `${worktree} has uncommitted changes, which a rebase of ${branch} would have to carry`,
    );
  }
  const replay: Replay = {
    worktree,
    oldBase: read(worktree, ["merge-base", `refs/heads/${trunk}`, tip]),
    newBase: read(worktree, ["rev-parse", `refs/heads/${trunk}^{commit}`]),
    oldHead: tip,
  };
  const step = startReplay(worktree, replay.newBase);
  if ("conflicts" in step) {
    throw new RebaseConflict(
      replay,
      step.conflicts,
      stoppedCommit(worktree),
      `${branch} conflicts with ${trunk} in ${step.conflicts.join(", ")}; ${worktree} is left mid-rebase for the builder to resolve`,
    );
  }
  return pairRewrite(replay);
}
