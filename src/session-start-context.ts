import { checkTask, formatTask } from "./declared-tasks";
import { checkoutRoot } from "./git-checkout";

export function wireFor(block: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: block },
  });
}

export function projectLine(dir: string): string | null {
  const repo = checkoutRoot(dir);
  if (repo === null) return null;
  const declared: string[] = [];
  const check = checkTask(repo);
  const format = formatTask(repo);
  if (check) declared.push(`check \`${check.commandLine}\``);
  if (format) declared.push(`format \`${format.commandLine}\``);
  return declared.length === 0 ? null : `This repo declares: ${declared.join(", ")}.`;
}
