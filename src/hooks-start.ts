import { readHookPayload, StartPayload } from "./hooks-payload";
import { projectLine, wireFor } from "./session-start-context";

export async function startSession(): Promise<void> {
  const { cwd } = await readHookPayload(StartPayload);
  const line = projectLine(cwd);
  if (line !== null) console.log(wireFor(line));
}
