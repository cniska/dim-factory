import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "./command";
import { approveOrderPlan, recordOrderPlan } from "./factory-order-artifacts";
import { moveOrder } from "./factory-order-lifecycle";
import { pullStop } from "./factory-stop";
import { assembleWallSnapshot } from "./factory-wall";
import {
  mintWorker,
  newWorkerSession,
  resolveWorker,
  WORKER_NAME_VAR,
  WORKER_TOKEN_VAR,
} from "./factory-worker";
import { collectingMachine, integratedRepo, scratchEnv } from "./fixtures.test-support";
import { hookConfigPath } from "./hooks";
import { runOrderCommand as runCommand, runOrderCommandLive } from "./order-command";
import type { Env } from "./paths";
import { SCHEMA_SQL } from "./schema";
import { TOOLS } from "./tools";

const opened: Database[] = [];

let env: Env = {};

const machine = collectingMachine();

function db(): Database {
  const database = new Database(":memory:");
  database.run(SCHEMA_SQL);
  const operator = mintWorker(database, { role: "operator", sessionId: newWorkerSession("test-operator") });
  env = { ...machine.env, [WORKER_NAME_VAR]: operator.name, [WORKER_TOKEN_VAR]: operator.token };
  opened.push(database);
  return database;
}

function runOrderCommand(
  database: Database,
  args: string[],
  project: string | null = null,
  cwd: string = trunk.dir,
  as: Env = env,
): string {
  return runCommand(database, args, project, cwd, as) as string;
}

const trunk = integratedRepo();
afterAll(() => {
  for (const database of opened) database.close();
  rmSync(trunk.dir, { recursive: true, force: true });
  rmSync(machine.dir, { recursive: true, force: true });
});

function landed(database: Database, orderId: string): void {
  runOrderCommand(database, ["commit", orderId, "--sha", trunk.sha, "--subject", "feat: land it"]);
  runOrderCommand(database, ["check", orderId, "--command", "bun run verify", "--exit", "0"]);
}

const add = [
  "add",
  "order-1",
  "--title",
  "Record a factory order as work is taken",
  "--description",
  "The record holds what an order is called and never what it says.",
  "--line",
  "fix",
  "--project",
  "cniska/dim-factory",
];

const claim = ["claim", "order-1", "--run", "run-1", "--station", "dim-station-build"];
const planClaim = ["claim", "order-1", "--run", "run-1", "--station", "dim-station-plan"];

function queued(database: Database): void {
  runOrderCommand(database, add);
}

function operatorEnv(database: Database): Env {
  const operator = mintWorker(database, { role: "operator", sessionId: newWorkerSession("test-operator") });
  return { ...machine.env, [WORKER_NAME_VAR]: operator.name, [WORKER_TOKEN_VAR]: operator.token };
}

