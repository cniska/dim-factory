import type { Command } from "./cli-contract";
import { resolveWalk, spoolWalk } from "./guidance-walk";
import { readHookPayload } from "./hooks-payload";
import { projectLine, wireFor } from "./session-start-context";

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

  try {
    const wire = wireFor(tool, projectLine(cwd));
    if (wire) console.log(wire);
  } catch {}
}

export const wakeCommand: Command = {
  name: "wake",
  usage: "usage: dim wake [--tool=codex]",
  summary: "print the repo's declared commands in the SessionStart hook's wire format",
  raw: () => true,
  run: (args) => wake(args),
};
