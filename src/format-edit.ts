import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { formatTask } from "./declared-tasks";
import { checkoutRoot } from "./git-checkout";
import { type EditInput, HARNESSES } from "./harness-contract";

export const FORMAT_TIMEOUT_MS = 30_000;

export type EditPayload = { tool_name?: unknown; cwd?: unknown; tool_input?: EditInput };

export type FormatRun = { checkout: string; commandLine: string; exitCode: number | null };

export function editedPaths(payload: EditPayload): string[] {
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const harness = Object.values(HARNESSES).find(
    (candidate) => typeof payload.tool_name === "string" && candidate.editTools.includes(payload.tool_name),
  );
  return harness ? harness.editedPaths(payload.tool_input ?? {}).map((path) => resolve(cwd, path)) : [];
}

export function formatAfterEdit(payload: EditPayload): FormatRun[] {
  const checkouts = new Set(
    editedPaths(payload)
      .map((path) => checkoutRoot(dirname(path)))
      .filter((root): root is string => root !== null),
  );
  const runs: FormatRun[] = [];
  for (const checkout of checkouts) {
    const task = formatTask(checkout);
    if (!task) continue;
    const run = spawnSync("sh", ["-c", task.commandLine], {
      cwd: checkout,
      timeout: FORMAT_TIMEOUT_MS,
      stdio: "ignore",
    });
    runs.push({ checkout, commandLine: task.commandLine, exitCode: run.status });
  }
  return runs;
}
