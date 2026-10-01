import { claude } from "./harness-claude";
import { type Adapter, refuseHarness, type Spawned } from "./harness-contract";
import { killGroup, spawnHarness } from "./harness-effects";
import type { HarnessName } from "./harness-name";
import type { ProcessId } from "./worker-contract";

const ADAPTERS: Readonly<Partial<Record<HarnessName, Adapter>>> = { claude };

export function adapterFor(harness: HarnessName): Adapter {
  const adapter = ADAPTERS[harness];
  if (adapter === undefined) throw refuseHarness("no_adapter", { harness });
  return adapter;
}

export function startHarness(argv: readonly string[], cwd: string, env: Record<string, string>): Spawned {
  return spawnHarness(argv, cwd, env);
}

export function stopOrphan(harness: ProcessId): void {
  killGroup(harness.pid);
}
