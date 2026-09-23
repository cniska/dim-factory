import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorker, WORKER_NAME_VAR, WORKER_SESSION_VAR, WORKER_TOKEN_VAR } from "./factory-worker";
import { SCHEMA_SQL } from "./schema";
import { ensureSpoolDirs, toolSpoolDir } from "./spool";
import { ASSIGNMENT_ID_VAR, ASSIGNMENT_TOKEN_VAR } from "./worker-assignment";
import { runWorkerCommand, WorkerCommandError } from "./worker-command";

function floor(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  return db;
}

// The command falls back to `process.env` when no caller names an environment, and every
// builder runs this suite from a shell already carrying a worker, whose name and token
// would then be resolved in place of the one the test issues.
const shell = { DIM_SESSION_ID: "session-under-test" };

describe("starting a worker", () => {
  test("hands the process a worker it can write as", () => {
    const db = floor();
    const out = Bun.spawnSync(["sh", "-c", "true"]);
    expect(out.success).toBe(true);

    runWorkerCommand(db, ["run", "--role", "builder", "--", "sh", "-c", "true"], shell);

    const issued = db.query("SELECT name, role, pid FROM factory_worker").get() as {
      name: string;
      role: string;
      pid: number;
    };
    expect(issued.role).toBe("builder");
    // This process waits for the child, so its pid is what says the worker is still there.
    expect(issued.pid).toBe(process.pid);
    db.close();
  });

  // The whole design rests on the environment being the carrier, so this reads what the
  // child was actually handed rather than what the row says was intended.
  test("the name and the token reach the started process, and resolve there", () => {
    const db = floor();
    const out = join(mkdtempSync(join(tmpdir(), "dim-worker-run-")), "carried");

    runWorkerCommand(
      db,
      [
        "run",
        "--role",
        "builder",
        "--",
        "sh",
        "-c",
        `printf '%s\\n%s' "$${WORKER_NAME_VAR}" "$${WORKER_TOKEN_VAR}" > ${out}`,
      ],
      shell,
    );

    const [name, token] = readFileSync(out, "utf8").split("\n") as [string, string];
    // Ended with the process, so what the child held is read back against a live row.
    db.run("UPDATE factory_worker SET ended_at = NULL");
    expect(resolveWorker(db, { [WORKER_NAME_VAR]: name, [WORKER_TOKEN_VAR]: token })).toBe(name);
    rmSync(out, { force: true });
    db.close();
  });

  test("the worker ends with the process, so its name writes nothing after", () => {
    const db = floor();

    runWorkerCommand(db, ["run", "--role", "builder", "--", "sh", "-c", "true"], shell);

    const ended = db.query("SELECT ended_at FROM factory_worker").get() as { ended_at: string | null };
    expect(ended.ended_at).not.toBeNull();
    db.close();
  });

  test("a process that failed still ends its worker, and says what it exited", () => {
    const db = floor();

    expect(() =>
      runWorkerCommand(db, ["run", "--role", "builder", "--", "sh", "-c", "exit 3"], shell),
    ).toThrow(/exited 3/);

    const ended = db.query("SELECT ended_at FROM factory_worker").get() as { ended_at: string | null };
    expect(ended.ended_at).not.toBeNull();
    db.close();
  });

  test("refuses a run with no command to start", () => {
    const db = floor();

    expect(() => runWorkerCommand(db, ["run", "--role", "builder"], shell)).toThrow(WorkerCommandError);
    expect(() => runWorkerCommand(db, ["run", "--role", "builder", "--"], shell)).toThrow(WorkerCommandError);
    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 0 });
    db.close();
  });
});

