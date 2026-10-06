import { refuseOrder } from "./order-contract";
import type { Env } from "./paths";
import { pinnedBins, resolveToolchain, type Toolchain } from "./toolchain-effects";
import type { Trace } from "./trace-contract";

export function pinnedToolchain(checkout: string, env: Env): Toolchain {
  return pinnedBins(checkout, env);
}

export function pinnedEnv(trace: Trace, order: string, checkout: string, env: Env): Env {
  const toolchain = resolveToolchain(trace, checkout, env);
  if (toolchain.kind === "failed") {
    throw refuseOrder("toolchain_unresolved", { order, checkout, output: toolchain.output });
  }
  return { ...env, PATH: [...toolchain.bins, env.PATH].filter((dir) => dir !== undefined).join(":") };
}
