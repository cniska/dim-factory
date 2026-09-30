import { runCheck } from "./check-effects";
import { checkTask } from "./declared-tasks";
import type { Evidence } from "./order-contract";

export function declaredCheck(tree: string): string | null {
  const task = checkTask(tree);
  return task === null ? null : task.commandLine;
}

export function judge(tree: string, commandLine: string): Extract<Evidence, { readonly kind: "check" }> {
  return runCheck(tree, commandLine);
}