describe("issuing a worker to a shell", () => {
  test("a child bootstraps an assignment under its own harness session", () => {
    const db = floor();
    const parentLines = runWorkerCommand(db, ["register", "--role", "operator"], {
      DIM_SESSION_ID: "operator-session",
    }).split("\n");
    const parent: Record<string, string> = {};
    for (const line of parentLines) {
      const [name, value] = line.replace("export ", "").split("=");
      parent[name as string] = value as string;
    }

    const assignmentLines = runWorkerCommand(db, ["assign", "--role", "planner"], parent).split("\n");
    const child: Record<string, string> = { [WORKER_SESSION_VAR]: "planner-session" };
    for (const line of assignmentLines) {
      const [name, value] = line.replace("export ", "").split("=");
      child[name as string] = value as string;
    }

    const bootstrapped = runWorkerCommand(db, ["bootstrap", child[ASSIGNMENT_ID_VAR] as string], child);
    const acceptedEnv: Record<string, string> = { [WORKER_SESSION_VAR]: child[WORKER_SESSION_VAR] as string };
    for (const line of bootstrapped.split("\n")) {
      const [name, value] = line.replace("export ", "").split("=");
      acceptedEnv[name as string] = value as string;
    }

    expect(resolveWorker(db, acceptedEnv)).toBe(acceptedEnv[WORKER_NAME_VAR] as string);
    expect(acceptedEnv[WORKER_TOKEN_VAR]).toBeString();
    expect(child[ASSIGNMENT_TOKEN_VAR]).toBeString();
    db.close();
  });

  test("prints exports a shell can read back into a resolvable worker", () => {
    const db = floor();

    const printed = runWorkerCommand(db, ["register", "--role", "builder"], shell);

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
    const first = runWorkerCommand(db, ["register", "--role", "operator"], { DIM_SESSION_ID: "session-1" });
    const env: Record<string, string> = {};
    for (const line of first.split("\n")) {
      const [name, value] = line.replace("export ", "").split("=");
      env[name as string] = value as string;
    }

    expect(runWorkerCommand(db, ["register", "--role", "operator"], env)).toBe(first);
    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 1 });
    db.close();
  });

  test("refuses to register without a runtime session id", () => {
    const db = floor();
    const home = mkdtempSync(join(tmpdir(), "dim-worker-session-"));
    const env = { DIM_HOME: join(home, "data") };

    expect(() => runWorkerCommand(db, ["register", "--role", "operator"], env)).toThrow(
      /no factory session id is available/,
    );
    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 0 });
    rmSync(home, { recursive: true, force: true });
    db.close();
  });

  test("takes the session from the current harness SessionStart hook", () => {
    const db = floor();
    const home = mkdtempSync(join(tmpdir(), "dim-worker-session-"));
    const cwd = join(home, "project");
    const env = { DIM_HOME: join(home, "data") };
    mkdirSync(cwd);
    ensureSpoolDirs(env);
    writeFileSync(
      join(toolSpoolDir("codex", env), "1770000000000000000-123.json"),
      JSON.stringify({ session_id: "harness-session", hook_event_name: "SessionStart", cwd }),
    );

    const printed = runWorkerCommand(db, ["register", "--role", "operator"], env, cwd);
    const repeated = runWorkerCommand(db, ["register", "--role", "operator"], env, cwd);

    expect(printed).toContain(`export ${WORKER_SESSION_VAR}=harness-session`);
    expect(repeated).toBe(printed);
    expect(db.query("SELECT session_id FROM factory_worker").get()).toEqual({
      session_id: "harness-session",
    });
    rmSync(home, { recursive: true, force: true });
    db.close();
  });

  // The identity a reviewer carries is worth only what the hand it reads cannot reach, so
  // the one command a builder's shell can run must not hand it one.
  test("a read-only hand cannot be registered or run by a caller", () => {
    const db = floor();

    expect(() => runWorkerCommand(db, ["register", "--role", "reviewer"], shell)).toThrow(WorkerCommandError);
    expect(() => runWorkerCommand(db, ["register", "--role", "planner"], shell)).toThrow(
      /issued by the station/,
    );
    expect(() =>
      runWorkerCommand(db, ["run", "--role", "reviewer", "--", "sh", "-c", "true"], shell),
    ).toThrow(/issued by the station/);
    expect(db.query("SELECT count(*) AS n FROM factory_worker").get()).toEqual({ n: 0 });
    db.close();
  });

  test("ending one twice says so rather than failing", () => {
    const db = floor();
    const printed = runWorkerCommand(db, ["register", "--role", "operator"], { DIM_SESSION_ID: "session-2" });
    const name = printed
      .split("\n")
      .find((line) => line.startsWith(`export ${WORKER_NAME_VAR}=`))
      ?.replace(`export ${WORKER_NAME_VAR}=`, "") as string;

    expect(runWorkerCommand(db, ["end", name])).toBe(`${name} ended`);
    expect(runWorkerCommand(db, ["end", name])).toBe(`${name} had already ended`);
    db.close();
  });
});
