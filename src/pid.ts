import { execFileSync } from "node:child_process";
import { libprocProcess } from "./pid-libproc";

export type ProcessIdentity = { pid: number; startedAt: string };

export type ProcessEntry = ProcessIdentity & { parentPid: number };

const PS_LINE = /^\s*(\d+)\s+(.+?)\s*$/;
const PS_NO_SUCH_PROCESS = 1;

function psProcess(pid: number): { parentPid: number; startedAt: string } | null {
  let output: string;
  try {
    output = execFileSync("/bin/ps", ["-p", String(pid), "-o", "ppid=,lstart="], {
      encoding: "utf8",
      env: { LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    if ((error as { status?: number }).status === PS_NO_SUCH_PROCESS) return null;
    throw error;
  }
  const match = PS_LINE.exec(output);
  const started = match ? Date.parse(`${match[2]} GMT`) : Number.NaN;
  if (!match || !Number.isFinite(started))
    throw new Error(`ps printed no start time for pid ${pid}: ${output}`);
  return { parentPid: Number(match[1]), startedAt: String(started / 1000) };
}

export function readProcess(pid: number): ProcessEntry | null {
  if (!Number.isInteger(pid) || pid < 1) return null;
  const read = process.platform === "darwin" ? libprocProcess(pid) : psProcess(pid);
  if (read) return { pid, ...read };
  if (pidIsAlive(pid)) throw new Error(`cannot read process info for running pid ${pid}`);
  return null;
}

export function processAncestry(): ProcessIdentity[] {
  const ancestry: ProcessIdentity[] = [];
  let entry = readProcess(process.ppid);
  while (entry && !ancestry.some((seen) => seen.pid === entry?.pid)) {
    ancestry.push({ pid: entry.pid, startedAt: entry.startedAt });
    entry = isOwnProcess(entry.parentPid) ? readProcess(entry.parentPid) : null;
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

function isOwnProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
