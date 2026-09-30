import type { ProcessRow } from "./worker-contract";

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/;

export function processTable(): readonly ProcessRow[] {
  const ran = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,lstart="], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (ran.exitCode !== 0) throw new Error(`ps failed: ${ran.stderr.toString().trim()}`);
  return ran.stdout
    .toString()
    .split("\n")
    .flatMap((line) => {
      const matched = PS_LINE.exec(line);
      return matched
        ? [{ pid: Number(matched[1]), ppid: Number(matched[2]), startedAt: matched[3] as string }]
        : [];
    });
}
