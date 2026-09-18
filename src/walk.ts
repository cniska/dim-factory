import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { codexDir, type Env, resolveHomeDir } from "./paths";
import { walkSpoolDir } from "./spool";
import type { Tool } from "./tools";

/** The rules file names a repo carries, as `guidance_version` already tracks them. */
const NAMES = ["CLAUDE.md", "AGENTS.md"];

/**
 * An import is a line that is nothing but `@<path>`, resolved against the
 * directory of the file that names it. Matching `@` anywhere in a line would
 * claim an email address or a handle is a surface.
 */
const IMPORT_LINE = /^\s*@(\S+)\s*$/;

export type Surface = {
  path: string;
  sha: string;
  /** The file whose import pulled this one in; null for a surface read on its own. */
  importedBy: string | null;
};

function sha256(body: Buffer): string {
  return new Bun.CryptoHasher("sha256").update(body).digest("hex");
}

function gitToplevel(cwd: string): string | null {
  const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!proc.success) return null;
  const out = new TextDecoder().decode(proc.stdout).trim();
  return out === "" ? null : out;
}

/** Every directory from the working directory up to the repo root, innermost first. */
function repoDirs(cwd: string): string[] {
  const top = gitToplevel(cwd);
  if (!top) return [cwd];
  const dirs: string[] = [];
  for (let dir = resolve(cwd); dir.startsWith(top); dir = dirname(dir)) {
    dirs.push(dir);
    if (dir === top) break;
  }
  return dirs;
}

function userSurface(tool: Tool, env: Env): string {
  return tool === "claude"
    ? join(resolveHomeDir(env), ".claude", "CLAUDE.md")
    : join(codexDir(env), "AGENTS.md");
}

/**
 * Which rules files were in force together at this session's start, and which
 * one imported which. `guidance_version` records what each file said; this
 * records that they were read as one set, which nothing else holds — the same
 * project file governs different work depending on what sat above it.
 *
 * Read at session start, so a rules file edited mid-session is missed. That is
 * the granularity the channel has, not a gap worth a per-turn capture.
 */
export function resolveWalk(tool: Tool, cwd: string, env: Env = process.env): Surface[] {
  const roots = [userSurface(tool, env)];
  for (const dir of repoDirs(cwd)) for (const name of NAMES) roots.push(join(dir, name));

  const surfaces: Surface[] = [];
  const seen = new Set<string>();
  const queue: { path: string; importedBy: string | null }[] = roots.map((path) => ({
    path,
    importedBy: null,
  }));

  while (queue.length > 0) {
    const next = queue.shift() as { path: string; importedBy: string | null };
    if (seen.has(next.path) || !existsSync(next.path)) continue;
    seen.add(next.path);

    let body: Buffer;
    try {
      body = readFileSync(next.path);
    } catch {
      continue;
    }
    surfaces.push({ path: next.path, sha: sha256(body), importedBy: next.importedBy });

    for (const line of body.toString("utf8").split("\n")) {
      const spec = IMPORT_LINE.exec(line)?.[1];
      if (spec) queue.push({ path: resolve(dirname(next.path), spec), importedBy: next.path });
    }
  }
  return surfaces;
}

export type WalkRecord = {
  session_id: string;
  tool: Tool;
  seen_at: string;
  surfaces: Surface[];
};

/**
 * Written from the session-start hook rather than into the database, because a
 * hook that waits on the write lock delays every session that starts here.
 * `sync` drains it under the lock it already holds.
 */
export function spoolWalk(record: WalkRecord, env: Env = process.env): void {
  if (record.surfaces.length === 0) return;
  const dir = walkSpoolDir(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${Date.now()}-${process.pid}.json`), JSON.stringify(record));
}

export type WalkReport = { sessions: number; surfaces: number };

/** Each file is the only copy of what was in force at that moment, so one that cannot be placed stays. */
export function drainWalk(db: Database, env: Env = process.env): WalkReport {
  const dir = walkSpoolDir(env);
  mkdirSync(dir, { recursive: true });
  const report: WalkReport = { sessions: 0, surfaces: 0 };

  const insert = db.prepare(
    `INSERT INTO guidance_walk (session_id, tool, seen_at, path, blob_sha, imported_by)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    let record: WalkRecord;
    try {
      record = JSON.parse(readFileSync(path, "utf8")) as WalkRecord;
    } catch {
      continue;
    }
    if (!record.session_id || !Array.isArray(record.surfaces)) continue;
    db.transaction(() => {
      for (const s of record.surfaces) {
        insert.run(record.session_id, record.tool, record.seen_at, s.path, s.sha, s.importedBy);
        report.surfaces += 1;
      }
    })();
    report.sessions += 1;
    unlinkSync(path);
  }
  return report;
}
