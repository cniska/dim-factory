/**
 * Task worktrees live at `<repo>/.claude/worktrees/<branch>` — the path Claude
 * Code's own worktree support uses, and the one `wt` creates. Everything here
 * reads that convention, so it is written once: a query that folds a worktree
 * onto its checkout and a session row that names one cannot disagree.
 */
export const WORKTREE_SEGMENT = "/.claude/worktrees/";

/** The worktree a path is inside, or null for a primary checkout. */
export function worktreeOf(path: string | null | undefined): string | null {
  if (!path) return null;
  const at = path.indexOf(WORKTREE_SEGMENT);
  if (at === -1) return null;
  const rest = path.slice(at + WORKTREE_SEGMENT.length);
  const name = rest.split("/")[0];
  return name && name.length > 0 ? name : null;
}

/**
 * The same fold in SQL, for the columns holding absolute paths. A worktree is a
 * second checkout of one repo, so `<repo>/.claude/worktrees/<name>/x` and
 * `<repo>/x` are one file; collapsing them keeps a file from competing with itself.
 *
 * A worktree root is the case with no tail to splice back on, and it reaches
 * here through `repo_commit.repo`, which names a checkout rather than a file.
 */
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
