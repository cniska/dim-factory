import { spawnSync } from "node:child_process";
import { refuseGit } from "./git-contract";

export type CommittedTree = {
  has(path: string): boolean;
  read(path: string, maxBytes?: number): string | null;
};

const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

function git(root: string, args: string[]): { status: number | null; out: string; err: string } {
  const run = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: run.status, out: run.stdout, err: run.stderr.trim() };
}

export function committedTree(root: string, at: string, paths: readonly string[]): CommittedTree | null {
  const commit = git(root, ["rev-parse", "--verify", "-q", `${at}^{commit}`]);
  if (commit.status === 1) return null;
  if (commit.status !== 0) throw refuseGit("git_unreadable", { root, what: at, detail: commit.err });
  const listed = git(root, ["ls-tree", "-l", "-z", at, "--", ...paths]);
  if (listed.status !== 0) {
    throw refuseGit("git_unreadable", {
      root,
      what: `the listing of ${paths.join(", ")} at ${at}`,
      detail: listed.err,
    });
  }
  const entries = new Map<string, { mode: string; oid: string; size: number }>();
  for (const entry of listed.out.split("\0").filter(Boolean)) {
    const [meta = "", path = ""] = entry.split("\t");
    const [mode = "", , oid = "", size = ""] = meta.split(/\s+/);
    entries.set(path, { mode, oid, size: Number(size) });
  }
  return {
    has: (path) => entries.has(path),
    read: (path, maxBytes = Number.POSITIVE_INFINITY) => {
      const entry = entries.get(path);
      if (!entry || !REGULAR_FILE_MODES.has(entry.mode) || entry.size > maxBytes) return null;
      const shown = git(root, ["cat-file", "blob", entry.oid]);
      if (shown.status !== 0)
        throw refuseGit("git_unreadable", { root, what: `${path} at ${at}`, detail: shown.err });
      return shown.out;
    },
  };
}
