import { existsSync } from "node:fs";
import { hasCommit, ran } from "./git";
import { checkoutRoot } from "./git-checkout";

export type Commit = {
  sha: string;
  repo: string;
  ts: string;
  author: string | null;
  subject: string;
  kind: string | null;
  files: string[];
};

const FIELD = "\x1f";
const RECORD = "\x1e";

export function commitKind(subject: string): string | null {
  const match = /^([a-z]+)(\([^)]*\))?!?:/.exec(subject);
  return match ? (match[1] as string) : null;
}

export function repoRoot(dir: string): string | null {
  if (!existsSync(dir) || checkoutRoot(dir) === null) return null;
  return ran(dir, ["rev-parse", "--show-toplevel"]);
}

export function readCommits(repo: string, since: string | null): Commit[] {
  if (!hasCommit(repo, "HEAD")) return [];
  const args = [
    "log",
    `--pretty=format:${RECORD}%H${FIELD}%aI${FIELD}%an${FIELD}%s`,
    "--name-only",
    "--no-merges",
    "--no-renames",
  ];
  if (since) args.push(`--since=${since}`);
  const out = ran(repo, args);

  const commits: Commit[] = [];
  for (const block of out.split(RECORD)) {
    if (!block.trim()) continue;
    const [header = "", ...rest] = block.split("\n");
    const [sha, ts, author, subject] = header.split(FIELD);
    if (!sha || !ts || subject === undefined) continue;
    commits.push({
      sha,
      repo,
      ts: new Date(ts).toISOString(),
      author: author || null,
      subject,
      kind: commitKind(subject),
      files: rest.map((l) => l.trim()).filter(Boolean),
    });
  }
  return commits;
}
