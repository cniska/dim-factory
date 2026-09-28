import { Database, SQLiteError } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SCHEMA_SQL } from "./db-schema";
import { processStartTime } from "./pid";
import { endWorker, mintWorker, newWorkerSession, workerIsOver } from "./worker";

function floor(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  return db;
}

function issue(db: Database, role: "operator" | "builder", pid?: number) {
  return mintWorker(db, { role, pid, sessionId: newWorkerSession("test") });
}

describe("issuing a factory worker", () => {
  test("hands out a unique name for each session", () => {
    const db = floor();
    const names = new Set(Array.from({ length: 200 }, () => issue(db, "builder").name));
    expect(names.size).toBe(200);
    db.close();
  });

  test("refuses a second identity for one session", () => {
    const db = floor();
    mintWorker(db, { role: "builder", sessionId: "session-1" });
    expect(() => mintWorker(db, { role: "operator", sessionId: "session-1" })).toThrow(
      expect.objectContaining({ code: "worker_session_taken" }),
    );
    db.close();
  });

  test("reports other unique constraint failures as database errors", () => {
    const db = floor();
    db.run("CREATE UNIQUE INDEX one_builder ON factory_worker(role)");
    mintWorker(db, { role: "builder", sessionId: "session-1" });
    expect(() => mintWorker(db, { role: "builder", sessionId: "session-2" })).toThrow(SQLiteError);
    db.close();
  });

  test("records the worker that requested a child identity", () => {
    const db = floor();
    const parent = issue(db, "operator");
    const child = mintWorker(db, {
      role: "builder",
      parentWorker: parent.name,
      sessionId: "builder-session",
    });
    expect(db.query("SELECT parent_worker FROM factory_worker WHERE name = ?").get(child.name)).toEqual({
      parent_worker: parent.name,
    });
    db.close();
  });

  test("stores the process start time with a registered pid", () => {
    const db = floor();
    const worker = issue(db, "builder", process.pid);
    expect(
      db.query("SELECT pid, process_started_at FROM factory_worker WHERE name = ?").get(worker.name),
    ).toEqual({
      pid: process.pid,
      process_started_at: processStartTime(process.pid),
    });
    db.close();
  });
});

describe("whether a worker is over", () => {
  test("a worker with no registered process is over", () => {
    const db = floor();
    expect(workerIsOver(db, issue(db, "builder").name)).toBe(true);
    expect(workerIsOver(db, issue(db, "operator").name)).toBe(true);
    db.close();
  });

  test("a live pid matches only its recorded start time", () => {
    const db = floor();
    const worker = issue(db, "builder", process.pid);
    expect(workerIsOver(db, worker.name)).toBe(false);
    db.run("UPDATE factory_worker SET process_started_at = '0' WHERE name = ?", [worker.name]);
    expect(workerIsOver(db, worker.name)).toBe(true);
    db.close();
  });

  test("ending a worker twice keeps the first end time", () => {
    const db = floor();
    const worker = issue(db, "builder", process.pid);
    expect(endWorker(db, worker.name, "2026-09-19T10:00:00.000Z")).toBe(true);
    expect(endWorker(db, worker.name, "2026-09-19T11:00:00.000Z")).toBe(false);
    expect(workerIsOver(db, worker.name)).toBe(true);
    db.close();
  });
});