describe("order command", () => {
  test("an added order waits on the board under its own name", () => {
    const database = db();

    expect(runOrderCommand(database, add)).toBe("queued order-1 on cniska/dim-factory");

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 1, active: 0, done: 0 });
    expect(snapshot.orders[0]?.title).toBe("Record a factory order as work is taken");
    expect(snapshot.orders[0]?.line).toBe("fix");
    expect(snapshot.orders[0]?.status).toBe("queued");
  });

  test("an unknown order line is refused", () => {
    const database = db();

    expect(() =>
      runOrderCommand(database, [...add.slice(0, 6), "--line", "unknown", ...add.slice(8)]),
    ).toThrow("unknown is not a line; one of feat, fix");
  });

  test("a delegation resolves its model through the harness it names", async () => {
    const database = db();
    runOrderCommand(database, add);
    runOrderCommand(database, planClaim);

    await expect(
      runOrderCommandLive(database, ["plan", "order-1", "--harness", "claude"], null, trunk.dir, env),
    ).rejects.toThrow(
      expect.objectContaining({ kind: "no-map", message: expect.stringContaining('{ "claude": {') }),
    );
    expect(database.query("SELECT role, harness FROM factory_order_worker").all()).toEqual([
      { role: "planner", harness: "claude" },
    ]);
  });

  test("a build and a review resolve their models through the harness they name", async () => {
    const noClaudeMap = expect.objectContaining({
      kind: "no-map",
      message: expect.stringContaining('{ "claude": {'),
    });
    const database = db();
    queued(database);
    runOrderCommand(database, claim);
    runOrderCommand(database, ["commit", "order-1", "--sha", "abc123", "--subject", "feat: land it"]);

    await expect(
      runOrderCommandLive(database, ["review", "order-1", "--harness", "claude"], null, trunk.dir, env),
    ).rejects.toThrow(noClaudeMap);

    const operator = resolveWorker(database, env);
    moveOrder(database, "order-1", "dim-station-plan", operator);
    const planner = mintWorker(database, {
      role: "planner",
      parentWorker: operator,
      sessionId: "planner-session",
    });
    recordOrderPlan(database, "order-1", "## Outcome\n\nBuild it.", planner.name, [
      { title: "Build it", outcome: "It is verified." },
    ]);
    approveOrderPlan(database, "order-1", operator);
    moveOrder(database, "order-1", "dim-station-build", operator);

    await expect(
      runOrderCommandLive(database, ["build", "order-1", "--harness", "claude"], null, trunk.dir, env),
    ).rejects.toThrow('{ "claude": {');
    expect(database.query("SELECT role, harness FROM factory_order_worker ORDER BY role").all()).toEqual([
      { role: "builder", harness: "claude" },
      { role: "reviewer", harness: "claude" },
    ]);
  });

  test("a delegation that names no harness runs under the one its operator is recorded in", async () => {
    const database = db();
    runOrderCommand(database, add);
    runOrderCommand(database, planClaim);
    const operator = resolveWorker(database, env);
    const session = database
      .query<{ session_id: string }, [string]>("SELECT session_id FROM factory_worker WHERE name = ?")
      .get(operator)?.session_id;
    mintWorker(database, { role: "builder", sessionId: "another-session" });
    const recorded =
      "INSERT INTO hook_event (tool, session_id, event, ts, payload) VALUES (?, ?, ?, ?, '{}')";
    database.run(recorded, ["codex", "another-session", "session_start", "2025-12-31T00:00:00Z"]);
    database.run(recorded, ["codex", session ?? "", "post_tool_use", "2025-12-31T00:00:00Z"]);
    database.run(recorded, ["claude", session ?? "", "session_start", "2026-01-01T00:00:00Z"]);

    await expect(runOrderCommandLive(database, ["plan", "order-1"], null, trunk.dir, env)).rejects.toThrow(
      expect.objectContaining({ kind: "no-map", message: expect.stringContaining('{ "claude": {') }),
    );
    expect(database.query("SELECT role, harness FROM factory_order_worker").all()).toEqual([
      { role: "planner", harness: "claude" },
    ]);
  });

  test("a delegation that names no harness is refused when the record holds none for its operator", async () => {
    const database = db();
    runOrderCommand(database, add);
    const operator = resolveWorker(database, env);

    const refusal = `${operator} runs in no recorded harness session; delegate with --harness <codex|claude>`;
    for (const station of ["plan", "build", "review"]) {
      await expect(runOrderCommandLive(database, [station, "order-1"], null, trunk.dir, env)).rejects.toThrow(
        refusal,
      );
    }
    expect(database.query("SELECT count(*) AS n FROM factory_order_worker").get()).toEqual({ n: 0 });
  });

  test("a delegation to a harness with no adapter is refused", async () => {
    const database = db();
    runOrderCommand(database, add);

    for (const station of ["plan", "build", "review"]) {
      await expect(
        runOrderCommandLive(database, [station, "order-1", "--harness", "gemini"], null, trunk.dir, env),
      ).rejects.toThrow("gemini: unsupported harness; supported harnesses: codex, claude");
    }
  });

  test("a claim moves it into the active column", () => {
    const database = db();
    queued(database);

    expect(runOrderCommand(database, claim)).toBe("order-1 is working");

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 0, active: 1, done: 0 });
    expect(snapshot.orders[0]?.status).toBe("working");
    expect(snapshot.orders[0]?.station).toBe("build");
  });

  test("an order keeps the description it was queued with", () => {
    const database = db();

    queued(database);
    runOrderCommand(database, claim);

    expect(database.query("SELECT description FROM factory_order WHERE id = 'order-1'").get()).toEqual({
      description: "The record holds what an order is called and never what it says.",
    });
  });

  test("an order queued with no description records without one", () => {
    const database = db();
    const at = add.indexOf("--description");

    runOrderCommand(database, [...add.slice(0, at), ...add.slice(at + 2)]);

    expect(database.query("SELECT description FROM factory_order WHERE id = 'order-1'").get()).toEqual({
      description: null,
    });
  });

  test("a move sends the card to the station the work is at now", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

    expect(runOrderCommand(database, ["move", "order-1", "--station", "dim-station-review"])).toBe(
      "order-1 moved to dim-station-review",
    );

    expect(assembleWallSnapshot(database).orders[0]?.station).toBe("review");
  });

  test("a move with no station to move to is refused", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

    expect(() => runOrderCommand(database, ["move", "order-1"])).toThrow(UsageError);

    expect(assembleWallSnapshot(database).orders[0]?.station).toBe("build");
  });

  test("a ship lands the order's own commits on the trunk", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);
    const wt = join(trunk.dir, ".claude", "worktrees", "order-1");
    writeFileSync(join(wt, "ship-a.txt"), "a");
    Bun.spawnSync(["git", "-C", wt, "add", "."]);
    Bun.spawnSync(["git", "-C", wt, "commit", "-q", "-m", "feat: ship-a"]);
    const sha = Bun.spawnSync(["git", "-C", wt, "rev-parse", "HEAD"], { stdout: "pipe" })
      .stdout.toString()
      .trim();
    runOrderCommand(database, ["commit", "order-1", "--sha", sha, "--subject", "feat: ship-a"]);

    expect(runOrderCommand(database, ["ship", "order-1"], null, wt)).toBe(
      "order-1 is fast-forwarded onto the trunk",
    );

    expect(Bun.spawnSync(["git", "-C", trunk.dir, "merge-base", "--is-ancestor", sha, "HEAD"]).success).toBe(
      true,
    );
    expect(
      database
        .query("SELECT kind, outcome FROM factory_order_delivery WHERE order_id = ? ORDER BY id")
        .all("order-1"),
    ).toEqual([
      { kind: "integration", outcome: "succeeded" },
      { kind: "delivery", outcome: "succeeded" },
    ]);
    runOrderCommand(database, ["check", "order-1", "--command", "bun run verify", "--exit", "0"]);
    expect(runOrderCommand(database, ["stop", "order-1", "completed"], null, trunk.dir)).toBe(
      "order-1 is completed",
    );
  });

  test("a ship run from the trunk checkout still lands the order's branch", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);
    const wt = join(trunk.dir, ".claude", "worktrees", "order-1");
    writeFileSync(join(wt, "ship-b.txt"), "b");
    Bun.spawnSync(["git", "-C", wt, "add", "."]);
    Bun.spawnSync(["git", "-C", wt, "commit", "-q", "-m", "feat: ship-b"]);
    const sha = Bun.spawnSync(["git", "-C", wt, "rev-parse", "HEAD"], { stdout: "pipe" })
      .stdout.toString()
      .trim();
    runOrderCommand(database, ["commit", "order-1", "--sha", sha, "--subject", "feat: ship-b"]);

    expect(runOrderCommand(database, ["ship", "order-1"], null, trunk.dir)).toBe(
      "order-1 is fast-forwarded onto the trunk",
    );

    expect(Bun.spawnSync(["git", "-C", trunk.dir, "merge-base", "--is-ancestor", sha, "HEAD"]).success).toBe(
      true,
    );
  });

  test("a ship of a commit already on the trunk reports it as already landed", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);
    landed(database, "order-1");

    expect(runOrderCommand(database, ["ship", "order-1"], null, trunk.dir)).toBe(
      "order-1 is already on the trunk",
    );
  });

  test("a ship is refused before the order recorded any commit", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

    expect(() => runOrderCommand(database, ["ship", "order-1"], null, trunk.dir)).toThrow(
      expect.objectContaining({ code: "order_not_integrated" }),
    );
  });

  test("a ship is refused before the order is claimed", () => {
    const database = db();
    queued(database);

    expect(() => runOrderCommand(database, ["ship", "order-1"], null, trunk.dir)).toThrow(
      "order order-1 is not claimed",
    );
  });

  test("a stop moves that card into the done column", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);
    landed(database, "order-1");

    expect(runOrderCommand(database, ["stop", "order-1", "completed"], null, trunk.dir)).toBe(
      "order-1 is completed",
    );

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 0, active: 0, done: 1 });
    expect(snapshot.orders[0]?.status).toBe("completed");
  });

  test("a stop as completed is refused until a check has passed", () => {
    const database = db();
    const operator = operatorEnv(database);
    queued(database);
    runOrderCommand(database, claim);
    runOrderCommand(database, ["check", "order-1", "--command", "bun run verify", "--exit", "1"]);

    expect(() => runOrderCommand(database, ["stop", "order-1", "completed"], null, trunk.dir)).toThrow(
      expect.objectContaining({ code: "order_not_checked" }),
    );

    expect(assembleWallSnapshot(database).orders[0]?.status).toBe("working");
    expect(
      runOrderCommand(
        database,
        ["stop", "order-1", "failed", "--reason", "waits on the wall"],
        null,
        trunk.dir,
        operator,
      ),
    ).toBe("order-1 is queued again");
  });

  test("a failed order stays active on the wall while it can be retried", () => {
    const database = db();
    const operator = operatorEnv(database);
    queued(database);
    runOrderCommand(database, claim);

    runOrderCommand(
      database,
      ["stop", "order-1", "failed", "--reason", "the check never passed"],
      null,
      trunk.dir,
      operator,
    );

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 0, active: 1, done: 0 });
    expect(snapshot.orders[0]?.status).toBe("queued");
    expect(runOrderCommand(database, claim)).toBe("order-1 is working");
  });

  test("a held order is refused to a claim until the owner releases it", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, ["hold", "order-1", "--reason", "outward-facing"]);

    expect(() => runOrderCommand(database, claim)).toThrow(/outward-facing/);

    runOrderCommand(database, ["release", "order-1"]);
    expect(runOrderCommand(database, claim)).toBe("order-1 is working");
  });

  test("ready lists the unheld orders most urgent first, held ones apart", () => {
    const database = db();
    runOrderCommand(database, add);
    runOrderCommand(database, ["add", "order-2", "--title", "Later", "--project", "cniska/dim-factory"]);
    runOrderCommand(database, ["priority", "order-2", "urgent"]);
    runOrderCommand(database, [
      "add",
      "order-3",
      "--title",
      "Owner's",
      "--project",
      "cniska/dim-factory",
      "--hold",
      "outward-facing",
    ]);

    const read = runCommand(database, ["ready", "--project", "cniska/dim-factory"], null, trunk.dir, env) as {
      ready: { id: string }[];
      held: { id: string }[];
    };

    expect(read.ready.map((one: { id: string }) => one.id)).toEqual(["order-2", "order-1"]);
    expect(read.held.map((one: { id: string }) => one.id)).toEqual(["order-3"]);
  });

  test("a running order records the evidence the work produced", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

    expect(
      runOrderCommand(database, ["commit", "order-1", "--sha", "abc123", "--subject", "feat: land it"]),
    ).toBe("order-1 recorded commit abc123");
    expect(
      runOrderCommand(database, [
        "file",
        "order-1",
        "--path",
        "src/order-command.ts",
        "--added",
        "31",
        "--removed",
        "4",
      ]),
    ).toBe("order-1 recorded src/order-command.ts (+31/-4)");
    expect(
      runOrderCommand(database, [
        "check",
        "order-1",
        "--command",
        "bun run verify",
        "--exit",
        "0",
        "--result",
        "green",
      ]),
    ).toMatch(/^order-1 recorded bun run verify \(0\)$/);
    expect(
      runOrderCommand(database, [
        "build-artifact",
        "order-1",
        "--body",
        "## Result\\n\\nThe slice is built and verified.",
        "--head",
        "abc123",
      ]),
    ).toBe("order-1 recorded Build artifact 1");
    expect(runOrderCommand(database, ["document", "order-1", "--path", "docs/factory.md"])).toBe(
      "order-1 recorded docs/factory.md",
    );

    expect(database.query("SELECT sha, subject FROM factory_order_commit").get()).toEqual({
      sha: "abc123",
      subject: "feat: land it",
    });
    expect(database.query("SELECT path, added, removed FROM factory_order_file").get()).toEqual({
      path: "src/order-command.ts",
      added: 31,
      removed: 4,
    });
    expect(database.query("SELECT command, exit_code, result FROM factory_order_check").get()).toEqual({
      command: "bun run verify",
      exit_code: 0,
      result: "green",
    });
    expect(
      database
        .query(
          `SELECT a.body, a.head_sha, w.worker FROM factory_order_artifact a
           JOIN factory_order_event w ON w.artifact_id = a.id AND w.kind = 'artifact_written'
           WHERE a.kind = 'build'`,
        )
        .get(),
    ).toEqual({
      body: "## Result\n\nThe slice is built and verified.",
      head_sha: "abc123",
      worker: env[WORKER_NAME_VAR],
    });
    expect(database.query("SELECT path FROM factory_order_document").get()).toEqual({
      path: "docs/factory.md",
    });
  });

  test("evidence is refused before the order is claimed and after it stopped", () => {
    const database = db();
    queued(database);

    expect(() => runOrderCommand(database, ["commit", "order-1", "--sha", "abc123"])).toThrow(
      "order order-1 is not claimed",
    );

    runOrderCommand(database, claim);
    landed(database, "order-1");
    runOrderCommand(database, ["stop", "order-1", "completed"], null, trunk.dir);

    expect(() => runOrderCommand(database, ["commit", "order-1", "--sha", "abc123"])).toThrow(
      "order order-1 is already completed",
    );
    expect(
      database.query("SELECT count(*) AS rows FROM factory_order_commit WHERE sha = 'abc123'").get(),
    ).toEqual({ rows: 0 });
  });

  test("a line count that is not a number is refused, and git's binary dash is no count", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

    for (const spec of ["", " ", "1e3", "-4", "many"]) {
      expect(() =>
        runOrderCommand(database, ["file", "order-1", "--path", "src/a.ts", "--added", spec]),
      ).toThrow(UsageError);
    }
    expect(
      runOrderCommand(database, [
        "file",
        "order-1",
        "--path",
        "src/logo.png",
        "--added",
        "-",
        "--removed",
        "-",
      ]),
    ).toBe("order-1 recorded src/logo.png");
    expect(database.query("SELECT added, removed FROM factory_order_file").get()).toEqual({
      added: null,
      removed: null,
    });
  });

  test("a check with no exit status is refused", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

    for (const spec of ["green", "", " ", "1e3"]) {
      expect(() =>
        runOrderCommand(database, ["check", "order-1", "--command", "bun run verify", "--exit", spec]),
      ).toThrow(UsageError);
    }

    expect(database.query("SELECT count(*) AS rows FROM factory_order_check").get()).toEqual({ rows: 0 });
  });

  test("raises and answers no finding from the command line", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

    expect(() =>
      runOrderCommand(database, ["finding", "order-1", "--dimension", "tests", "--summary", "s"]),
    ).toThrow("finding is not an order subcommand");
    expect(() => runOrderCommand(database, ["answer", "1", "--answer", "fixed"])).toThrow(
      "answer is not an order subcommand",
    );
  });

  test("a ruling names one finding, exactly one of uphold or overturn, and a reason", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

    expect(() => runOrderCommand(database, ["rule", "nope", "--uphold", "--reason", "r"])).toThrow(
      "rule names the finding it settles: `dim order rule <finding-id> --uphold|--overturn --reason ...`",
    );
    expect(() => runOrderCommand(database, ["rule", "1", "--reason", "r"])).toThrow(
      "rule takes exactly one of --uphold or --overturn",
    );
    expect(() => runOrderCommand(database, ["rule", "1", "--uphold", "--overturn", "--reason", "r"])).toThrow(
      "rule takes exactly one of --uphold or --overturn",
    );
    expect(() => runOrderCommand(database, ["rule", "1", "--uphold"])).toThrow(UsageError);
    expect(() => runOrderCommand(database, ["rule", "1", "--uphold", "--reason", "r"])).toThrow(
      expect.objectContaining({ code: "finding_unknown" }),
    );
  });

  test("a way an order cannot stop is refused rather than written", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

    expect(() => runOrderCommand(database, ["stop", "order-1", "working"])).toThrow(UsageError);

    expect(assembleWallSnapshot(database).orders[0]?.status).toBe("working");
    landed(database, "order-1");
    expect(runOrderCommand(database, ["stop", "order-1", "completed"], null, trunk.dir)).toBe(
      "order-1 is completed",
    );
  });

  test("an order queued without a title is refused before any row is written", () => {
    const database = db();

    expect(() => runOrderCommand(database, ["add", "order-1", "--project", "cniska/dim-factory"])).toThrow(
      UsageError,
    );
    expect(assembleWallSnapshot(database).orders).toEqual([]);
  });

  test("a claim onto a stopped floor is refused with the reason the floor was stopped for", () => {
    const database = db();
    pullStop(database, { reason: "the commit gate records nothing" });

    expect(() => runOrderCommand(database, claim)).toThrow(/the commit gate records nothing/);
    expect(assembleWallSnapshot(database).orders).toEqual([]);
  });

  test("a claim is refused on a machine whose session hooks were never installed", () => {
    const database = db();
    queued(database);
    const bare = mkdtempSync(join(tmpdir(), "dim-bare-"));

    expect(() => runCommand(database, claim, null, undefined, { ...env, ...scratchEnv(bare) })).toThrow(
      expect.objectContaining({ code: "hooks_missing" }),
    );
    expect(assembleWallSnapshot(database).totals).toEqual({ todo: 1, active: 0, done: 0 });
    rmSync(bare, { recursive: true, force: true });
  });

  test("a claim is refused where a session hook is written against an older contract", () => {
    const database = db();
    queued(database);
    const older = collectingMachine();
    for (const tool of TOOLS) {
      const config = hookConfigPath(tool, older.env);
      writeFileSync(config, readFileSync(config, "utf8").replaceAll(/dim-hook:\d+/g, "dim-hook:1"));
    }

    expect(() => runCommand(database, claim, null, undefined, { ...env, ...older.env })).toThrow(
      expect.objectContaining({ code: "hooks_stale" }),
    );
    expect(assembleWallSnapshot(database).totals).toEqual({ todo: 1, active: 0, done: 0 });
    rmSync(older.dir, { recursive: true, force: true });
  });

  test("every write is refused where nothing says which worker is making it", () => {
    const database = db();
    queued(database);
    const unissued = { ...env, DIM_WORKER_TOKEN: "not the one it was handed" };

    for (const args of [
      add,
      claim,
      ["move", "order-1", "--station", "review"],
      ["stop", "order-1", "failed"],
    ]) {
      expect(() => runCommand(database, args, null, undefined, {})).toThrow(
        expect.objectContaining({ code: "worker_missing" }),
      );
      expect(() => runCommand(database, args, null, undefined, unissued)).toThrow(
        expect.objectContaining({ code: "worker_unissued" }),
      );
    }
    expect(database.query("SELECT count(*) AS n FROM factory_order_event").get()).toEqual({ n: 1 });
  });

  test("an unknown subcommand, an unknown flag and a repeated flag are refused", () => {
    const database = db();

    expect(() => runOrderCommand(database, ["park", "order-1"])).toThrow(UsageError);
    expect(() => runOrderCommand(database, ["toString", "order-1"])).toThrow(UsageError);
    expect(() => runOrderCommand(database, [...claim, "--colour", "red"])).toThrow(UsageError);
    expect(() => runOrderCommand(database, [...claim, "--title", "second"])).toThrow(UsageError);
  });

  test("an amend corrects a queued order's own words", () => {
    const database = db();
    queued(database);

    expect(runOrderCommand(database, ["amend", "order-1", "--title", "A corrected title"])).toBe(
      "order-1 amended",
    );

    expect(database.query("SELECT title, description FROM factory_order WHERE id = 'order-1'").get()).toEqual(
      {
        title: "A corrected title",
        description: "The record holds what an order is called and never what it says.",
      },
    );
  });

  test("an amend with neither flag is a refusal, not a no-op", () => {
    const database = db();
    queued(database);

    expect(() => runOrderCommand(database, ["amend", "order-1"])).toThrow(UsageError);
  });

  test("an amend is refused once the order is claimed", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

    expect(() => runOrderCommand(database, ["amend", "order-1", "--title", "too late"])).toThrow(
      expect.objectContaining({ code: "order_not_queued" }),
    );
  });

  test("a drop takes a queued order off the wall entirely, carrying the reason", () => {
    const database = db();
    queued(database);

    expect(
      runOrderCommand(
        database,
        ["drop", "order-1", "--reason", "superseded elsewhere"],
        null,
        trunk.dir,
        operatorEnv(database),
      ),
    ).toBe("order-1 is dropped: superseded elsewhere");

    expect(database.query("SELECT status FROM factory_order WHERE id = 'order-1'").get()).toEqual({
      status: "dropped",
    });
    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 0, active: 0, done: 0 });
    expect(snapshot.orders).toEqual([]);
  });

  test("a drop needs a reason", () => {
    const database = db();
    queued(database);

    expect(() =>
      runOrderCommand(database, ["drop", "order-1"], null, trunk.dir, operatorEnv(database)),
    ).toThrow(UsageError);
  });

  test("a station worker cannot drop an order", () => {
    const database = db();
    queued(database);
    const builder = mintWorker(database, {
      role: "builder",
      parentWorker: env[WORKER_NAME_VAR] as string,
      sessionId: newWorkerSession("drop-builder"),
    });

    expect(() =>
      runOrderCommand(database, ["drop", "order-1", "--reason", "disposable"], null, trunk.dir, {
        ...machine.env,
        [WORKER_NAME_VAR]: builder.name,
        [WORKER_TOKEN_VAR]: builder.token,
      }),
    ).toThrow(expect.objectContaining({ code: "worker_not_operator" }));
    expect(database.query("SELECT status FROM factory_order WHERE id = 'order-1'").get()).toEqual({
      status: "queued",
    });
  });

  test("a drop is refused while a hand is holding the order", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

    expect(() =>
      runOrderCommand(
        database,
        ["drop", "order-1", "--reason", "too late to drop"],
        null,
        trunk.dir,
        operatorEnv(database),
      ),
    ).toThrow(expect.objectContaining({ code: "order_held_by_run" }));
  });

  test("a dropped order cannot be claimed, amended or dropped again", () => {
    const database = db();
    queued(database);
    runOrderCommand(
      database,
      ["drop", "order-1", "--reason", "not worth building"],
      null,
      trunk.dir,
      operatorEnv(database),
    );

    expect(() => runOrderCommand(database, claim)).toThrow();
    expect(() => runOrderCommand(database, ["amend", "order-1", "--title", "too late"])).toThrow(
      expect.objectContaining({ code: "order_not_queued" }),
    );
    expect(() =>
      runOrderCommand(
        database,
        ["drop", "order-1", "--reason", "again"],
        null,
        trunk.dir,
        operatorEnv(database),
      ),
    ).toThrow("order-1 is already dropped");
  });
});
