import { claude } from "./harness-claude";
import { type Adapter, refuseHarness } from "./harness-contract";
import { type Spawned, spawnHarness } from "./harness-effects";
import type { HarnessName } from "./harness-name";

const ADAPTERS: Readonly<Partial<Record<HarnessName, Adapter>>> = { claude };

export function adapterFor(harness: HarnessName): Adapter {
  const adapter = ADAPTERS[harness];
  if (adapter === undefined) throw refuseHarness("no_adapter", { harness });
  return adapter;
}

export function startHarness(argv: readonly string[], cwd: string, env: Record<string, string>): Spawned {
  return spawnHarness(argv, cwd, env);
}
