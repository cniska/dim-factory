import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db";
import { collectingMachine, declareCheck, integratedRepo } from "./fixtures.test-support";
import { runOrderCommand, runOrderCommandLive } from "./order-command";
import { queueOrder } from "./order-lifecycle";
import { orderStatus } from "./order-status";
import { dbPath, type Env } from "./paths";
import { mintWorker, WORKER_NAME_VAR } from "./worker";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workerEnv(machine: Env, worker: { name: string }): Env {
  return { ...machine, [WORKER_NAME_VAR]: worker.name };
}

describe("headless factory loop", () => {
  test("runs an order through real configured station processes", async () => {
    const repo = integratedRepo();
    const base = declareCheck(repo.dir);
    const machine = collectingMachine();
    roots.push(repo.dir, machine.dir);
    mkdirSync(machine.env.DIM_HOME as string, { recursive: true });
    writeFileSync(
      join(machine.env.DIM_HOME as string, "routing.json"),
      '{ "codex": { "light": "small", "standard": "middling", "deep": "large" } }',
    );
    const bin = join(machine.dir, "bin");
    mkdirSync(bin);
    const fakeCodex = join(bin, "codex");
    writeFileSync(
      fakeCodex,
      `#!/bin/sh\nexec bun "${join(import.meta.dir, "..", "scripts", "verify-harness.ts")}" "$@"\n`,
    );
    chmodSync(fakeCodex, 0o755);
    machine.env.PATH = `${bin}:${process.env.PATH ?? ""}`;

    const db = openDb(dbPath(machine.env));
    const operator = mintWorker(db, { role: "operator", pid: process.ppid, sessionId: "e2e-operator" });
    const env = workerEnv(machine.env, operator);
    queueOrder(
      db,
      { id: "headless-order", project: "cniska/dim-factory", title: "Run end to end" },
      operator.name,
    );

    expect(
      await runOrderCommandLive(db, ["plan", "headless-order", "--harness", "codex"], null, repo.dir, env),
    ).toContain("## Outcome");
    expect(runOrderCommand(db, ["approve", "headless-order"], null, repo.dir, env)).toContain(
      "plan approved",
    );
    const worktree = join(repo.dir, ".claude", "worktrees", "headless-order");
    expect(
      await runOrderCommandLive(db, ["build", "headless-order", "--harness", "codex"], null, repo.dir, env),
    ).toContain("build completed by");
    expect(existsSync(join(worktree, "built-by-scripted-harness-1.txt"))).toBe(true);
    expect(existsSync(join(worktree, "built-by-scripted-harness-2.txt"))).toBe(true);
    expect(
      runOrderCommand(
        db,
        ["approve", "headless-order", "--reason", "the complete build artifact is present"],
        null,
        repo.dir,
        env,
      ),
    ).toContain("build approved");
    expect(
      await runOrderCommandLive(db, ["review", "headless-order", "--harness", "codex"], null, repo.dir, env),
    ).toBe("review raised no findings; approve the Review artifact to ship");
    expect(runOrderCommand(db, ["approve", "headless-order"], null, repo.dir, env)).toContain(
      "review approved by",
    );

    expect(orderStatus(db, "headless-order")).toBe("shipped");
    expect(existsSync(worktree)).toBe(false);
    expect(
      db
        .query<{ kind: string }, [string]>("SELECT kind FROM factory_order_event WHERE order_id = ?")
        .all("headless-order")
        .map((row) => row.kind),
    ).toEqual([
      "queued",
      "started",
      "station_started",
      "artifact_submitted",
      "artifact_approved",
      "station_started",
      "commit_created",
      "station_started",
      "commit_created",
      "artifact_submitted",
      "artifact_approved",
      "station_started",
      "artifact_submitted",
      "artifact_approved",
    ]);
    expect(
      db.query("SELECT outcome FROM factory_order_ship_run WHERE order_id = ?").all("headless-order"),
    ).toEqual([{ outcome: "landed" }]);
    expect(
      db
        .query("SELECT body FROM factory_order_artifact WHERE order_id = ? AND kind = 'review' ORDER BY id")
        .all("headless-order"),
    ).toEqual([
      {
        body: expect.stringContaining(
          "## Verdict\n\n**May advance.** No findings; the change is ready to advance.",
        ),
      },
    ]);
    expect(
      db
        .query<{ worker: string; path: string }, [string]>(
          "SELECT worker, path FROM factory_order_file WHERE order_id = ? ORDER BY path",
        )
        .all("headless-order"),
    ).toEqual([
      { worker: expect.any(String), path: "built-by-scripted-harness-1.txt" },
      { worker: expect.any(String), path: "built-by-scripted-harness-2.txt" },
    ]);
    expect(
      db
        .query<{ body: string; head_sha: string }, [string]>(
          "SELECT body, head_sha FROM factory_order_artifact WHERE order_id = ? AND kind = 'build'",
        )
        .all("headless-order"),
    ).toEqual([
      {
        body: expect.stringContaining("## Outcome"),
        head_sha: expect.any(String),
      },
    ]);
    expect(
      db
        .query<{ ordinal: number; worker: string }, [string]>(
          `SELECT s.ordinal, c.worker
           FROM factory_order_slice_completion c
           JOIN factory_order_slice s ON s.id = c.slice_id
           JOIN factory_order_artifact p ON p.id = s.artifact_id
           WHERE p.order_id = ? ORDER BY s.ordinal`,
        )
        .all("headless-order"),
    ).toEqual([
      { ordinal: 1, worker: expect.any(String) },
      { ordinal: 2, worker: expect.any(String) },
    ]);
    expect(
      db
        .query<{ role: string; worker: string; provider_session_id: string }, [string]>(
          `SELECT w.role, ow.worker, ow.provider_session_id
           FROM factory_order_worker ow
           JOIN factory_worker w ON w.name = ow.worker
           WHERE ow.order_id = ? ORDER BY w.role`,
        )
        .all("headless-order"),
    ).toEqual([
      { role: "builder", worker: expect.any(String), provider_session_id: "harness-builder-headless-order" },
      { role: "planner", worker: expect.any(String), provider_session_id: "harness-planner-headless-order" },
      {
        role: "reviewer",
        worker: expect.any(String),
        provider_session_id: "harness-reviewer-headless-order",
      },
    ]);
    expect(
      db
        .query<{ role: string; n: number; pids: number; ended: number }, [string]>(
          `SELECT w.role, count(*) AS n, count(w.pid) AS pids, count(w.ended_at) AS ended
           FROM factory_order_worker ow
           JOIN factory_worker w ON w.name = ow.worker
           WHERE ow.order_id = ? GROUP BY w.role ORDER BY w.role`,
        )
        .all("headless-order"),
    ).toEqual([
      { role: "builder", n: 1, pids: 1, ended: 1 },
      { role: "planner", n: 1, pids: 1, ended: 1 },
      { role: "reviewer", n: 1, pids: 1, ended: 1 },
    ]);

    const builder = db
      .query<{ worker: string }, [string]>(
        "SELECT worker FROM factory_order_worker WHERE order_id = ? AND role = 'builder'",
      )
      .get("headless-order")?.worker;
    const git = (args: string[]) =>
      Bun.spawnSync(["git", "-C", repo.dir, ...args], { stdout: "pipe", stderr: "pipe" });
    const landed = git(["rev-list", "--reverse", `${base}..main`])
      .stdout.toString()
      .trim()
      .split("\n");
    expect(landed).toHaveLength(2);
    expect(git(["rev-list", "--merges", "--count", "main"]).stdout.toString().trim()).toBe("0");
    for (const sha of landed) {
      expect(git(["verify-commit", sha]).success).toBe(true);
      expect(git(["log", "-1", "--format=%an <%ae>", sha]).stdout.toString().trim()).toBe(
        "Test <t@example.com>",
      );
    }
    expect(
      db
        .query<{ worker: string }, [string]>(
          "SELECT DISTINCT worker FROM factory_order_event WHERE order_id = ? AND kind = 'commit_created'",
        )
        .all("headless-order"),
    ).toEqual([{ worker: builder ?? "" }]);
    db.close();
  });
});
