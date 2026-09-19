import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  endWorker,
  mintWorker,
  resolveWorker,
  WORKER_NAME_VAR,
  WORKER_TOKEN_VAR,
  workerExports,
} from "./factory-worker";
import type { Env } from "./paths";
import { SCHEMA_SQL } from "./schema";

function floor(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  return db;
}

const carried = (minted: { name: string; token: string }): Env => ({
  [WORKER_NAME_VAR]: minted.name,
  [WORKER_TOKEN_VAR]: minted.token,
});

describe("issuing a factory worker", () => {
  test("hands out a name and the secret that proves it", () => {
    const db = floor();
    const minted = mintWorker(db, { role: "builder" });

    expect(minted.name).toMatch(/^[a-z]+-\d+$/);
    expect(resolveWorker(db, carried(minted))).toBe(minted.name);
    db.close();
  });

  test("no two workers are handed the same name", () => {
    const db = floor();
    const names = new Set(Array.from({ length: 200 }, () => mintWorker(db, { role: "builder" }).name));

    expect(names.size).toBe(200);
    db.close();
  });

  test("holds the digest of the token and never the token", () => {
    const db = floor();
    const minted = mintWorker(db, { role: "builder" });

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
    const minted = mintWorker(db, { role: "builder" });

    expect(() =>
      resolveWorker(db, { [WORKER_NAME_VAR]: "nobody-9", [WORKER_TOKEN_VAR]: minted.token }),
    ).toThrow(expect.objectContaining({ code: "worker_unissued" }));
    db.close();
  });

  // The issued set is readable through `dim sql`, so a name on its own is not a claim
  // only its holder can make.
  test("refuses one worker writing under another's name", () => {
    const db = floor();
    const one = mintWorker(db, { role: "builder" });
    const other = mintWorker(db, { role: "builder" });

    expect(() => resolveWorker(db, { [WORKER_NAME_VAR]: other.name, [WORKER_TOKEN_VAR]: one.token })).toThrow(
      expect.objectContaining({ code: "worker_unissued" }),
    );
    db.close();
  });

  test("refuses a worker that has ended", () => {
    const db = floor();
    const minted = mintWorker(db, { role: "builder" });

    expect(endWorker(db, minted.name)).toBe(true);

    expect(() => resolveWorker(db, carried(minted))).toThrow(
      expect.objectContaining({ code: "worker_over" }),
    );
    db.close();
  });

  test("ending a worker twice keeps the time it first stopped", () => {
    const db = floor();
    const minted = mintWorker(db, { role: "builder" });
    endWorker(db, minted.name, "2026-09-19T10:00:00.000Z");

    expect(endWorker(db, minted.name, "2026-09-19T11:00:00.000Z")).toBe(false);
    expect(db.query("SELECT ended_at FROM factory_worker").get()).toEqual({
      ended_at: "2026-09-19T10:00:00.000Z",
    });
    db.close();
  });

  // Nothing writes `ended_at` for a worker that was killed, so the pid is what says so.
  test("refuses a worker whose process is gone, though nothing wrote it down", () => {
    const db = floor();
    const minted = mintWorker(db, { role: "builder", pid: 0x7fffffff });

    expect(() => resolveWorker(db, carried(minted))).toThrow(
      expect.objectContaining({ code: "worker_over" }),
    );
    db.close();
  });

  test("takes a worker whose process is still running", () => {
    const db = floor();
    const minted = mintWorker(db, { role: "builder", pid: process.pid });

    expect(resolveWorker(db, carried(minted))).toBe(minted.name);
    db.close();
  });
});

describe("becoming a worker at a terminal", () => {
  test("prints two lines a shell evaluates into the environment the command reads", () => {
    const db = floor();
    const minted = mintWorker(db, { role: "builder" });

    const env: Env = {};
    for (const line of workerExports(minted).split("\n")) {
      const [name, value] = line.replace("export ", "").split("=");
      env[name as string] = value;
    }

    expect(resolveWorker(db, env)).toBe(minted.name);
    db.close();
  });
});
