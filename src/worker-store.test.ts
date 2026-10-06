import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { insertSession, insertWorker, workerUsage } from "./worker-store";

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

describe("a worker's usage", () => {
  test("counts its own sessions' responses apart from its subagents', counting cached input as input", () => {
    const db = seeded();
    try {
      expect(workerUsage(db, "axle-2")).toEqual({
        agent: {
          sessions: 1,
          calls: 1,
          tokens: { input: 950, output: 20, cachedRead: 800 },
          context: { brief: 950, tools: 0, messages: 0 },
        },
        subagents: {
          sessions: 1,
          calls: 1,
          tokens: { input: 50, output: 5, cachedRead: 40 },
          context: { brief: 50, tools: 0, messages: 0 },
        },
      });
    } finally {
      db.close();
    }
  });

  test("counts each subagent once, however many calls it made", () => {
    const db = seeded();
    try {
      db.run("INSERT INTO session (id, tool, parent_id) VALUES ('a2@s-axle', 'claude', 's-axle')");
      const usage = db.prepare(
        "INSERT INTO usage (response_id, session_id, ts, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens) VALUES (?, ?, '2026-10-06T10:01:00Z', 1, 0, 0, 1)",
      );
      usage.run("r4", "a1@s-axle");
      usage.run("r5", "a2@s-axle");
      const { subagents } = workerUsage(db, "axle-2");
      expect({ sessions: subagents.sessions, calls: subagents.calls }).toEqual({ sessions: 2, calls: 3 });
    } finally {
      db.close();
    }
  });

  test("is zero for a worker with no responses on record", () => {
    const db = seeded();
    try {
      const none = {
        sessions: 0,
        calls: 0,
        tokens: { input: 0, output: 0, cachedRead: 0 },
        context: { brief: 0, tools: 0, messages: 0 },
      };
      expect(workerUsage(db, "hinge-1")).toEqual({ agent: none, subagents: none });
    } finally {
      db.close();
    }
  });
});
