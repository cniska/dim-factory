export type WorkerEnvironmentPhase = "setup" | "teardown";
export type ResourceEvidence = Record<string, unknown>;
export type WorkerHookReport = {
  phase: WorkerEnvironmentPhase;
  argv: string[];
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  resources: ResourceEvidence[];
};
export type WorkerEnvironmentReport = { setup: WorkerHookReport | null; teardown: WorkerHookReport | null };

function resourcesFrom(stdout: string): ResourceEvidence[] {
  return stdout.split("\n").flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const resources = (value as { resources?: unknown }).resources;
      return Array.isArray(resources) &&
        resources.every((item) => item && typeof item === "object" && !Array.isArray(item))
        ? (resources as ResourceEvidence[])
        : [];
    } catch {
      return [];
    }
  });
}

export function runWorkerHook(phase: WorkerEnvironmentPhase, path: string, cwd: string): WorkerHookReport {
  const argv = [path];
  const proc = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr);
  return {
    phase,
    argv,
    exitCode: proc.exitCode,
    signal: proc.signalCode ?? null,
    stdout,
    stderr,
    resources: resourcesFrom(stdout),
  };
}
