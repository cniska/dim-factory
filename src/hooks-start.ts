import { readHookPayload } from "./hooks-payload";
import { projectLine, wireFor } from "./session-start-context";

export async function startSession(args: string[]): Promise<void> {
  const tool = args.includes("--tool=codex") ? "codex" : "claude";
  const payload = await readHookPayload();
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();

  try {
    const wire = wireFor(tool, projectLine(cwd));
    if (wire) console.log(wire);
  } catch {}
}
