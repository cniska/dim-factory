import { runCheck } from "./check-effects";
import type { Evidence } from "./order-contract";
import type { Env } from "./paths";
import type { Trace } from "./trace-contract";

export function judge(trace: Trace, tree: string, commandLine: string, owner: Env): Evidence {
  return runCheck(trace, tree, commandLine, owner);
}
