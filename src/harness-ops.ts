import type { Spawned } from "./harness-contract";
import { killGroup, spawnHarness } from "./harness-effects";
import type { ProcessId } from "./worker-contract";

export function startHarness(argv: readonly string[], cwd: string, env: Record<string, string>): Spawned {
  return spawnHarness(argv, cwd, env);
}

export function stopHarness(harness: ProcessId): void {
  killGroup(harness.pid);
}
