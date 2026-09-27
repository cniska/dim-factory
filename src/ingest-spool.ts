import type { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeTransaction } from "./db";
import { TOOLS, type Tool } from "./ingest-tools";
import { dataDir, type Env } from "./paths";

export type DrainReport = { applied: number; duplicate: number; unreadable: number };

const SPOOL_NAME = /^(\d{10,})-([A-Za-z0-9]+)(?:-([A-Za-z0-9-]*))?\.json$/;

export function spoolDir(env: Env = process.env): string {
  return join(dataDir(env), "spool");
}

export function toolSpoolDir(tool: Tool, env: Env = process.env): string {
  return join(spoolDir(env), tool);
}

export function walkSpoolDir(env: Env = process.env): string {
  return join(spoolDir(env), "walk");
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
  sessionId?: string;
  hook_event_name?: string;
  hookEventName?: string;
  cwd?: string;
  source?: string;
  reason?: string;
  model?: string;
  modelId?: string;
};

function text(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventOf(
  payload: HookPayload | undefined,
): "session_start" | "session_end" | "post_tool_use" | undefined {
  const name = payload?.hook_event_name ?? payload?.hookEventName;
  if (name === "SessionStart" || name === "session_start") return "session_start";
  if (name === "SessionEnd" || name === "session_end") return "session_end";
  if (name === "PostToolUse" || name === "post_tool_use") return "post_tool_use";
  return undefined;
}

export function drainSpool(db: Database, env: Env = process.env): DrainReport {
  ensureSpoolDirs(env);
  const report: DrainReport = { applied: 0, duplicate: 0, unreadable: 0 };

  const insert = db.prepare(
    `INSERT INTO hook_event (tool, session_id, event, ts, source, reason, model, cwd, payload)
     VALUES ($tool, $sessionId, $event, $ts, $source, $reason, $model, $cwd, $payload)
     ON CONFLICT(session_id, event, ts) DO NOTHING`,
  );
  const sighting = db.prepare(
    `INSERT INTO factory_worker_session (worker, session_id, seen_at)
     SELECT $worker, $sessionId, $seenAt FROM factory_worker WHERE name = $worker
     ON CONFLICT DO NOTHING`,
  );

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
      const sessionId = text(payload?.session_id) ?? text(payload?.sessionId);
      if (!match || !sessionId || !event) {
        renameSync(path, join(spoolDir(env), "unreadable", name));
        report.unreadable += 1;
        continue;
      }
      const ts = new Date(Number(match[1]) / 1e6).toISOString();
      const worker = match[3];
      if (worker) {
        sighting.run({ $worker: worker, $sessionId: sessionId, $seenAt: ts });
      }
      const changes = writeTransaction(db, () =>
        insert.run({
          $tool: tool,
          $sessionId: sessionId,
          $event: event,
          $ts: ts,
          $source: payload?.source ?? null,
          $reason: payload?.reason ?? null,
          $model: text(payload?.model) ?? text(payload?.modelId) ?? null,
          $cwd: payload?.cwd ?? null,
          $payload: raw,
        }),
      );
      if (changes.changes === 0) report.duplicate += 1;
      else report.applied += 1;
      unlinkSync(path);
    }
  }
  return report;
}

export function applyHookEvents(db: Database): void {
  db.run(`
    UPDATE session SET
      ended_at = (SELECT max(h.ts) FROM hook_event h
                  WHERE h.session_id = session.id AND h.event = 'session_end'),
      end_reason = (SELECT h.reason FROM hook_event h
                    WHERE h.session_id = session.id AND h.event = 'session_end'
                    ORDER BY h.ts DESC LIMIT 1)
    WHERE EXISTS (SELECT 1 FROM hook_event h
                  WHERE h.session_id = session.id AND h.event = 'session_end')
  `);
}
