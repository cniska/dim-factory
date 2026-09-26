import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "./cli-contract";
import { SCHEMA_SQL } from "./db-schema";
import { ensureSpoolDirs, toolSpoolDir } from "./ingest-spool";
import { runOperatorCommand } from "./operator-command";
import { mintWorker, newWorkerSession, resolveWorker, WORKER_NAME_VAR, WORKER_SESSION_VAR } from "./worker";

function floor(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  return db;
}

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function shell(
  sessionId = newWorkerSession("operator-command-test"),
  cwd = process.cwd(),
): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "dim-operator-shell-"));
  homes.push(home);
  const env = { DIM_HOME: join(home, "data") };
  ensureSpoolDirs(env);
  writeFileSync(
    join(toolSpoolDir("codex", env), "1770000000000000000-123.json"),
    JSON.stringify({ session_id: sessionId, hook_event_name: "SessionStart", cwd }),
  );
  return env;
}

describe("resolving the project's operator session", () => {
  test("prints exports a shell can read back into a resolvable worker", () => {
    const db = floor();

    const printed = runOperatorCommand(db, [], shell());

    const env: Record<string, string> = {};
    for (const line of printed.split("\n")) {
      const [name, value] = line.replace("export ", "").split("=");
      env[name as string] = value as string;
    }
    expect(resolveWorker(db, env)).toBe(env[WORKER_NAME_VAR] as string);
    db.close();
  });

  test("reuses the identity already carried by a session", () => {
    const db = floor();
    const env = shell("session-1");
    const first = runOperatorCommand(db, [], env);
    for (const line of first.split("\n")) {
      const [name, value] = line.replace("export ", "").split("=");
      env[name as string] = value as string;
    }

    expect(runOperatorCommand(db, [], env)).toBe(first);
    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 1 });
    db.close();
  });

  test("recovers the session identity when the shell lost its exported credentials", () => {
    const db = floor();
    const env = shell("session-recover");
    const first = runOperatorCommand(db, [], env);

    expect(runOperatorCommand(db, [], env)).toBe(first);
    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 1 });
    db.close();
  });

  test("resolves the sole active hook session instead of trusting a supplied session id", () => {
    const db = floor();
    const env = shell("hook-session");
    env.CODEX_THREAD_ID = "spoofed-session";

    const printed = runOperatorCommand(db, [], env);

    expect(printed).toContain(`export ${WORKER_SESSION_VAR}=hook-session`);
    expect(db.query("SELECT session_id FROM factory_worker").get()).toEqual({
      session_id: "hook-session",
    });
    db.close();
  });

  test("uses the supplied harness id to choose among active project sessions", () => {
    const db = floor();
    const env = shell("first-session");
    env.CODEX_THREAD_ID = "first-session";
    writeFileSync(
      join(toolSpoolDir("codex", env), "1770000000000000001-123.json"),
      JSON.stringify({
        session_id: "second-session",
        hook_event_name: "SessionStart",
        cwd: process.cwd(),
      }),
    );

    const printed = runOperatorCommand(db, [], env);

    expect(printed).toContain(`export ${WORKER_SESSION_VAR}=first-session`);
    expect(db.query("SELECT session_id FROM factory_worker").get()).toEqual({
      session_id: "first-session",
    });
    db.close();
  });

  test("checks the second harness id when the first is not active", () => {
    const db = floor();
    const env = shell("claude-session");
    const cwd = process.cwd();
    env.CODEX_THREAD_ID = "codex-session";
    env.CLAUDE_CODE_SESSION_ID = "claude-session";
    writeFileSync(
      join(toolSpoolDir("codex", env), "1770000000000000001-123.json"),
      JSON.stringify({ session_id: "another-session", hook_event_name: "SessionStart", cwd }),
    );

    const printed = runOperatorCommand(db, [], env, cwd);

    expect(printed).toContain(`export ${WORKER_SESSION_VAR}=claude-session`);
    expect(db.query("SELECT session_id FROM factory_worker").get()).toEqual({
      session_id: "claude-session",
    });
    db.close();
  });

  test("keeps refusing when supplied harness ids do not identify an active project session", () => {
    const db = floor();
    const env = shell("first-session");
    env.CODEX_THREAD_ID = "unmatched-session";
    writeFileSync(
      join(toolSpoolDir("codex", env), "1770000000000000001-123.json"),
      JSON.stringify({
        session_id: "second-session",
        hook_event_name: "SessionStart",
        cwd: process.cwd(),
      }),
    );

    expect(() => runOperatorCommand(db, [], env)).toThrow(/more than one active operator session/);
    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 0 });
    db.close();
  });

  test("does not count an active station worker as an operator session", () => {
    const db = floor();
    const env = shell("operator-session");
    mintWorker(db, { role: "builder", sessionId: "builder-session" });
    writeFileSync(
      join(toolSpoolDir("codex", env), "1770000000000000001-123.json"),
      JSON.stringify({
        session_id: "builder-session",
        hook_event_name: "SessionStart",
        cwd: process.cwd(),
      }),
    );

    const printed = runOperatorCommand(db, [], env);

    expect(printed).toContain(`export ${WORKER_SESSION_VAR}=operator-session`);
    expect(db.query("SELECT role, session_id FROM factory_worker ORDER BY role").all()).toEqual([
      { role: "builder", session_id: "builder-session" },
      { role: "operator", session_id: "operator-session" },
    ]);
    db.close();
  });

  test("the operator command has no caller-selected identity", () => {
    const db = floor();
    const env = shell();
    runOperatorCommand(db, [], env);

    expect(() => runOperatorCommand(db, ["--role", "builder"], env)).toThrow(UsageError);
    expect(() => runOperatorCommand(db, ["--pid", "123"], env)).toThrow(UsageError);
    expect(db.query("SELECT role FROM factory_worker").get()).toEqual({ role: "operator" });
    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 1 });
    db.close();
  });

  test("refuses to replace a worker credential from the session id alone", () => {
    const db = floor();
    const home = mkdtempSync(join(tmpdir(), "dim-worker-credential-"));
    homes.push(home);
    const env = { DIM_HOME: join(home, "data"), CODEX_THREAD_ID: "session-reissue" };
    ensureSpoolDirs(env);
    writeFileSync(
      join(toolSpoolDir("codex", env), "1770000000000000000-123.json"),
      JSON.stringify({
        session_id: env.CODEX_THREAD_ID,
        hook_event_name: "SessionStart",
        cwd: process.cwd(),
      }),
    );
    const first = runOperatorCommand(db, [], env);
    const firstEnv: Record<string, string> = {};
    for (const line of first.split("\n")) {
      const [name, value] = line.replace("export ", "").split("=");
      firstEnv[name as string] = value as string;
    }
    rmSync(
      join(
        env.DIM_HOME,
        "worker-credentials",
        `${createHash("sha256").update(env.CODEX_THREAD_ID).digest("hex")}.json`,
      ),
    );

    const digestBefore = db.query("SELECT token_digest FROM factory_worker").get();
    expect(() => runOperatorCommand(db, [], env)).toThrow(
      expect.objectContaining({ code: "worker_credential_unavailable" }),
    );
    expect(db.query("SELECT token_digest FROM factory_worker").get()).toEqual(digestBefore);
    expect(resolveWorker(db, firstEnv)).toBe(firstEnv[WORKER_NAME_VAR] as string);
    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 1 });
    rmSync(home, { recursive: true, force: true });
    db.close();
  });

  test("refuses without an active session hook", () => {
    const db = floor();
    const home = mkdtempSync(join(tmpdir(), "dim-worker-session-"));
    const env = { DIM_HOME: join(home, "data") };

    expect(() => runOperatorCommand(db, [], env)).toThrow(/no active harness session is recorded/);
    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 0 });
    rmSync(home, { recursive: true, force: true });
    db.close();
  });

  test("resolves the project's session when the invocation cwd changes", () => {
    const db = floor();
    const env = shell("harness-session");
    const cwd = join(process.cwd(), "src");

    const printed = runOperatorCommand(db, [], env, cwd);
    const repeated = runOperatorCommand(db, [], env, cwd);

    expect(printed).toContain(`export ${WORKER_SESSION_VAR}=harness-session`);
    expect(repeated).toBe(printed);
    expect(db.query("SELECT session_id FROM factory_worker").get()).toEqual({
      session_id: "harness-session",
    });
    db.close();
  });

  test("refuses to choose between active operator sessions in one checkout", () => {
    const db = floor();
    const env = shell("first-session");
    const cwd = process.cwd();
    writeFileSync(
      join(toolSpoolDir("codex", env), "1770000000000000001-123.json"),
      JSON.stringify({ session_id: "second-session", hook_event_name: "SessionStart", cwd }),
    );

    expect(() => runOperatorCommand(db, [], env, cwd)).toThrow(/more than one active operator session/);
    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 0 });
    db.close();
  });

  test("refuses active operator sessions for the same project in different directories", () => {
    const db = floor();
    const env = shell("first-session");
    writeFileSync(
      join(toolSpoolDir("codex", env), "1770000000000000001-123.json"),
      JSON.stringify({
        session_id: "second-session",
        hook_event_name: "SessionStart",
        cwd: join(process.cwd(), "src"),
      }),
    );

    expect(() => runOperatorCommand(db, [], env)).toThrow(/more than one active operator session/);
    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 0 });
    db.close();
  });
});
