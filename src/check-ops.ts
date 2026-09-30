import { runCheck } from "./check-effects";
import type { Evidence } from "./order-contract";
import type { Env } from "./paths";

export function judge(
  tree: string,
  commandLine: string,
  owner: Env,
): Extract<Evidence, { readonly kind: "check" }> {
  return runCheck(tree, commandLine, owner);
}
