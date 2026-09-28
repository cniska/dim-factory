import { expect, test } from "bun:test";
import { processAncestry, processStartTime, readProcess } from "./pid";

test("reads a process and its parent with a stable start time", () => {
  const current = readProcess(process.pid);
  expect(current?.pid).toBe(process.pid);
  expect(current?.parentPid).toBe(process.ppid);
  expect(Number(current?.startedAt)).toBeLessThanOrEqual(Date.now() / 1000);
  expect(Number(current?.startedAt)).toBeGreaterThan(Date.now() / 1000 - 3600);
  expect(processStartTime(process.pid)).toBe(current?.startedAt ?? null);
  expect(processAncestry()[0]?.pid).toBe(process.ppid);
});

test("reads a child it started as its own, started within the second it was spawned", async () => {
  const before = Math.floor(Date.now() / 1000);
  const child = Bun.spawn(["/bin/sleep", "5"]);
  try {
    const read = readProcess(child.pid);
    expect(read?.parentPid).toBe(process.pid);
    expect(Number(read?.startedAt)).toBeGreaterThanOrEqual(before);
    expect(Number(read?.startedAt)).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000));
  } finally {
    child.kill();
    await child.exited;
  }
});

test("ends the ancestry at the first process another user owns", () => {
  expect(processAncestry().map((entry) => entry.pid)).not.toContain(1);
});

test("reads no process for a pid that is not running", () => {
  expect(readProcess(99_999_999)).toBeNull();
});
