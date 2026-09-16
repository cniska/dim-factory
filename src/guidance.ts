import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Env, resolveHomeDir } from "./paths";

/** The rules files an agent reads. Skills are versioned already, by `skill_load`. */
const NAMES = ["AGENTS.md", "CLAUDE.md"];

const FIELD = "";
const RECORD = "";

export type GuidanceReport = { files: number; versions: number };

function git(args: string[], cwd: string): string | null {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return proc.success ? new TextDecoder().decode(proc.stdout) : null;
}

/**
 * Each commit that touched the file, with the blob it left behind. `--raw` names
 * the new blob on the change line, so the whole history costs one `git log`
 * rather than a `rev-parse` per commit.
 */
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
      // :<oldmode> <newmode> <oldblob> <newblob> <status>\t<path>
      const m = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) /.exec(line);
      if (m?.[1] && !/^0+$/.test(m[1])) {
        versions.push({ sha: m[1], ts: new Date(ts).toISOString() });
        break;
      }
    }
  }
  return versions;
}

/**
 * Records every version it can see: git history for a file inside a repo, and a
 * content hash for one outside — `~/.claude/CLAUDE.md` is not version-controlled,
 * so each sync is the only chance to record what it said at that moment.
 */
export function ingestGuidance(db: Database, env: Env = process.env): GuidanceReport {
  const repos = db
    .prepare<{ repo: string }, []>("SELECT DISTINCT repo FROM repo_commit")
    .all()
    .map((r) => r.repo);

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

    // Outside any repo, so git holds no history and only this moment is knowable.
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
