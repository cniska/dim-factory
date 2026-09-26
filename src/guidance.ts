import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Env, resolveHomeDir } from "./paths";

const NAMES = ["AGENTS.md", "CLAUDE.md"];

const FIELD = "";
const RECORD = "";

export type GuidanceReport = { files: number; versions: number };

function git(args: string[], cwd: string): string | null {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return proc.success ? new TextDecoder().decode(proc.stdout) : null;
}

export function versionsFromGit(repo: string, name: string): { sha: string; ts: string }[] {
  const out = git(["log", `--format=${RECORD}%H${FIELD}%aI`, "--raw", "--no-renames", "--", name], repo);
  if (!out) return [];
  const versions: { sha: string; ts: string }[] = [];
  for (const block of out.split(RECORD)) {
    if (!block.trim()) continue;
    const [header = "", ...rest] = block.split("\n");
    const ts = header.split(FIELD)[1];
    if (!ts) continue;
    for (const line of rest) {
      const m = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) /.exec(line);
      if (m?.[1] && !/^0+$/.test(m[1])) {
        versions.push({ sha: m[1], ts: new Date(ts).toISOString() });
        break;
      }
    }
  }
  return versions;
}

export function ingestGuidance(db: Database, env: Env = process.env): GuidanceReport {
  const repos = db
    .prepare<{ repo: string }, []>("SELECT DISTINCT repo FROM repo_commit")
    .all()
    .map((r) => r.repo)
    .filter((repo) => existsSync(repo));

  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO guidance_version (path, blob_sha, first_seen, last_seen, bytes, source)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path, blob_sha) DO UPDATE SET
       first_seen = min(guidance_version.first_seen, excluded.first_seen),
       last_seen  = max(guidance_version.last_seen, excluded.last_seen),
       bytes      = coalesce(excluded.bytes, guidance_version.bytes)`,
  );

  const report: GuidanceReport = { files: 0, versions: 0 };
  db.transaction(() => {
    for (const repo of repos) {
      for (const name of NAMES) {
        const versions = versionsFromGit(repo, name);
        if (versions.length === 0) continue;
        report.files += 1;
        const path = join(repo, name);
        for (const v of versions) {
          upsert.run(path, v.sha, v.ts, v.ts, null, "git");
          report.versions += 1;
        }
      }
    }

    for (const path of [join(resolveHomeDir(env), ".claude", "CLAUDE.md")]) {
      if (!existsSync(path)) continue;
      const body = readFileSync(path);
      const sha = new Bun.CryptoHasher("sha256").update(body).digest("hex");
      upsert.run(path, sha, now, now, statSync(path).size, "snapshot");
      report.files += 1;
      report.versions += 1;
    }
  })();
  return report;
}
