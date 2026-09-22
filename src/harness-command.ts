import { codexArgv, parseCodexHarnessEvent } from "./codex-harness";
import type { HarnessEvent, HarnessRequest } from "./harness";

export type HarnessName = "codex";

export type HarnessCommandRequest = HarnessRequest & { harness: HarnessName };

export type HarnessCommandResult = {
  exitCode: number;
  output: string;
  events: HarnessEvent[];
};

export function harnessArgv(request: HarnessCommandRequest): string[] {
  if (request.harness === "codex") return codexArgv("codex", request);
  throw new Error(`unsupported harness ${request.harness}`);
}

export function runHarnessCommand(request: HarnessCommandRequest): HarnessCommandResult {
  const child = Bun.spawnSync(harnessArgv(request), {
    cwd: request.cwd,
    env: { ...process.env, ...request.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const events: HarnessEvent[] = [];
  for (const line of child.stdout.toString().split("\n")) {
    const parsed = parseCodexHarnessEvent(line.trim());
    if (Array.isArray(parsed)) events.push(...parsed);
    else if (parsed) events.push(parsed);
  }
  return {
    exitCode: child.exitCode ?? 1,
    output: events
      .filter((event): event is Extract<HarnessEvent, { type: "message" }> => event.type === "message")
      .map((event) => event.text)
      .join("\n"),
    events,
  };
}
