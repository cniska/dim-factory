import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "./cli-contract";
import { SCHEMA_SQL } from "./db-schema";
import { ensureSpoolDirs, toolSpoolDir } from "./ingest-spool";
import { runOperatorCommand } from "./operator-command";
import type { ProcessIdentity } from "./pid";
import { mintWorker } from "./worker";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function floor(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  return db;
}

function session(sessionId = "operator-session", pid = 100, nanos = "1789000000000000000") {
  const root = mkdtempSync(join(tmpdir(), "dim-operator-ancestry-"));
  roots.push(root);
  const env = { DIM_HOME: join(root, "data") };
  ensureSpoolDirs(env);
  writeFileSync(
    join(toolSpoolDir("codex", env), `${nanos}-4242-${pid}-.json`),
    JSON.stringify({ session_id: sessionId, hook_event_name: "SessionStart", cwd: process.cwd() }),
  );
  return env;
}

const harness: ProcessIdentity = { pid: 100, startedAt: "1000000" };

describe("registering the operator from its harness", () => {
  test("registers the sole session under its ancestor harness", () => {
    const db = floor();
    const result = runOperatorCommand(db, [], session(), process.cwd(), [harness]);
    expect(db.query("SELECT name, role, pid, process_started_at FROM factory_worker").get()).toEqual({
      name: result,
      role: "operator",
      pid: 100,
      process_started_at: "1000000",
    });
    db.close();
  });

  test("refuses an already registered worker beneath that harness", () => {
    const db = floor();
    const env = session();
    mintWorker(db, {
      role: "builder",
      sessionId: "builder-session",
      pid: 200,
      processStartedAt: "2000000",
    });
    expect(() =>
      runOperatorCommand(db, [], env, process.cwd(), [{ pid: 200, startedAt: "2000000" }, harness]),
    ).toThrow(UsageError);
    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 1 });
    db.close();
  });

  test("refuses a caller outside the session's harness", () => {
    const db = floor();
    expect(() =>
      runOperatorCommand(db, [], session(), process.cwd(), [{ pid: 300, startedAt: "3000000" }]),
    ).toThrow(/has its harness above this process/);
    db.close();
  });

  test("refuses a harness that started after SessionStart", () => {
    const db = floor();
    const startedAfter: ProcessIdentity = { pid: 100, startedAt: "9999999999999999" };
    expect(() => runOperatorCommand(db, [], session(), process.cwd(), [startedAfter])).toThrow(
      /has its harness above this process/,
    );
    db.close();
  });

  test("refuses through a runner barrier", () => {
    const db = floor();
    db.run("INSERT INTO factory_runner_barrier (pid, process_started_at) VALUES (200, '2000000')");
    expect(() =>
      runOperatorCommand(db, [], session(), process.cwd(), [{ pid: 200, startedAt: "2000000" }, harness]),
    ).toThrow(UsageError);
    db.close();
  });

  test("names the same operator on a second call from beneath its harness", () => {
    const db = floor();
    const env = session();
    const first = runOperatorCommand(db, [], env, process.cwd(), [harness]);
    expect(
      runOperatorCommand(db, [], env, process.cwd(), [{ pid: 300, startedAt: "3000000" }, harness]),
    ).toBe(first);
    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 1 });
    db.close();
  });

  test("refuses to choose between two active sessions whose harness is the same caller's ancestor", () => {
    const db = floor();
    const env = session();
    writeFileSync(
      join(toolSpoolDir("codex", env), "1789000000000000001-4242-100-.json"),
      JSON.stringify({ session_id: "other-session", hook_event_name: "SessionStart", cwd: process.cwd() }),
    );
    expect(() => runOperatorCommand(db, [], env, process.cwd(), [harness])).toThrow(
      /more than one active session/,
    );
    db.close();
  });

  test("takes the one active session whose harness is above the caller, whatever else is active", () => {
    const db = floor();
    const env = session();
    writeFileSync(
      join(toolSpoolDir("codex", env), "1789000000000000001-4242-900-.json"),
      JSON.stringify({ session_id: "other-terminal", hook_event_name: "SessionStart", cwd: process.cwd() }),
    );
    const name = runOperatorCommand(db, [], env, process.cwd(), [harness]);
    expect(db.query("SELECT session_id FROM factory_worker WHERE name = ?").get(name)).toEqual({
      session_id: "operator-session",
    });
    db.close();
  });

  test("never takes a station worker's session as the operator's", () => {
    const db = floor();
    const env = session();
    mintWorker(db, { role: "builder", sessionId: "operator-session" });
    expect(() => runOperatorCommand(db, [], env, process.cwd(), [harness])).toThrow(
      /no active harness session is recorded/,
    );
    db.close();
  });

  test("refuses without a SessionStart event", () => {
    const db = floor();
    const root = mkdtempSync(join(tmpdir(), "dim-operator-empty-"));
    roots.push(root);
    expect(() =>
      runOperatorCommand(db, [], { DIM_HOME: join(root, "data") }, process.cwd(), [harness]),
    ).toThrow(/no active harness session/);
    db.close();
  });
});
