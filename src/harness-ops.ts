import { claude } from "./harness-claude";
import { type Adapter, refuseHarness, type Strength } from "./harness-contract";
import { type Held, holdHarness, readModels } from "./harness-effects";
import { modelsPath } from "./paths";

const ADAPTERS: Readonly<Record<string, Adapter>> = { claude };

export function adapterFor(harness: string): Adapter {
  const adapter = ADAPTERS[harness];
  if (adapter === undefined) throw refuseHarness("no_adapter", { harness });
  return adapter;
}

export function modelFor(harness: string, strength: Strength): string {
  const file = modelsPath();
  const model = readModels(file)[harness]?.[strength];
  if (model === undefined) throw refuseHarness("no_model", { harness, strength, file });
  return model;
}

export function startHarness(argv: readonly string[], cwd: string, env: Record<string, string>): Held {
  return holdHarness(argv, cwd, env);
}
