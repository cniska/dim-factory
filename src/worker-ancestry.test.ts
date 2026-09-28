import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SCHEMA_SQL } from "./db-schema";
import {
  clearRunnerBarrier,
  endWorker,
  mintWorker,
  registerRunnerBarrier,
  resolveWorker,
  withRunnerBarrier,
} from "./worker";

function floor(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  return db;
}

function register(db: Database, role: "operator" | "builder", pid: number, start: string): string {
  const worker = mintWorker(db, { role, sessionId: `${role}-${pid}` });
  db.run("UPDATE factory_worker SET pid = ?, process_started_at = ? WHERE name = ?", [
    pid,
    start,
    worker.name,
  ]);
  return worker.name;
}

describe("resolving a caller from its ancestors", () => {
  test("the nearest registered process wins", () => {
    const db = floor();
    register(db, "operator", 100, "operator-start");
    const builder = register(db, "builder", 200, "builder-start");
    expect(
      resolveWorker(db, [
        { pid: 200, startedAt: "builder-start" },
        { pid: 100, startedAt: "operator-start" },
      ]),
    ).toBe(builder);
    db.close();
  });

  test("a runner barrier refuses before the operator", () => {
    const db = floor();
    register(db, "operator", 100, "operator-start");
    db.run("INSERT INTO factory_runner_barrier (pid, process_started_at) VALUES (150, 'runner-start')");
    expect(() =>
      resolveWorker(db, [
        { pid: 150, startedAt: "runner-start" },
        { pid: 100, startedAt: "operator-start" },
      ]),
    ).toThrow(expect.objectContaining({ code: "worker_missing" }));
    db.close();
  });

  test("a runner barrier belongs to its live process and clears on exit", () => {
    const db = floor();
    const operator = register(db, "operator", 100, "operator-start");
    registerRunnerBarrier(db);
    const start = db
      .query<{ process_started_at: string }, [number]>(
        "SELECT process_started_at FROM factory_runner_barrier WHERE pid = ?",
      )
      .get(process.pid)?.process_started_at;
    expect(start).toBeTruthy();
    const ancestry = [
      { pid: process.pid, startedAt: start as string },
      { pid: 100, startedAt: "operator-start" },
    ];
    expect(() => resolveWorker(db, ancestry)).toThrow(expect.objectContaining({ code: "worker_missing" }));
    clearRunnerBarrier(db);
    expect(resolveWorker(db, ancestry)).toBe(operator);
    db.close();
  });

  test("no registered ancestor refuses", () => {
    const db = floor();
    expect(() => resolveWorker(db, [{ pid: 300, startedAt: "caller-start" }])).toThrow(
      expect.objectContaining({ code: "worker_missing" }),
    );
    db.close();
  });

  test("a reused pid does not match the registered process", () => {
    const db = floor();
    register(db, "builder", 200, "old-start");
    expect(() => resolveWorker(db, [{ pid: 200, startedAt: "new-start" }])).toThrow(
      expect.objectContaining({ code: "worker_missing" }),
    );
    db.close();
  });

  test("an ended worker nearer than the operator refuses rather than falling through to it", () => {
    const db = floor();
    register(db, "operator", 100, "operator-start");
    const builder = register(db, "builder", 200, "builder-start");
    endWorker(db, builder);
    expect(() =>
      resolveWorker(db, [
        { pid: 200, startedAt: "builder-start" },
        { pid: 100, startedAt: "operator-start" },
      ]),
    ).toThrow(expect.objectContaining({ code: "worker_over" }));
    db.close();
  });

  test("a barrier held around a call is gone after it, even when the call throws", () => {
    const db = floor();
    const barriers = () => db.query("SELECT count(*) AS n FROM factory_runner_barrier").get();
    expect(withRunnerBarrier(db, () => barriers())).toEqual({ n: 1 });
    expect(barriers()).toEqual({ n: 0 });
    expect(() =>
      withRunnerBarrier(db, () => {
        throw new Error("ship refused");
      }),
    ).toThrow("ship refused");
    expect(barriers()).toEqual({ n: 0 });
    db.close();
  });
});
