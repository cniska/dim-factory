import { formatTask } from "./declared-tasks";

export type Formatted = {
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly output: string;
};

export function formatProject(root: string): Formatted | null {
  const command = formatTask(root)?.commandLine;
  if (command === undefined) return null;
  const run = Bun.spawnSync(["sh", "-c", command], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return {
    command,
    exitCode: run.exitCode,
    signal: run.signalCode ?? null,
    output: run.exitCode === 0 ? "" : `${run.stdout.toString()}${run.stderr.toString()}`.trim(),
  };
}
