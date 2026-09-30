import { describe, expect, test } from "bun:test";
import { actingSession, ancestry, isRunning, nearestHarnessSession, workerNameOf } from "./worker";
import type { ProcessRow, WorkerSession } from "./worker-contract";

const STARTED = "Wed Sep 30 10:00:00 2026";
const LATER = "Wed Sep 30 11:00:00 2026";

const TABLE: readonly ProcessRow[] = [
  { pid: 1, ppid: 0, startedAt: STARTED },
  { pid: 40, ppid: 1, startedAt: STARTED },
  { pid: 41, ppid: 40, startedAt: STARTED },
  { pid: 42, ppid: 41, startedAt: LATER },
];

describe("a process's ancestry", () => {
  test("runs from the process up to the root, each with its start time", () => {
    expect(ancestry(TABLE, 42)).toEqual([
      { pid: 42, startedAt: LATER },
      { pid: 41, startedAt: STARTED },
      { pid: 40, startedAt: STARTED },
      { pid: 1, startedAt: STARTED },
    ]);
  });

  test("stops at a cycle rather than looping", () => {
    const cycle: readonly ProcessRow[] = [
      { pid: 7, ppid: 8, startedAt: STARTED },
      { pid: 8, ppid: 7, startedAt: STARTED },
    ];
    expect(ancestry(cycle, 7).map((row) => row.pid)).toEqual([7, 8]);
  });
});

describe("who a process acts as", () => {
  const session = (id: string, pid: number, startedAt = STARTED): WorkerSession => ({
    id,
    worker: `nut-${pid}`,
    harness: "claude",
    process: { pid, startedAt },
  });

  test("is the registered session nearest above it", () => {
    const chain = ancestry(TABLE, 42);
    expect(actingSession(chain, [session("far", 40), session("near", 41)])?.id).toBe("near");
  });

  test("is no one when the only match is a pid reused by another process", () => {
    const chain = ancestry(TABLE, 42);
    expect(actingSession(chain, [session("old", 41, "Tue Sep 29 09:00:00 2026")])).toBeNull();
  });

  test("a session runs only while its process, with the same start time, does", () => {
    expect(isRunning({ pid: 41, startedAt: STARTED }, TABLE)).toBe(true);
    expect(isRunning({ pid: 41, startedAt: LATER }, TABLE)).toBe(false);
  });
});

describe("the harness session a process registers from", () => {
  const open = (id: string, harnessPid: number, startedAt: string) => ({ id, harnessPid, startedAt });

  test("is the open session whose harness is the nearest ancestor", () => {
    const chain = ancestry(TABLE, 42);
    const found = nearestHarnessSession(chain, [
      open("outer", 40, "2026-10-01T12:00:00Z"),
      open("inner", 41, "2026-10-01T12:00:00Z"),
    ]);
    expect([found?.session.id, found?.harness.pid]).toEqual(["inner", 41]);
  });

  test("ignores a session that started before its harness pid's process did", () => {
    const chain = ancestry(TABLE, 42);
    expect(nearestHarnessSession(chain, [open("stale", 41, "2026-09-29T07:00:00Z")])).toBeNull();
  });
});

describe("a worker's name", () => {
  test("is a word and a number, and none when that name is taken", () => {
    expect(workerNameOf(new Uint32Array([0, 6]), new Set())).toBe("nut-7");
    expect(workerNameOf(new Uint32Array([0, 6]), new Set(["nut-7"]))).toBeNull();
    expect(workerNameOf(crypto.getRandomValues(new Uint32Array(2)), new Set())).toMatch(/^[a-z]+-\d+$/);
  });
});
