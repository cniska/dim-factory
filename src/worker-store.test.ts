import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import { insertSession, insertWorker, workerTokens } from "./worker-store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seeded() {
  const root = mkdtempSync(join(tmpdir(), "dim-worker-store-"));
  roots.push(root);
  const db = openDb(join(root, "sessions.db"));
  insertWorker(db, { role: "operator", name: "hinge-1", project: "acme/widgets" });
  for (const [name, order] of [
    ["axle-2", "k7m2qx4d"],
    ["crank-3", "z9z9z9z9"],
  ] as const) {
    insertWorker(db, { role: "builder", name, project: "acme/widgets", order, createdBy: "hinge-1" });
  }
  const process = { pid: 1, startedAt: "Wed Sep 30 10:00:00 2026" };
  for (const [id, worker] of [
    ["s-axle", "axle-2"],
    ["s-crank", "crank-3"],
  ] as const) {
    insertSession(db, { id, worker, harness: "claude", process });
  }
  db.run(
    "INSERT INTO session (id, tool, parent_id) VALUES ('s-axle', 'claude', NULL), ('a1@s-axle', 'claude', 's-axle'), ('s-crank', 'claude', NULL)",
  );
  const usage = db.prepare(
    "INSERT INTO usage (response_id, session_id, ts, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens) VALUES (?, ?, '2026-10-06T10:00:00Z', ?, ?, ?, ?)",
  );
  usage.run("r1", "s-axle", 100, 800, 50, 20);
  usage.run("r2", "a1@s-axle", 10, 40, 0, 5);
  usage.run("r3", "s-crank", 9999, 9999, 9999, 9999);
  return db;
}

describe("a worker's tokens", () => {
  test("sum every response of its sessions and their subagents, counting cached input as input", () => {
    const db = seeded();
    try {
      expect(workerTokens(db, "axle-2")).toEqual({ input: 1000, output: 25, cachedRead: 840 });
    } finally {
      closeDb(db);
    }
  });

  test("are zero for a worker with no responses on record", () => {
    const db = seeded();
    try {
      expect(workerTokens(db, "hinge-1")).toEqual({ input: 0, output: 0, cachedRead: 0 });
    } finally {
      closeDb(db);
    }
  });
});
