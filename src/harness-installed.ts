import { HARNESSES, type Harness } from "./harness-registry";
import type { Env } from "./paths";

export function harnessInstalled(harness: Harness, env: Env = process.env): boolean {
  return Bun.which(harness.name, { PATH: env.PATH ?? "" }) !== null;
}

export function installedHarnesses(env: Env = process.env): Harness[] {
  return Object.values(HARNESSES).filter((harness) => harnessInstalled(harness, env));
}
