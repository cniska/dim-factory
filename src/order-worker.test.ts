import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { claimOrder, queueOrder, recordOrderCommit } from "./factory-order";
import { attributeOrderEvents } from "./order-worker";
import { SCHEMA_SQL } from "./schema";

function floor(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  db.run("INSERT INTO session (id, tool) VALUES ('session-1', 'claude')");
  queueOrder(db, { id: "order-1", project: "cniska/dim-factory", title: "Attribute a moment" });
  return db;
}

/** Only to keep each spooled row's timestamp distinct, which `hook_event` requires. */
function spooled(db: Database): number {
  return db.query<{ n: number }, []>("SELECT count(*) AS n FROM hook_event").get()?.n ?? 0;
}

/** What the installed PostToolUse hook spools: the harness's own agent id beside the stdout. */
function ran(db: Database, agentId: string | null, stdout: string, toolUseId: string): void {
  db.run(
    `INSERT INTO hook_event (tool, session_id, event, ts, payload)
     VALUES ('claude', 'session-1', 'post_tool_use', ?, ?)`,
    [
      `2026-09-19T10:00:00.${String(spooled(db)).padStart(3, "0")}Z`,
      JSON.stringify({
        agent_id: agentId,
        tool_use_id: toolUseId,
        tool_response: { stdout },
      }),
    ],
  );
}

function workerOf(db: Database, eventId: number): string | null {
  const row = db
    .query<{ worker_id: string | null }, [number]>(
      "SELECT worker_id FROM factory_order_event_worker WHERE event_id = ?",
    )
    .get(eventId);
  return row ? row.worker_id : null;
}

describe("attributing a moment to the worker that wrote it", () => {
  test("names the agent the harness recorded against the command, not the one holding the order", () => {
    const db = floor();
    const claimed = claimOrder(db, "order-1", { runId: "run-1", agentId: "typed-whatever" });
    const committed = recordOrderCommit(db, "order-1", "abc1234", "feat: a slice");
    ran(db, "a-operator", `order-1 is working event=${claimed}`, "toolu_1");
    ran(db, "a-builder", `order-1 recorded commit abc1234 event=${committed}`, "toolu_2");

    expect(attributeOrderEvents(db)).toEqual({ attributed: 2 });
    expect(workerOf(db, claimed)).toBe("a-operator");
    expect(workerOf(db, committed)).toBe("a-builder");
    db.close();
  });

  test("a root session writes no agent id, so the moment attributes to its session", () => {
    const db = floor();
    const claimed = claimOrder(db, "order-1", { runId: "run-1" });
    ran(db, null, `order-1 is working event=${claimed}`, "toolu_1");

    attributeOrderEvents(db);

    expect(
      db
        .query("SELECT worker_id, session_id FROM factory_order_event_worker WHERE event_id = ?")
        .get(claimed),
    ).toEqual({ worker_id: null, session_id: "session-1" });
    db.close();
  });

  test("a command that printed no event id attributes nothing", () => {
    const db = floor();
    ran(db, "a-builder", "620 pass, 0 fail", "toolu_1");

    expect(attributeOrderEvents(db)).toEqual({ attributed: 0 });
    db.close();
  });

  test("running twice attributes each moment once", () => {
    const db = floor();
    const claimed = claimOrder(db, "order-1", { runId: "run-1" });
    ran(db, "a-builder", `order-1 is working event=${claimed}`, "toolu_1");

    attributeOrderEvents(db);

    expect(attributeOrderEvents(db)).toEqual({ attributed: 0 });
    expect(db.query("SELECT count(*) AS n FROM factory_order_event_worker").get()).toEqual({ n: 1 });
    db.close();
  });
});
