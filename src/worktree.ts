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
 */
export const withoutWorktree = (col: string): string => `CASE
  WHEN instr(${col}, '${WORKTREE_SEGMENT}') > 0 THEN
    substr(${col}, 1, instr(${col}, '${WORKTREE_SEGMENT}') - 1) ||
    substr(substr(${col}, instr(${col}, '${WORKTREE_SEGMENT}') + ${WORKTREE_SEGMENT.length}),
           instr(substr(${col}, instr(${col}, '${WORKTREE_SEGMENT}') + ${WORKTREE_SEGMENT.length}), '/'))
  ELSE ${col} END`;
