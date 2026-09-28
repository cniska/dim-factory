import { execFileSync } from "node:child_process";

export type ProcessIdentity = { pid: number; startedAt: string };

export type ProcessEntry = ProcessIdentity & { parentPid: number };

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/;

function processTable(args: string[]): ProcessEntry[] {
  let output: string;
  try {
    output = execFileSync("/bin/ps", [...args, "-o", "pid=,ppid=,lstart="], {
      encoding: "utf8",
      env: { LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  return output.split("\n").flatMap((line) => {
    const match = PS_LINE.exec(line);
    if (!match) return [];
    const started = Date.parse(`${match[3]} GMT`);
    if (!Number.isFinite(started)) return [];
    return [{ pid: Number(match[1]), parentPid: Number(match[2]), startedAt: String(started / 1000) }];
  });
}

export function readProcess(pid: number): ProcessEntry | null {
  if (!Number.isInteger(pid) || pid < 1) return null;
  return processTable(["-p", String(pid)]).find((entry) => entry.pid === pid) ?? null;
}

export function processAncestry(): ProcessIdentity[] {
  const byPid = new Map(processTable(["-A"]).map((entry) => [entry.pid, entry]));
  const ancestry: ProcessIdentity[] = [];
  let entry = byPid.get(process.ppid);
  while (entry && !ancestry.some((seen) => seen.pid === entry?.pid)) {
    ancestry.push({ pid: entry.pid, startedAt: entry.startedAt });
    entry = byPid.get(entry.parentPid);
  }
  return ancestry;
}

export function processStartTime(pid: number): string | null {
  return readProcess(pid)?.startedAt ?? null;
}

export function processStartedBefore(startedAt: string, timestamp: string): boolean {
  const event = Date.parse(timestamp);
  return Number.isFinite(event) && /^\d+$/.test(startedAt) && Number(startedAt) * 1000 <= event;
}

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
