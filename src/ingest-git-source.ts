import { existsSync } from "node:fs";

export type Commit = {
  sha: string;
  repo: string;
  ts: string;
  author: string | null;
  subject: string;
  kind: string | null;
  files: string[];
};

const FIELD = "";
const RECORD = "";

export function commitKind(subject: string): string | null {
  const match = /^([a-z]+)(\([^)]*\))?!?:/.exec(subject);
  return match ? (match[1] as string) : null;
}

function run(args: string[], cwd: string): string | null {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return proc.success ? new TextDecoder().decode(proc.stdout) : null;
}

export function repoRoot(dir: string): string | null {
  if (!existsSync(dir)) return null;
  return run(["rev-parse", "--show-toplevel"], dir)?.trim() || null;
}

export function readCommits(repo: string, since: string | null): Commit[] {
  const args = [
    "log",
    `--pretty=format:${RECORD}%H${FIELD}%aI${FIELD}%an${FIELD}%s`,
    "--name-only",
    "--no-merges",
    "--no-renames",
  ];
  if (since) args.push(`--since=${since}`);
  const out = run(args, repo);
  if (!out) return [];

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
