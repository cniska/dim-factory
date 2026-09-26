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
