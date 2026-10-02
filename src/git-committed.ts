import { hasCommit, nulFields, ranRaw } from "./git";

export type CommittedTree = {
  has(path: string): boolean;
  read(path: string, maxBytes?: number): string | null;
};

const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

export function committedTree(root: string, at: string, paths: readonly string[]): CommittedTree | null {
  if (!hasCommit(root, at)) return null;
  const listed = ranRaw(root, ["ls-tree", "-l", "-z", at, "--", ...paths]);
  const entries = new Map<string, { mode: string; oid: string; size: number }>();
  for (const entry of nulFields(listed, "git ls-tree -l -z")) {
    const [meta = "", path = ""] = entry.split("\t");
    const [mode = "", , oid = "", size = ""] = meta.split(/\s+/);
    entries.set(path, { mode, oid, size: Number(size) });
  }
  return {
    has: (path) => entries.has(path),
    read: (path, maxBytes = Number.POSITIVE_INFINITY) => {
      const entry = entries.get(path);
      if (!entry || !REGULAR_FILE_MODES.has(entry.mode) || entry.size > maxBytes) return null;
      return ranRaw(root, ["cat-file", "blob", entry.oid]);
    },
  };
}
