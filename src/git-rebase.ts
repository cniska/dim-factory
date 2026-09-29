import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { factoryCommitEnv, UNSIGNED } from "./git-identity";
import { fail, type Replay, type Rewrite } from "./git-rebase-contract";
import { hooksOutsideTree } from "./git-tree";

function git(dir: string, args: string[]): { ok: boolean; out: string; err: string } {
  const run = Bun.spawnSync(["git", "-C", dir, ...UNSIGNED, ...args], {
    env: { ...factoryCommitEnv(), GIT_EDITOR: "true" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: run.success, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() };
}

function read(dir: string, args: string[]): string {
  const run = git(dir, args);
  if (!run.ok) throw fail("git_failed", { dir, args, stderr: run.err });
  return run.out;
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
    throw fail("rebase_unrestored", {
      worktree: rewrite.worktree,
      oldHead: rewrite.oldHead,
      stderr: reset.err,
    });
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
  if (!run.success) throw fail("git_failed", { dir: worktree, args, stderr: run.stderr.toString().trim() });
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
  const args = ["show", `${revision}:${path}`];
  const shown = Bun.spawnSync(["git", "-C", worktree, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!shown.success)
    throw fail("git_failed", { dir: worktree, args, stderr: shown.stderr.toString().trim() });
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
  if (!abort.ok) throw fail("rebase_unaborted", { worktree, stderr: abort.err });
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
  throw fail("rebase_failed", { worktree, stderr: run.err });
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
    throw fail("rebase_unpaired", { worktree, from: from.length, to: to.length });
  }
  const args = ["range-diff", "--no-color", `${oldBase}..${oldHead}`, `${newBase}..${newHead}`];
  const rangeDiff = git(worktree, args);
  if (!rangeDiff.ok) {
    restoreBranch(replay);
    throw fail("git_failed", { dir: worktree, args, stderr: rangeDiff.err });
  }
  return {
    ...replay,
    newHead,
    commits: from.map((sha, index) => ({ from: sha, to: to[index] as string })),
    patchEqual: patchesEqual(rangeDiff.out),
  };
}

export function branchWorktree(root: string, branch: string): string | null {
  const records = read(root, ["worktree", "list", "--porcelain", "-z"]).split("\0\0");
  for (const record of records) {
    const fields = record.split("\0");
    if (fields.includes(`branch refs/heads/${branch}`)) {
      return fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length) ?? null;
    }
  }
  return null;
}

export function replayBase(worktree: string, trunk: string, tip: string): Replay {
  return {
    worktree,
    oldBase: read(worktree, ["merge-base", `refs/heads/${trunk}`, tip]),
    newBase: read(worktree, ["rev-parse", `refs/heads/${trunk}^{commit}`]),
    oldHead: tip,
  };
}

export function worktreeClean(worktree: string): boolean {
  return read(worktree, ["status", "--porcelain"]) === "";
}
