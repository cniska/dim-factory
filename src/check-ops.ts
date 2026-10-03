import { CHECK_LIMIT_MS } from "./check";
import { runCheck, runInstall, type Sandboxed } from "./check-effects";
import type { Evidence } from "./order-contract";
import type { Env } from "./paths";
import type { Trace } from "./trace-contract";

export function judge(trace: Trace, tree: string, commandLine: string, owner: Env): Evidence {
  return runCheck(trace, tree, commandLine, owner, CHECK_LIMIT_MS);
}

export function install(trace: Trace, tree: string, commandLine: string, owner: Env): Sandboxed {
  return runInstall(trace, tree, commandLine, owner, CHECK_LIMIT_MS);
}
