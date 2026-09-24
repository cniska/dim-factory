import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { endWorker, mintWorker, WorkerCredentialUnavailable } from "./factory-worker";
import { SCHEMA_SQL } from "./schema";
import {
  assignWorker,
  bootstrapWorker,
  renewWorkerAssignment,
  resolveAssignedWorker,
} from "./worker-assignment";

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
    const child = bootstrapWorker(db, {
      id: assignment.id,
      token: assignment.token,
      sessionId: "planner-session",
    });

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

  test("returns one worker when a harness retries its assignment bootstrap", () => {
    const db = floor();
    const parent = mintWorker(db, { role: "operator", sessionId: "operator-session" });
    const assignment = assignWorker(db, { parentWorker: parent.name, role: "builder" });
    const first = bootstrapWorker(db, {
      id: assignment.id,
      token: assignment.token,
      sessionId: "builder-session",
    });
    const retried = bootstrapWorker(db, {
      id: assignment.id,
      token: assignment.token,
      sessionId: "builder-session",
      credential: first,
    });

    expect(retried.name).toBe(first.name);
    expect(retried.token).toBe(first.token);
    expect(
      resolveAssignedWorker(db, {
        DIM_WORKER_ASSIGNMENT_ID: assignment.id,
        DIM_WORKER_ASSIGNMENT_TOKEN: assignment.token,
      }),
    ).toBe(first.name);
    expect(() =>
      bootstrapWorker(db, {
        id: assignment.id,
        token: assignment.token,
        sessionId: "builder-session",
      }),
    ).toThrow(WorkerCredentialUnavailable);
    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 2 });
    expect(() =>
      bootstrapWorker(db, { id: assignment.id, token: assignment.token, sessionId: "other-session" }),
    ).toThrow(expect.objectContaining({ code: "assignment_used" }));
    db.close();
  });

  test("keeps assignment provenance when its parent has ended", () => {
    const db = floor();
    const parent = mintWorker(db, { role: "operator", sessionId: "ended-operator-session" });
    const assignment = assignWorker(db, { parentWorker: parent.name, role: "builder" });
    endWorker(db, parent.name);

    const builder = bootstrapWorker(db, {
      id: assignment.id,
      token: assignment.token,
      sessionId: "takeover-builder-session",
    });

    expect(
      db.query("SELECT role, parent_worker FROM factory_worker WHERE name = ?").get(builder.name),
    ).toEqual({
      role: "builder",
      parent_worker: parent.name,
    });
    db.close();
  });

  test("lets the harness assignment authenticate the bootstrapped worker", () => {
    const db = floor();
    const parent = mintWorker(db, { role: "operator", sessionId: "operator-session" });
    const assignment = assignWorker(db, { parentWorker: parent.name, role: "reviewer" });
    const child = bootstrapWorker(db, {
      id: assignment.id,
      token: assignment.token,
      sessionId: "reviewer-session",
    });

    expect(
      resolveAssignedWorker(db, {
        DIM_WORKER_ASSIGNMENT_ID: assignment.id,
        DIM_WORKER_ASSIGNMENT_TOKEN: assignment.token,
      }),
    ).toBe(child.name);
    db.close();
  });

  test("does not let a child choose another assignment's token", () => {
    const db = floor();
    const parent = mintWorker(db, { role: "operator", sessionId: "operator-session" });
    const assignment = assignWorker(db, { parentWorker: parent.name, role: "reviewer" });

    expect(() =>
      bootstrapWorker(db, { id: assignment.id, token: "wrong", sessionId: "reviewer-session" }),
    ).toThrow(expect.objectContaining({ code: "assignment_token" }));
    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 1 });
    db.close();
  });

  test("renews an unused assignment without changing its identity", () => {
    const db = floor();
    const parent = mintWorker(db, { role: "operator", sessionId: "operator-session" });
    const assignment = assignWorker(db, { parentWorker: parent.name, role: "planner" });

    const renewed = renewWorkerAssignment(db, assignment.id);

    expect(renewed.id).toBe(assignment.id);
    expect(renewed.token).not.toBe(assignment.token);
    expect(renewed.parentWorker).toBe(parent.name);
    expect(() => bootstrapWorker(db, { ...assignment, sessionId: "old-session" })).toThrow(
      expect.objectContaining({ code: "assignment_token" }),
    );
    expect(bootstrapWorker(db, { ...renewed, sessionId: "planner-session" }).name).toBeString();
    db.close();
  });
});
