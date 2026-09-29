import { Database } from "bun:sqlite";
import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "./db-schema";
import type { HarnessAdapter, HarnessEvent, HarnessRun } from "./harness";
import { fakeHarness } from "./harness-fake";
import { queueOrder } from "./order-lifecycle";
import { fail } from "./station-contract";
import { bindOrderWorker, ensureOrderWorker, releaseOrderWorker, runWorkerTurn } from "./station-worker";
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

const launch = {
  cwd: ".",
  brief: "build it",
  capabilities: [],
  harness: "codex" as const,
  model: "m",
  env: {},
};

function builderHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(home, "routing.json"), '{ "codex": { "light": "s", "standard": "m", "deep": "l" } }');
  return home;
}

describe("a usage limit", () => {
  test("names the harness and says so when it reported no reset", () => {
    expect(fail("usage_limited", { harness: "grok", resetsAt: null }).message).toBe(
      "grok stopped at its usage limit with no reset given; delegate again after the reset with --harness grok, or name another of <codex|claude|grok>",
    );
  });
});

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
      sessionId: "claude-session",
    });

    expect(() => ensureOrderWorker(db, "order-1", "builder", operator, "codex")).toThrow(
      "order order-1 builder runs under the claude harness; delegate it with --harness claude",
    );
  });

  test("replaces an accepted assignment before its worker is bound to the order", () => {
    const { db, operator } = floor();
    const first = ensureOrderWorker(db, "order-1", "builder", operator, "codex");
    bootstrapWorker(db, {
      id: first.assignment.id,
      sessionId: "first-session",
    });

    releaseOrderWorker(db, "order-1", "builder");

    const next = ensureOrderWorker(db, "order-1", "builder", operator, "codex");
    expect(next.assignment.id).not.toBe(first.assignment.id);
    expect(next.worker).toBeUndefined();
  });

  test("replaces a bound worker when its provider cannot resume before startup", async () => {
    const { db, operator } = floor();
    const home = builderHome("dim-worker-resume-");
    const env = { DIM_HOME: home };
    const bound = () => ensureOrderWorker(db, "order-1", "builder", operator, "codex");
    try {
      const first = bound();
      await runWorkerTurn(db, "build", launch, first, env, fakeHarness("success"));
      const missing: HarnessAdapter = {
        ...fakeHarness("success"),
        resume: async () => {
          throw new Error("provider session unavailable");
        },
      };

      await expect(runWorkerTurn(db, "build", launch, bound(), env, missing)).rejects.toThrow(
        "provider session unavailable",
      );

      const next = bound();
      expect(next.assignment.id).not.toBe(first.assignment.id);
      expect(next.worker).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a completed response without a provider session id", async () => {
    const { db, operator } = floor();
    const home = builderHome("dim-worker-no-session-");
    const env = { DIM_HOME: home };
    const bound = () => ensureOrderWorker(db, "order-1", "builder", operator, "codex");
    try {
      const first = bound();
      await runWorkerTurn(db, "build", launch, first, env, fakeHarness("success"));
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

      await expect(runWorkerTurn(db, "build", launch, bound(), env, noSession)).rejects.toThrow(
        "order order-1 builder did not start a turn",
      );
      expect(bound().assignment.id).not.toBe(first.assignment.id);
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
    const home = builderHome("dim-order-worker-");
    homes.push(home);
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
    const turn = () =>
      runWorkerTurn(
        db,
        "build",
        launch,
        ensureOrderWorker(db, "order-1", "builder", operator, "codex"),
        env,
        adapter,
      );
    return { db, home, atFirstTurn, turn };
  }

  test("carries the child's pid from its first turn and ends when the run completes", async () => {
    const { db, atFirstTurn, turn } = builder([{ pid: process.ppid, end: "completed" }]);

    expect(await turn()).toMatchObject({ output: "done" });

    expect(atFirstTurn).toEqual([{ pid: process.ppid, ended_at: null }]);
    expect(builderRun(db)).toEqual({ pid: process.ppid, ended_at: expect.any(String) });
  });

  test("ends a resumed run whose pid was recorded even when binding its session then fails", async () => {
    const { db, turn } = builder([
      { pid: process.pid, end: "completed" },
      { pid: process.ppid, end: "completed" },
    ]);
    await turn();
    db.run(
      "UPDATE factory_order_worker SET worker = NULL, provider_session_id = NULL WHERE order_id = 'order-1'",
    );

    await expect(turn()).rejects.toThrow("order order-1 builder worker session was not writable");
    expect(builderRun(db)).toEqual({ pid: process.ppid, ended_at: expect.any(String) });
  });

  test("ends when the run fails", async () => {
    const { db, turn } = builder([{ pid: process.pid, end: "failed" }]);

    await expect(turn()).rejects.toThrow("builder did not finish: the worker crashed");

    expect(builderRun(db)?.ended_at).toEqual(expect.any(String));
  });

  test("ends when the run goes silent and times out", async () => {
    jest.useFakeTimers();
    try {
      const { db, atFirstTurn, turn } = builder([{ pid: process.pid, end: "silent" }]);
      const running = turn();
      while (atFirstTurn.length === 0) await Promise.resolve();
      jest.advanceTimersByTime(10 * 60 * 1000);

      await expect(running).rejects.toThrow("without an event");
      expect(builderRun(db)?.ended_at).toEqual(expect.any(String));
    } finally {
      jest.useRealTimers();
    }
  });

  test("a resumed turn runs as its new child and ends again", async () => {
    const { db, atFirstTurn, turn } = builder([
      { pid: process.pid, end: "completed" },
      { pid: process.ppid, end: "completed" },
    ]);
    await turn();

    expect(await turn()).toMatchObject({ output: "done" });

    expect(atFirstTurn[1]).toEqual({ pid: process.ppid, ended_at: null });
    expect(builderRun(db)).toEqual({ pid: process.ppid, ended_at: expect.any(String) });
  });
});
