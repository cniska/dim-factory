import type { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeTransaction } from "./db";
import { ensureSpoolDirs, setAsideUnreadable, walkSpoolDir } from "./ingest-spool";
import { TOOLS, type Tool } from "./ingest-tools";
import { codexDir, type Env, resolveHomeDir } from "./paths";
import { readManifest } from "./workspace-tasks";

const NAMES = ["CLAUDE.md", "AGENTS.md"];

const IMPORT_LINE = /^\s*@(\S+)\s*$/;

export type Surface = {
  path: string;
  sha: string;
  importedBy: string | null;
};

function sha256(body: string): string {
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
    if (seen.has(next.path)) continue;
    seen.add(next.path);

    const body = readManifest(next.path);
    if (body === null) continue;
    surfaces.push({ path: next.path, sha: sha256(body), importedBy: next.importedBy });

    for (const line of body.split("\n")) {
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

export function spoolWalk(record: WalkRecord, env: Env = process.env): void {
  if (record.surfaces.length === 0) return;
  const dir = walkSpoolDir(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${Date.now()}-${process.pid}.json`), JSON.stringify(record));
}

export type WalkReport = { sessions: number; surfaces: number; unreadable: number };

function isSurface(value: unknown): value is Surface {
  const surface = value as Surface;
  return (
    typeof surface?.path === "string" &&
    typeof surface.sha === "string" &&
    (surface.importedBy === null || typeof surface.importedBy === "string")
  );
}

function placeableWalk(path: string): WalkRecord | undefined {
  let record: WalkRecord;
  try {
    record = JSON.parse(readFileSync(path, "utf8")) as WalkRecord;
  } catch {
    return undefined;
  }
  const placeable =
    typeof record?.session_id === "string" &&
    record.session_id.length > 0 &&
    TOOLS.includes(record.tool) &&
    typeof record.seen_at === "string" &&
    Array.isArray(record.surfaces) &&
    record.surfaces.every(isSurface);
  return placeable ? record : undefined;
}

export function drainWalk(db: Database, env: Env = process.env): WalkReport {
  ensureSpoolDirs(env);
  const dir = walkSpoolDir(env);
  const report: WalkReport = { sessions: 0, surfaces: 0, unreadable: 0 };

  const insert = db.prepare(
    `INSERT INTO guidance_walk (session_id, tool, seen_at, path, blob_sha, imported_by)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );
  const drained: string[] = [];
  writeTransaction(db, () => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const record = placeableWalk(path);
      if (!record) {
        setAsideUnreadable(path, env);
        report.unreadable += 1;
        continue;
      }
      for (const s of record.surfaces) {
        insert.run(record.session_id, record.tool, record.seen_at, s.path, s.sha, s.importedBy);
        report.surfaces += 1;
      }
      report.sessions += 1;
      drained.push(path);
    }
  });
  for (const path of drained) unlinkSync(path);
  return report;
}
