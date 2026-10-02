import { claude } from "./harness-claude";
import { type Adapter, HARNESSES, type Harness, type Spawn, type Spawned } from "./harness-contract";
import { killGroup, spawnHarness } from "./harness-effects";
import type { Env } from "./paths";
import type { Trace } from "./trace-contract";
import type { ProcessId } from "./worker-contract";

export const WORKER_HARNESS: Adapter = claude;

export function harnessInstalled(harness: Harness, env: Env = process.env): boolean {
  return Bun.which(harness.name, { PATH: env.PATH ?? "" }) !== null;
}

export function installedHarnesses(env: Env = process.env): Harness[] {
  return Object.values(HARNESSES).filter((harness) => harnessInstalled(harness, env));
}

export function startHarness(trace: Trace, spawn: Spawn): Spawned {
  return spawnHarness(trace, spawn);
}

export function stopHarness(trace: Trace, harness: ProcessId): void {
  killGroup(trace, harness.pid);
}
