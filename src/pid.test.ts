import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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

test("reads the same parent and start time ps reports, up the whole ancestry", () => {
  for (const { pid, startedAt } of processAncestry()) {
    const [parent, ...started] = execFileSync("/bin/ps", ["-p", String(pid), "-o", "ppid=,lstart="], {
      encoding: "utf8",
      env: { LC_ALL: "C", TZ: "UTC" },
    })
      .trim()
      .split(/\s+/);
    expect(readProcess(pid)?.parentPid).toBe(Number(parent));
    expect(startedAt).toBe(String(Date.parse(`${started.join(" ")} GMT`) / 1000));
  }
});

test("ends the ancestry at the first process another user owns", () => {
  expect(processAncestry().map((entry) => entry.pid)).not.toContain(1);
});

test("reads no process for a pid that is not running", () => {
  expect(readProcess(99_999_999)).toBeNull();
});
