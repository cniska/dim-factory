import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SCHEMA_SQL } from "./db-schema";
import { processStartTime } from "./pid";
import { endWorker, mintWorker } from "./worker";
import { assignWorker, bootstrapWorker } from "./worker-assignment";

function floor(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  return db;
}

describe("worker assignments", () => {
  test("creates a child only when its harness session bootstraps", () => {
    const db = floor();
    const parent = mintWorker(db, { role: "operator", sessionId: "operator-session" });
    const assignment = assignWorker(db, { parentWorker: parent.name, role: "planner" });

    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 1 });
    const child = bootstrapWorker(db, { id: assignment.id, sessionId: "planner-session" });

    expect(db.query("SELECT role, parent_worker FROM factory_worker WHERE name = ?").get(child.name)).toEqual(
      {
        role: "planner",
        parent_worker: parent.name,
      },
    );
    expect(
      db.query("SELECT accepted_worker FROM factory_worker_assignment WHERE id = ?").get(assignment.id),
    ).toEqual({
      accepted_worker: child.name,
    });
    db.close();
  });

  test("returns one worker when a harness retries its assignment bootstrap, and registers its new process", () => {
    const db = floor();
    const parent = mintWorker(db, { role: "operator", sessionId: "operator-session" });
    const assignment = assignWorker(db, { parentWorker: parent.name, role: "builder" });
    const first = bootstrapWorker(db, { id: assignment.id, sessionId: "builder-session" });
    const retried = bootstrapWorker(db, {
      id: assignment.id,
      sessionId: "builder-session",
      pid: process.pid,
    });

    expect(retried.name).toBe(first.name);
    expect(
      db.query("SELECT pid, process_started_at FROM factory_worker WHERE name = ?").get(first.name),
    ).toEqual({ pid: process.pid, process_started_at: processStartTime(process.pid) });
    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 2 });
    expect(() => bootstrapWorker(db, { id: assignment.id, sessionId: "other-session" })).toThrow(
      expect.objectContaining({ code: "assignment_used" }),
    );
    db.close();
  });

  test("refuses to re-register a worker that has ended", () => {
    const db = floor();
    const parent = mintWorker(db, { role: "operator", sessionId: "operator-session" });
    const assignment = assignWorker(db, { role: "builder", parentWorker: parent.name });
    const child = bootstrapWorker(db, { id: assignment.id, sessionId: "builder-session" });
    endWorker(db, child.name);

    expect(() => bootstrapWorker(db, { id: assignment.id, sessionId: "builder-session" })).toThrow(
      expect.objectContaining({ code: "worker_over" }),
    );
    db.close();
  });

  test("keeps assignment provenance when its parent has ended", () => {
    const db = floor();
    const parent = mintWorker(db, { role: "operator", sessionId: "ended-operator-session" });
    const assignment = assignWorker(db, { parentWorker: parent.name, role: "builder" });
    endWorker(db, parent.name);

    const builder = bootstrapWorker(db, { id: assignment.id, sessionId: "takeover-builder-session" });

    expect(
      db.query("SELECT role, parent_worker FROM factory_worker WHERE name = ?").get(builder.name),
    ).toEqual({
      role: "builder",
      parent_worker: parent.name,
    });
    db.close();
  });

  test("records the worker accepted through a harness assignment", () => {
    const db = floor();
    const parent = mintWorker(db, { role: "operator", sessionId: "operator-session" });
    const assignment = assignWorker(db, { parentWorker: parent.name, role: "reviewer" });
    const child = bootstrapWorker(db, { id: assignment.id, sessionId: "reviewer-session" });

    expect(
      db.query("SELECT accepted_worker FROM factory_worker_assignment WHERE id = ?").get(assignment.id),
    ).toEqual({ accepted_worker: child.name });
    db.close();
  });

  test("refuses an assignment the factory never made", () => {
    const db = floor();
    expect(() => bootstrapWorker(db, { id: "assignment-unknown", sessionId: "reviewer-session" })).toThrow(
      expect.objectContaining({ code: "assignment_missing" }),
    );
    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 0 });
    db.close();
  });
});
