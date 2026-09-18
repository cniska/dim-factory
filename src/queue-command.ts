import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseQueue, type QueueStatus, readyItems, transitionQueue } from "./queue-planner";

const usage = "usage: dim queue <ready|transition> <queue-file> ...";

function valueAfter(args: string[], flag: string): string | undefined {
  const indexes = args.flatMap((value, index) => (value === flag ? [index] : []));
  if (indexes.length > 1) throw new Error(`${flag} may be provided once`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function assertFlags(args: string[], allowed: Set<string>): void {
  for (const [index, arg] of args.entries()) {
    if (!arg.startsWith("--")) continue;
    if (!allowed.has(arg)) throw new Error(`unknown option: ${arg}`);
    if (index === args.length - 1 || args[index + 1]?.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
  }
}

function positiveLimit(value: string | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  return limit;
}

async function readQueue(path: string): Promise<ReturnType<typeof parseQueue>> {
  return parseQueue(await readFile(path, "utf8"));
}

async function withQueueLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const staging = `${lock}.${process.pid}`;
  while (true) {
    try {
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging);
      await writeFile(join(staging, "pid"), String(process.pid), "utf8");
      await rename(staging, lock);
      break;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stale = `${lock}.stale-${process.pid}`;
      try {
        await rm(stale, { recursive: true, force: true });
        await rename(lock, stale);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      let holder: number | undefined;
      try {
        holder = Number.parseInt(await readFile(join(stale, "pid"), "utf8"), 10);
      } catch {
        holder = undefined;
      }
      if (holder === undefined || !Number.isInteger(holder) || holder <= 0 || !pidIsAlive(holder)) {
        await rm(stale, { recursive: true, force: true });
        continue;
      }
      await rename(stale, lock);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function writeQueue(path: string, queue: ReturnType<typeof parseQueue>): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(dirname(path), ".queue-tmp-"));
  const temporary = join(temporaryDirectory, "queue.json");
  try {
    await writeFile(temporary, `${JSON.stringify(queue, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
    await rename(temporary, path);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function runQueueCommand(args: string[]): Promise<string> {
  const command = args[0];
  const path = args[1];
  if (!command || !path) throw new Error(usage);
  assertFlags(args, command === "ready" ? new Set(["--limit"]) : new Set(["--reason", "--at"]));
  if (command === "ready") {
    if (args.slice(2).length !== 0 && args.slice(2).length !== 2) {
      throw new Error(usage);
    }
    if (args.slice(2).length === 2 && args[2] !== "--limit") throw new Error(usage);
    const items = readyItems(await readQueue(path), positiveLimit(valueAfter(args, "--limit"))).map(
      ({ id, title, status }) => ({
        id,
        title,
        status,
      }),
    );
    return JSON.stringify(items);
  }
  if (command !== "transition") throw new Error(usage);
  const itemId = args[2];
  const status = args[3] as QueueStatus | undefined;
  if (!itemId || !status) throw new Error(usage);
  const options = args.slice(4);
  if (options.length % 2 !== 0 || options.some((arg, index) => index % 2 === 0 && !arg.startsWith("--"))) {
    throw new Error(usage);
  }
  return withQueueLock(path, async () => {
    const updated = transitionQueue(
      await readQueue(path),
      itemId,
      status,
      valueAfter(args, "--reason"),
      valueAfter(args, "--at") ?? new Date().toISOString(),
    );
    await writeQueue(path, updated);
    return JSON.stringify({ id: itemId, status });
  });
}
