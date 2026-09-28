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
