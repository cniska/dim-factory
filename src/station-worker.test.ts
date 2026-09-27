import { Database } from "bun:sqlite";
import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "./db-schema";
import type { HarnessAdapter, HarnessEvent, HarnessRun } from "./harness";
import { fakeHarness } from "./harness-fake";
import { queueOrder } from "./order-lifecycle";
import {
  bindOrderWorker,
  ensureOrderWorker,
  releaseOrderWorker,
  resumeOrderStationLive,
  runOrderStationLive,
} from "./station-worker";
import { mintWorker } from "./worker";
import { bootstrapWorker } from "./worker-assignment";

function floor() {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  const operator = mintWorker(db, { role: "operator", sessionId: "operator-session" });
  queueOrder(db, { id: "order-1", project: "owner/repo", title: "Work" }, operator.name);
  return { db, operator: operator.name };
}

function harnessOf(db: Database): unknown {
  return db.query("SELECT harness FROM factory_order_worker WHERE order_id = 'order-1'").get();
}

describe("an order's station worker", () => {
  test("records the harness its first delegation named", () => {
    const { db, operator } = floor();

    ensureOrderWorker(db, "order-1", "builder", operator, "claude");

    expect(harnessOf(db)).toEqual({ harness: "claude" });
  });

  test("moves to another harness while no provider session is bound to it", () => {
    const { db, operator } = floor();
    ensureOrderWorker(db, "order-1", "builder", operator, "codex");

    ensureOrderWorker(db, "order-1", "builder", operator, "claude");

    expect(harnessOf(db)).toEqual({ harness: "claude" });
  });

  test("refuses another harness once its provider session is bound, since only its own harness can resume it", () => {
    const { db, operator } = floor();
    const first = ensureOrderWorker(db, "order-1", "builder", operator, "claude");
    const minted = bootstrapWorker(db, {
      id: first.assignment.id,
      token: first.assignment.token,
      sessionId: "claude-session",
    });
    bindOrderWorker(db, "order-1", "builder", first.assignment.id, minted);

    expect(() => ensureOrderWorker(db, "order-1", "builder", operator, "codex")).toThrow(
      "order order-1 builder runs under the claude harness; delegate it with --harness claude",
    );
    expect(ensureOrderWorker(db, "order-1", "builder", operator, "claude").worker).toBe(minted.name);
  });

  test("refuses another harness once its worker bootstrapped, before the order row is bound", () => {
    const { db, operator } = floor();
    const first = ensureOrderWorker(db, "order-1", "builder", operator, "claude");
    bootstrapWorker(db, {
      id: first.assignment.id,
      token: first.assignment.token,
      sessionId: "claude-session",
    });

    expect(() => ensureOrderWorker(db, "order-1", "builder", operator, "codex")).toThrow(
      "order order-1 builder runs under the claude harness; delegate it with --harness claude",
    );
  });

  test("releases a worker whose last failure recorded no turn, and keeps one whose turn came back", () => {
    const { db, operator } = floor();
    const bound = (evidence: string) => {
      const created = ensureOrderWorker(db, "order-1", "builder", operator, "claude");
      const minted = bootstrapWorker(db, {
        id: created.assignment.id,
        token: created.assignment.token,
        sessionId: "claude-session",
      });
      bindOrderWorker(db, "order-1", "builder", created.assignment.id, minted);
      db.run(
        `INSERT INTO factory_order_event (order_id, ts, kind, worker, station, reason, evidence)
         VALUES ('order-1', '2026-09-27T00:00:00.000Z', 'failed', ?, 'build', 'the run ended', ?)`,
        [minted.name, evidence],
      );
      return minted.name;
    };

    const kept = bound('{"turn":true}');
    expect(() => ensureOrderWorker(db, "order-1", "builder", operator, "codex")).toThrow(
      "order order-1 builder runs under the claude harness; delegate it with --harness claude",
    );
    expect(ensureOrderWorker(db, "order-1", "builder", operator, "claude").worker).toBe(kept);

    db.run("DELETE FROM factory_order_event WHERE kind = 'failed'");
    db.run(
      `INSERT INTO factory_order_event (order_id, ts, kind, worker, station, reason, evidence)
       VALUES ('order-1', '2026-09-27T00:00:01.000Z', 'failed', ?, 'build', 'the run ended', '{"turn":false}')`,
      [kept],
    );
    const released = ensureOrderWorker(db, "order-1", "builder", operator, "codex");
    expect(released.worker).toBeUndefined();
    expect(released.harness).toBe("codex");
    expect(harnessOf(db)).toEqual({ harness: "codex" });
  });

  test("replaces an accepted assignment before its worker is bound to the order", () => {
    const { db, operator } = floor();
    const first = ensureOrderWorker(db, "order-1", "builder", operator, "codex");
    bootstrapWorker(db, {
      id: first.assignment.id,
      token: first.assignment.token,
      sessionId: "first-session",
    });

    releaseOrderWorker(db, "order-1", "builder");

    const next = ensureOrderWorker(db, "order-1", "builder", operator, "codex");
    expect(next.assignment.id).not.toBe(first.assignment.id);
    expect(next.worker).toBeUndefined();
  });

  test("replaces a bound worker when its provider cannot resume before startup", async () => {
    const { db, operator } = floor();
    const home = mkdtempSync(join(tmpdir(), "dim-worker-resume-"));
    writeFileSync(join(home, "routing.json"), '{ "codex": { "light": "s", "standard": "m", "deep": "l" } }');
    const common = {
      db,
      orderId: "order-1",
      station: "build" as const,
      parentWorker: operator,
      harness: "codex" as const,
      env: { DIM_HOME: home },
      request: () => ({ cwd: ".", brief: "build it", capabilities: [] }),
    };
    try {
      const first = await runOrderStationLive({ ...common, adapter: fakeHarness("success") });
      const missing: HarnessAdapter = {
        ...fakeHarness("success"),
        resume: async () => {
          throw new Error("provider session unavailable");
        },
      };

      await expect(runOrderStationLive({ ...common, adapter: missing })).rejects.toThrow(
        "provider session unavailable",
      );

      const next = ensureOrderWorker(db, "order-1", "builder", operator, "codex");
      expect(next.assignment.id).not.toBe(first.orderWorker.assignment.id);
      expect(next.worker).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a completed response without a provider session id", async () => {
    const { db, operator } = floor();
    const home = mkdtempSync(join(tmpdir(), "dim-worker-no-session-"));
    writeFileSync(join(home, "routing.json"), '{ "codex": { "light": "s", "standard": "m", "deep": "l" } }');
    const common = {
      db,
      orderId: "order-1",
      station: "build" as const,
      parentWorker: operator,
      harness: "codex" as const,
      env: { DIM_HOME: home },
      request: () => ({ cwd: ".", brief: "build it", capabilities: [] }),
    };
    try {
      const first = await runOrderStationLive({ ...common, adapter: fakeHarness("success") });
      const noSession: HarnessAdapter = {
        ...fakeHarness("success"),
        resume: async (): Promise<HarnessRun> => ({
          pid: process.pid,
          events: (async function* (): AsyncGenerator<HarnessEvent> {
            yield { type: "run.started" };
            yield { type: "run.completed", output: "done" };
          })(),
          cancel() {},
        }),
      };

      await expect(runOrderStationLive({ ...common, adapter: noSession })).rejects.toThrow(
        "order order-1 builder did not start a turn",
      );
      expect(ensureOrderWorker(db, "order-1", "builder", operator, "codex").assignment.id).not.toBe(
        first.orderWorker.assignment.id,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

type WorkerRun = { pid: number | null; ended_at: string | null };
type RunEnd = "completed" | "failed" | "silent";

function builderRun(db: Database): WorkerRun | null {
  return db.query<WorkerRun, []>("SELECT pid, ended_at FROM factory_worker WHERE role = 'builder'").get();
}

describe("a station worker's run", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function builder(runs: { pid: number; end: RunEnd }[]) {
    const { db, operator } = floor();
    const home = mkdtempSync(join(tmpdir(), "dim-order-worker-"));
    homes.push(home);
    writeFileSync(join(home, "routing.json"), '{ "codex": { "light": "s", "standard": "m", "deep": "l" } }');
    const env = { DIM_HOME: home };
    const atFirstTurn: (WorkerRun | null)[] = [];
    const run = async (): Promise<HarnessRun> => {
      const scripted = runs[atFirstTurn.length];
      if (!scripted) throw new Error("no run scripted");
      const { pid, end } = scripted;
      let release: () => void = () => undefined;
      const cancelled = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        pid,
        events: (async function* (): AsyncGenerator<HarnessEvent> {
          yield { type: "run.started", providerSessionId: "builder-session" };
          atFirstTurn.push(builderRun(db));
          yield { type: "turn.started" };
          if (end === "completed") yield { type: "run.completed", output: "done" };
          else if (end === "failed") yield { type: "run.failed", reason: "the worker crashed" };
          else await cancelled;
        })(),
        cancel: () => release(),
      };
    };
    const adapter: HarnessAdapter = { start: run, resume: run };
    const request = { cwd: ".", brief: "build it", capabilities: [] };
    return {
      db,
      home,
      atFirstTurn,
      turn: () =>
        runOrderStationLive({
          db,
          orderId: "order-1",
          station: "build",
          parentWorker: operator,
          harness: "codex",
          env,
          request: () => request,
          adapter,
        }),
      resume: () =>
        resumeOrderStationLive({
          db,
          orderId: "order-1",
          station: "build",
          harness: "codex",
          env,
          adapter,
          request,
        }),
    };
  }

  test("carries the child's pid from its first turn and ends when the run completes", async () => {
    const { db, atFirstTurn, turn } = builder([{ pid: process.ppid, end: "completed" }]);

    const { run } = await turn();

    expect(run.exitCode).toBe(0);
    expect(atFirstTurn).toEqual([{ pid: process.ppid, ended_at: null }]);
    expect(builderRun(db)).toEqual({ pid: process.ppid, ended_at: expect.any(String) });
  });

  test("ends a run whose pid was recorded even when saving the worker's credential then fails", async () => {
    const { db, home, turn } = builder([{ pid: process.ppid, end: "completed" }]);
    writeFileSync(join(home, "worker-credentials"), "");

    await expect(turn()).rejects.toThrow();
    expect(builderRun(db)).toEqual({ pid: process.ppid, ended_at: expect.any(String) });
  });

  test("ends a resumed run whose pid was recorded even when binding its session then fails", async () => {
    const { db, turn, resume } = builder([
      { pid: process.pid, end: "completed" },
      { pid: process.ppid, end: "completed" },
    ]);
    await turn();
    db.run(
      "UPDATE factory_order_worker SET worker = NULL, provider_session_id = NULL WHERE order_id = 'order-1'",
    );

    await expect(resume()).rejects.toThrow("order order-1 builder worker session was not writable");
    expect(builderRun(db)).toEqual({ pid: process.ppid, ended_at: expect.any(String) });
  });

  test("ends when the run fails", async () => {
    const { db, turn } = builder([{ pid: process.pid, end: "failed" }]);

    const { run } = await turn();

    expect(run.exitCode).toBe(1);
    expect(builderRun(db)?.ended_at).toEqual(expect.any(String));
  });

  test("ends when the run goes silent and times out", async () => {
    jest.useFakeTimers();
    try {
      const { db, atFirstTurn, turn } = builder([{ pid: process.pid, end: "silent" }]);
      const running = turn();
      while (atFirstTurn.length === 0) await Promise.resolve();
      jest.advanceTimersByTime(10 * 60 * 1000);

      const { run } = await running;

      expect(run.failureReason).toContain("without an event");
      expect(builderRun(db)?.ended_at).toEqual(expect.any(String));
    } finally {
      jest.useRealTimers();
    }
  });

  test("a resumed turn runs as its new child and ends again", async () => {
    const { db, atFirstTurn, turn, resume } = builder([
      { pid: process.pid, end: "completed" },
      { pid: process.ppid, end: "completed" },
    ]);
    await turn();

    const run = await resume();

    expect(run.exitCode).toBe(0);
    expect(atFirstTurn[1]).toEqual({ pid: process.ppid, ended_at: null });
    expect(builderRun(db)).toEqual({ pid: process.ppid, ended_at: expect.any(String) });
  });
});
