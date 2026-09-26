import type { Command } from "./command";
import { dbPath } from "./paths";
import { openReadOnly } from "./read-db";
import { readWake, renderWake, type Wake, wireFor } from "./wake";
import { resolveWalk, spoolWalk } from "./walk";

async function hookPayload(): Promise<{ session_id?: string; cwd?: string }> {
  if (Bun.stdin.stream().locked || process.stdin.isTTY) return {};
  try {
    const raw = await Bun.stdin.text();
    return raw.trim() === "" ? {} : (JSON.parse(raw) as { session_id?: string; cwd?: string });
  } catch {
    return {};
  }
}

async function wake(args: string[]): Promise<void> {
  const tool = args.includes("--tool=codex") ? "codex" : "claude";
  const payload = await hookPayload();
  const cwd = payload.cwd ?? process.cwd();

  if (payload.session_id) {
    try {
      spoolWalk({
        session_id: payload.session_id,
        tool,
        seen_at: new Date().toISOString(),
        surfaces: resolveWalk(tool, cwd),
      });
    } catch {}
  }

  let read: Wake | null = null;
  try {
    const db = openReadOnly(dbPath());
    try {
      read = readWake(db, cwd);
    } finally {
      db.close();
    }
  } catch {}

  try {
    const wire = wireFor(tool, renderWake(read, cwd));
    if (wire) console.log(wire);
  } catch {}
}

export const wakeCommand: Command = {
  name: "wake",
  usage: "usage: dim wake [--tool=codex]",
  summary:
    "print what the last session in this directory left as Next, in the SessionStart hook's wire format",
  raw: () => true,
  run: (args) => wake(args),
};
