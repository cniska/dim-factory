import type { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { writeTransaction } from "./db";
import { TOOLS, type Tool } from "./ingest-tools";
import { dataDir, type Env } from "./paths";

export type DrainReport = { applied: number; duplicate: number; unreadable: number };

const SPOOL_NAME = /^(\d{10,})-([A-Za-z0-9]+)(?:-(\d+)-([A-Za-z0-9-]*))?(?:-([A-Za-z0-9-]*))?\.json$/;

export function spoolDir(env: Env = process.env): string {
  return join(dataDir(env), "spool");
}

export function toolSpoolDir(tool: Tool, env: Env = process.env): string {
  return join(spoolDir(env), tool);
}

export function walkSpoolDir(env: Env = process.env): string {
  return join(spoolDir(env), "walk");
}

export function setAsideUnreadable(path: string, env: Env = process.env): void {
  renameSync(path, join(spoolDir(env), "unreadable", basename(path)));
}

export function ensureSpoolDirs(env: Env = process.env): void {
  for (const tool of TOOLS) {
    mkdirSync(toolSpoolDir(tool, env), { recursive: true });
  }
  mkdirSync(walkSpoolDir(env), { recursive: true });
  mkdirSync(join(spoolDir(env), "unreadable"), { recursive: true });
}

type HookPayload = {
  session_id?: string;
  hook_event_name?: string;
  cwd?: string;
  source?: string;
  reason?: string;
  model?: string;
};

function text(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventOf(
  payload: HookPayload | undefined,
): "session_start" | "session_end" | "post_tool_use" | undefined {
  const name = payload?.hook_event_name;
  if (name === "SessionStart") return "session_start";
  if (name === "SessionEnd") return "session_end";
  if (name === "PostToolUse") return "post_tool_use";
  return undefined;
}

export function drainSpool(db: Database, env: Env = process.env): DrainReport {
  ensureSpoolDirs(env);
  const report: DrainReport = { applied: 0, duplicate: 0, unreadable: 0 };

  const insert = db.prepare(
    `INSERT INTO hook_event (tool, session_id, event, ts, harness_pid, source, reason, model, cwd, payload)
     VALUES ($tool, $sessionId, $event, $ts, $harnessPid, $source, $reason, $model, $cwd, $payload)
     ON CONFLICT(session_id, event, ts) DO NOTHING`,
  );
  const drained: string[] = [];
  writeTransaction(db, () => {
    for (const tool of TOOLS) {
      const dir = toolSpoolDir(tool, env);
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        const match = SPOOL_NAME.exec(name);
        let payload: HookPayload | undefined;
        let raw = "";
        if (match) {
          try {
            raw = readFileSync(path, "utf8");
            payload = JSON.parse(raw) as HookPayload;
          } catch {
            payload = undefined;
          }
        }
        const event = eventOf(payload);
        const sessionId = text(payload?.session_id);
        if (!match || !sessionId || !event) {
          setAsideUnreadable(path, env);
          report.unreadable += 1;
          continue;
        }
        const ts = new Date(Number(match[1]) / 1e6).toISOString();
        const changes = insert.run({
          $tool: tool,
          $sessionId: sessionId,
          $event: event,
          $ts: ts,
          $harnessPid: event === "session_start" && match[3] ? Number(match[3]) : null,
          $source: payload?.source ?? null,
          $reason: payload?.reason ?? null,
          $model: text(payload?.model) ?? null,
          $cwd: payload?.cwd ?? null,
          $payload: raw,
        });
        if (changes.changes === 0) report.duplicate += 1;
        else report.applied += 1;
        drained.push(path);
      }
    }
  });
  for (const path of drained) unlinkSync(path);
  return report;
}

export function applyHookEvents(db: Database): void {
  const lastEnd = `FROM hook_event h
    WHERE h.session_id = session.id AND h.event = 'session_end'
      AND NOT EXISTS (SELECT 1 FROM hook_event resumed
                      WHERE resumed.session_id = h.session_id AND resumed.event = 'session_start'
                        AND resumed.ts > h.ts)`;
  db.run(`
    UPDATE session SET
      ended_at = (SELECT max(h.ts) ${lastEnd}),
      end_reason = (SELECT h.reason ${lastEnd} ORDER BY h.ts DESC LIMIT 1)
    WHERE EXISTS (SELECT 1 FROM hook_event h
                  WHERE h.session_id = session.id AND h.event = 'session_end')
  `);
}
