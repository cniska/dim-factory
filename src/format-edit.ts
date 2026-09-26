import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { checkoutRoot } from "./git-checkout";
import { formatTask } from "./workspace-tasks";

export const FORMAT_TIMEOUT_MS = 30_000;

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PATCH_TARGET = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm;

export type EditPayload = {
  tool_name?: unknown;
  cwd?: unknown;
  tool_input?: { file_path?: unknown; notebook_path?: unknown; command?: unknown };
};

export type FormatRun = { checkout: string; commandLine: string; exitCode: number | null };

export function editedPaths(payload: EditPayload): string[] {
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const input = payload.tool_input ?? {};
  if (typeof payload.tool_name === "string" && FILE_TOOLS.has(payload.tool_name)) {
    const path = input.file_path ?? input.notebook_path;
    return typeof path === "string" ? [resolve(cwd, path)] : [];
  }
  if (payload.tool_name === "apply_patch" && typeof input.command === "string") {
    return [...input.command.matchAll(PATCH_TARGET)].map((match) =>
      resolve(cwd, (match[1] as string).trim()),
    );
  }
  return [];
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
