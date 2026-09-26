import type { Command } from "./cli-contract";
import { openReadOnly } from "./db-read";
import { resolveWalk, spoolWalk } from "./guidance-walk";
import { readHookPayload } from "./hooks-payload";
import { dbPath } from "./paths";
import { readWake, renderWake, type Wake, wireFor } from "./recall-wake";

async function wake(args: string[]): Promise<void> {
  const tool = args.includes("--tool=codex") ? "codex" : "claude";
  const payload = await readHookPayload();
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();

  if (typeof payload.session_id === "string") {
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
