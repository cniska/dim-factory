import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  endWorker,
  mintWorker,
  newWorkerSession,
  resolveWorker,
  WORKER_NAME_VAR,
  WORKER_TOKEN_VAR,
  workerExports,
  workerIsOver,
} from "./factory-worker";
import type { Env } from "./paths";
import { SCHEMA_SQL } from "./schema";

function floor(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  return db;
}

function issue(
  db: Database,
  worker: Omit<Parameters<typeof mintWorker>[1], "sessionId"> & { sessionId?: string },
): ReturnType<typeof mintWorker> {
  return mintWorker(db, { ...worker, sessionId: worker.sessionId ?? newWorkerSession("test") });
}

const carried = (minted: { name: string; token: string }): Env => ({
  [WORKER_NAME_VAR]: minted.name,
  [WORKER_TOKEN_VAR]: minted.token,
});

describe("issuing a factory worker", () => {
  test("hands out a name and the secret that proves it", () => {
    const db = floor();
    const minted = issue(db, { role: "builder" });

    expect(minted.name).toMatch(/^[a-z]+-\d+$/);
    expect(resolveWorker(db, carried(minted))).toBe(minted.name);
    db.close();
  });

  test("no two workers are handed the same name", () => {
    const db = floor();
    const names = new Set(Array.from({ length: 200 }, () => issue(db, { role: "builder" }).name));

    expect(names.size).toBe(200);
    db.close();
  });

  test("refuses a second identity for one session", () => {
    const db = floor();
    mintWorker(db, { role: "builder", sessionId: "session-1" });

    expect(() => mintWorker(db, { role: "operator", sessionId: "session-1" })).toThrow(
      expect.objectContaining({ code: "worker_session_taken" }),
    );
    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 1 });
    db.close();
  });

  test("records the worker that requested a child identity", () => {
    const db = floor();
    const parent = mintWorker(db, { role: "operator", sessionId: "operator-session" });
    const child = mintWorker(db, {
      role: "builder",
      parentWorker: parent.name,
      sessionId: "operator-session/builder-session",
    });

    expect(db.query("SELECT role, parent_worker FROM factory_worker WHERE name = ?").get(child.name)).toEqual(
      {
        role: "builder",
        parent_worker: parent.name,
      },
    );
    db.close();
  });

  test("requires a known parent and preserves it after the parent ends", () => {
    const db = floor();

    expect(() => issue(db, { role: "builder", parentWorker: "missing-1" })).toThrow(
      "parent worker missing-1 does not exist",
    );
    const parent = issue(db, { role: "operator" });
    endWorker(db, parent.name);
    const child = issue(db, { role: "builder", parentWorker: parent.name });
    expect(db.query("SELECT parent_worker FROM factory_worker WHERE name = ?").get(child.name)).toEqual({
      parent_worker: parent.name,
    });
    db.close();
  });

  test("holds the digest of the token and never the token", () => {
    const db = floor();
    const minted = issue(db, { role: "builder" });

    const stored = db.query("SELECT token_digest FROM factory_worker").get() as { token_digest: string };
    expect(stored.token_digest).not.toBe(minted.token);
    expect(stored.token_digest).toHaveLength(64);
    db.close();
  });
});

describe("reading which worker a command is", () => {
  test("says nothing names it where the environment carries no worker", () => {
    const db = floor();

    expect(() => resolveWorker(db, {})).toThrow(expect.objectContaining({ code: "worker_missing" }));
    db.close();
  });

  test("refuses a name this factory never issued", () => {
    const db = floor();
    const minted = issue(db, { role: "builder" });

    expect(() =>
      resolveWorker(db, { [WORKER_NAME_VAR]: "nobody-9", [WORKER_TOKEN_VAR]: minted.token }),
    ).toThrow(expect.objectContaining({ code: "worker_unissued" }));
    db.close();
  });

  test("refuses one worker writing under another's name", () => {
    const db = floor();
    const one = issue(db, { role: "builder" });
    const other = issue(db, { role: "builder" });

    expect(() => resolveWorker(db, { [WORKER_NAME_VAR]: other.name, [WORKER_TOKEN_VAR]: one.token })).toThrow(
      expect.objectContaining({ code: "worker_unissued" }),
    );
    db.close();
  });

  test("refuses a worker that has ended", () => {
    const db = floor();
    const minted = issue(db, { role: "builder" });

    expect(endWorker(db, minted.name)).toBe(true);

    expect(() => resolveWorker(db, carried(minted))).toThrow(
      expect.objectContaining({ code: "worker_over" }),
    );
    db.close();
  });

  test("ending a worker twice keeps the time it first stopped", () => {
    const db = floor();
    const minted = issue(db, { role: "builder" });
    endWorker(db, minted.name, "2026-09-19T10:00:00.000Z");

    expect(endWorker(db, minted.name, "2026-09-19T11:00:00.000Z")).toBe(false);
    expect(db.query("SELECT ended_at FROM factory_worker").get()).toEqual({
      ended_at: "2026-09-19T10:00:00.000Z",
    });
    db.close();
  });

  test("refuses a worker whose process is gone, though nothing wrote it down", () => {
    const db = floor();
    const minted = issue(db, { role: "builder", pid: 0x7fffffff });

    expect(() => resolveWorker(db, carried(minted))).toThrow(
      expect.objectContaining({ code: "worker_over" }),
    );
    db.close();
  });

  test("takes a worker whose process is still running", () => {
    const db = floor();
    const minted = issue(db, { role: "builder", pid: process.pid });

    expect(resolveWorker(db, carried(minted))).toBe(minted.name);
    db.close();
  });
});

describe("whether a worker is over", () => {
  test.each(["planner", "builder", "reviewer"] as const)("a %s with no recorded pid is over", (role) => {
    const db = floor();

    expect(workerIsOver(db, issue(db, { role }).name)).toBe(true);
    db.close();
  });

  test("an operator with no recorded pid is not over", () => {
    const db = floor();

    expect(workerIsOver(db, issue(db, { role: "operator" }).name)).toBe(false);
    db.close();
  });

  test("a station worker whose pid answers is not over, and one whose pid is gone is", () => {
    const db = floor();

    expect(workerIsOver(db, issue(db, { role: "reviewer", pid: process.pid }).name)).toBe(false);
    expect(workerIsOver(db, issue(db, { role: "reviewer", pid: Bun.spawnSync(["true"]).pid }).name)).toBe(
      true,
    );
    db.close();
  });
});

describe("becoming a worker at a terminal", () => {
  test("prints two lines a shell evaluates into the environment the command reads", () => {
    const db = floor();
    const minted = issue(db, { role: "builder" });

    const env: Env = {};
    for (const line of workerExports(minted).split("\n")) {
      const [name, value] = line.replace("export ", "").split("=");
      env[name as string] = value;
    }

    expect(resolveWorker(db, env)).toBe(minted.name);
    db.close();
  });
});
