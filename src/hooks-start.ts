import { readHookPayload } from "./hooks-payload";
import { projectLine, wireFor } from "./session-start-context";

export async function startSession(): Promise<void> {
  const payload = await readHookPayload();
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();

  try {
    const wire = wireFor(projectLine(cwd));
    if (wire) console.log(wire);
  } catch {}
}
