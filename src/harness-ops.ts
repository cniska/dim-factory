import type { Spawn, Spawned } from "./harness-contract";
import { killGroup, spawnHarness } from "./harness-effects";
import type { Trace } from "./trace-contract";
import type { ProcessId } from "./worker-contract";

export function startHarness(trace: Trace, spawn: Spawn): Spawned {
  return spawnHarness(trace, spawn);
}

export function stopHarness(trace: Trace, harness: ProcessId): void {
  killGroup(trace, harness.pid);
}
