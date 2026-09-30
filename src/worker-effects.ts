import { existsSync, readFileSync } from "node:fs";
import type { ProcessRow } from "./worker-contract";
import { refuseWorker } from "./worker-contract";

export function transcriptLines(path: string): readonly unknown[] | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): unknown => JSON.parse(line));
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/;

function startedAt(lstart: string): string {
  const time = Date.parse(lstart);
  if (Number.isNaN(time))
    throw refuseWorker("no_process_table", { detail: `unreadable start time ${lstart}` });
  return new Date(time).toISOString();
}

export function processTable(): readonly ProcessRow[] {
  const ran = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,lstart="], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (ran.exitCode !== 0) throw refuseWorker("no_process_table", { detail: ran.stderr.toString().trim() });
  return ran.stdout
    .toString()
    .split("\n")
    .flatMap((line) => {
      const matched = PS_LINE.exec(line);
      if (matched === null) return [];
      const [, pid = "", ppid = "", lstart = ""] = matched;
      return [{ pid: Number(pid), ppid: Number(ppid), startedAt: startedAt(lstart) }];
    });
}
