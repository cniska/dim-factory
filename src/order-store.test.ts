import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "./db";
import { openFactory } from "./factory-db";
import type { LogEntry } from "./order-contract";
import { appendEntries, deleteRun, insertRun, orderIds, readLog, runOf, setRunHarness } from "./order-store";

const roots: string[] = [];
const opened: Database[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function factory(): Database {
  const root = mkdtempSync(join(tmpdir(), "dim-order-store-"));
  roots.push(root);
  const db = openFactory(join(root, "sessions.db"));
  opened.push(db);
  return db;
}

const ENTRIES: readonly LogEntry[] = [
  {
    seq: 1,
    at: "2026-09-30T10:00:00Z",
    by: { kind: "worker", worker: "nut-1", session: "s1" },
    action: "order_added",
    details: { title: "Greet", description: "Add a greeting.", project: "acme/widgets" },
  },
  {
    seq: 2,
    at: "2026-09-30T10:00:01Z",
    by: { kind: "factory", version: "0.1.0", cause: 1 },
    action: "workspace_created",
    details: { base: "abc123" },
  },
];

test("reads back each entry as it was appended, in order", () => {
  const db = factory();
  appendEntries(db, "k7m2qx4d", ENTRIES);
  expect(readLog(db, "k7m2qx4d")).toEqual(ENTRIES);
  expect(readLog(db, "zzzzzzzz")).toEqual([]);
});

test("lists each order the log holds once, by id", () => {
  const db = factory();
  expect(orderIds(db)).toEqual([]);
  appendEntries(db, "m3x9p2ka", ENTRIES);
  appendEntries(db, "k7m2qx4d", ENTRIES);
  expect(orderIds(db)).toEqual(["k7m2qx4d", "m3x9p2ka"]);
});

test("refuses to change or remove an entry the log holds", () => {
  const db = factory();
  appendEntries(db, "k7m2qx4d", ENTRIES);
  expect(() => db.run("UPDATE order_log SET action = 'order_run'")).toThrow("append-only");
  expect(() => db.run("DELETE FROM order_log")).toThrow("append-only");
  expect(readLog(db, "k7m2qx4d")).toEqual(ENTRIES);
});

test("refuses a second entry at a seq the order already holds", () => {
  const db = factory();
  appendEntries(db, "k7m2qx4d", ENTRIES);
  expect(() => appendEntries(db, "k7m2qx4d", [{ ...ENTRIES[1], seq: 2 } as LogEntry])).toThrow();
});

test("refuses an entry naming the factory with a cause the log does not hold", () => {
  const db = factory();
  appendEntries(db, "k7m2qx4d", [ENTRIES[0] as LogEntry]);
  expect(() =>
    appendEntries(db, "k7m2qx4d", [
      { ...(ENTRIES[1] as LogEntry), by: { kind: "factory", version: "0.1.0", cause: 9 } },
    ]),
  ).toThrow();
});

test("holds one run per order, with the harness process once it is set, until it is deleted", () => {
  const db = factory();
  const process = { pid: 41, startedAt: "t41" };
  insertRun(db, "k7m2qx4d", "station", process);
  expect(runOf(db, "k7m2qx4d")).toEqual({ kind: "station", process, harness: null });
  expect(() => insertRun(db, "k7m2qx4d", "ship", process)).toThrow();
  setRunHarness(db, "k7m2qx4d", { pid: 42, startedAt: "t42" });
  expect(runOf(db, "k7m2qx4d")?.harness).toEqual({ pid: 42, startedAt: "t42" });
  deleteRun(db, "k7m2qx4d");
  expect(runOf(db, "k7m2qx4d")).toBeNull();
});

test("keeps the factory's tables when the record is reopened", () => {
  const root = mkdtempSync(join(tmpdir(), "dim-order-store-"));
  roots.push(root);
  const path = join(root, "sessions.db");
  const first = openFactory(path);
  appendEntries(first, "k7m2qx4d", ENTRIES);
  closeDb(first);
  const again = openFactory(path);
  opened.push(again);
  expect(readLog(again, "k7m2qx4d")).toEqual(ENTRIES);
});
