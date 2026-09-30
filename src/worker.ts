import type { ProcessId, ProcessRow, WorkerSession } from "./worker-contract";

const WORDS = [
  "nut",
  "bolt",
  "cog",
  "gear",
  "rivet",
  "pin",
  "lever",
  "spring",
  "valve",
  "spoke",
  "axle",
  "crank",
  "wedge",
  "hinge",
  "latch",
  "clamp",
] as const;

const MAX_NUMBER = 999;

export function workerNameOf(random: Uint32Array, taken: ReadonlySet<string>): string | null {
  const [word = 0, number = 0] = random;
  const name = `${WORDS[word % WORDS.length]}-${(number % MAX_NUMBER) + 1}`;
  return taken.has(name) ? null : name;
}

const sameProcess = (a: ProcessId, b: ProcessId) => a.pid === b.pid && a.startedAt === b.startedAt;

export function actingSession(
  ancestry: readonly ProcessId[],
  sessions: readonly WorkerSession[],
): WorkerSession | null {
  for (const ancestor of ancestry) {
    const found = sessions.find((session) => sameProcess(session.process, ancestor));
    if (found) return found;
  }
  return null;
}

export function ancestry(table: readonly ProcessRow[], pid: number): readonly ProcessId[] {
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const chain: ProcessId[] = [];
  let row = byPid.get(pid);
  while (row !== undefined && !chain.some((seen) => seen.pid === row?.pid)) {
    chain.push({ pid: row.pid, startedAt: row.startedAt });
    row = byPid.get(row.ppid);
  }
  return chain;
}

export type HarnessSession = { readonly id: string; readonly harnessPid: number; readonly startedAt: string };

export function nearestHarnessSession<S extends HarnessSession>(
  chain: readonly ProcessId[],
  open: readonly S[],
): { readonly session: S; readonly harness: ProcessId } | null {
  for (const ancestor of chain) {
    const session = open.find(
      (candidate) =>
        candidate.harnessPid === ancestor.pid &&
        Date.parse(candidate.startedAt) >= Date.parse(ancestor.startedAt),
    );
    if (session) return { session, harness: ancestor };
  }
  return null;
}

export function isRunning(process: ProcessId, running: readonly ProcessId[]): boolean {
  return running.some((candidate) => sameProcess(candidate, process));
}
