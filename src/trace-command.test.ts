import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import { dbPath, type Env } from "./paths";
import { trace } from "./trace";
import { runTraceCommand } from "./trace-command";

const roots: string[] = [];

function scratch(): Env {
  const root = mkdtempSync(join(tmpdir(), "dim-trace-command-"));
  roots.push(root);
  return { DIM_HOME: root };
}

function shippedOrder(env: Env): void {
  const db = openDb(dbPath(env));
  const at = new Date().toISOString();
  db.run("INSERT INTO factory_order (id, project, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
    "order-1",
    "test/project",
    "Trace order",
    at,
    at,
  ]);
  for (const kind of ["started", "shipped"]) {
    db.run("INSERT INTO factory_order_event (order_id, ts, kind) VALUES (?, ?, ?)", ["order-1", at, kind]);
  }
  closeDb(db);
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("the order trace command", () => {
  test("prints structured events as JSONL", async () => {
    const env = scratch();
    shippedOrder(env);
    trace({ event: "runner.started", orderId: "order-1", fields: { harness: "codex" } }, env);
    const lines: string[] = [];

    await runTraceCommand("order-1", env, (line) => lines.push(line));

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      event: "runner.started",
      orderId: "order-1",
      fields: { harness: "codex" },
    });
  });

  test("refuses an unknown order", async () => {
    const env = scratch();
    closeDb(openDb(dbPath(env)));
    await expect(runTraceCommand("missing", env, () => {})).rejects.toThrow("no order named missing");
  });
});
