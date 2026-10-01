import type { Spawned } from "./harness-contract";
import { killGroup, spawnHarness } from "./harness-effects";
import type { Trace } from "./trace-contract";
import type { ProcessId } from "./worker-contract";

export function startHarness(
  trace: Trace,
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
): Spawned {
  return spawnHarness(trace, argv, cwd, env);
}

export function stopHarness(trace: Trace, harness: ProcessId): void {
  killGroup(trace, harness.pid);
}
