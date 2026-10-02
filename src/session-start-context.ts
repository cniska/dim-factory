import { checkTask, formatTask } from "./declared-tasks";
import { checkoutRoot } from "./git-checkout";
import type { HarnessName } from "./harness-registry";

export function wireFor(tool: HarnessName, block: string): string {
  if (block === "") return "";
  if (tool === "claude") return block;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: block },
  });
}

export function projectLine(dir: string): string {
  const repo = checkoutRoot(dir);
  if (repo === null) return "";
  const declared: string[] = [];
  const check = checkTask(repo);
  const format = formatTask(repo);
  if (check) declared.push(`check \`${check.commandLine}\``);
  if (format) declared.push(`format \`${format.commandLine}\``);
  return declared.length === 0 ? "" : `This repo declares: ${declared.join(", ")}.`;
}
