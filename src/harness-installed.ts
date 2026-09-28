import { harnessExecutable } from "./harness-launch";
import { HARNESSES, type HarnessName } from "./harness-name";
import type { Env } from "./paths";

export function harnessInstalled(harness: HarnessName, env: Env = process.env): boolean {
  return Bun.which(harnessExecutable(harness), { PATH: env.PATH ?? "" }) !== null;
}

export function installedHarnesses(env: Env = process.env): HarnessName[] {
  return HARNESSES.filter((harness) => harnessInstalled(harness, env));
}
