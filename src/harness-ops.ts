import { claude } from "./harness-claude";
import { type Adapter, refuseHarness } from "./harness-contract";
import { type Held, holdHarness } from "./harness-effects";

const ADAPTERS: Readonly<Record<string, Adapter>> = { claude };

export function adapterFor(harness: string): Adapter {
  const adapter = ADAPTERS[harness];
  if (adapter === undefined) throw refuseHarness("no_adapter", { harness });
  return adapter;
}

export function startHarness(argv: readonly string[], cwd: string, env: Record<string, string>): Held {
  return holdHarness(argv, cwd, env);
}
