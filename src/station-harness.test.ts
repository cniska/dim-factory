import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SCHEMA_SQL } from "./db-schema";
import { workerIn } from "./fixtures.test-support";
import type { HarnessName } from "./harness-name";
import { finishAttempt, startAttempt } from "./order-attempt";
import { queueOrder } from "./order-lifecycle";
import { harnessWithCapacity, onHarnessWithCapacity } from "./station-harness";

const NOW = "2026-09-27T16:00:00.000Z";

function floor(): { db: Database; operator: string; worker: string } {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  const operator = workerIn(db, "operator");
  const worker = workerIn(db, "planner");
  queueOrder(db, { id: "order-1", project: "cniska/dim-factory", title: "Plan it" }, operator);
  db.run(
    "INSERT INTO factory_order_event (order_id, ts, kind, worker, evidence) VALUES ('order-1', ?, 'started', ?, '{}')",
    [NOW, operator],
  );
  return { db, operator, worker };
}

function attempt(
  db: Database,
  ids: { operator: string; worker: string },
  harness: HarnessName,
  outcome: "succeeded" | "failed" | "limited",
  resetsAt?: string,
): void {
  startAttempt(
    db,
    "order-1",
    {
      runId: `run-${crypto.randomUUID()}`,
      worker: ids.worker,
      operatorWorker: ids.operator,
      station: "plan",
      harness,
    },
    NOW,
  );
  finishAttempt(db, "order-1", outcome, `${harness} ${outcome}`, NOW, resetsAt);
}

describe("choosing a harness with capacity", () => {
  test("takes the first candidate whose latest attempt was not stopped by a usage limit", () => {
    const { db, ...ids } = floor();
    attempt(db, ids, "claude", "limited", "2026-09-27T16:50:00.000Z");
    attempt(db, ids, "codex", "failed");

    expect(harnessWithCapacity(db, ["claude", "codex", "grok"], NOW)).toBe("codex");
  });

  test("counts a limit as over once its reset has passed", () => {
    const { db, ...ids } = floor();
    attempt(db, ids, "claude", "limited", "2026-09-27T15:50:00.000Z");

    expect(harnessWithCapacity(db, ["claude", "codex"], NOW)).toBe("claude");
  });

  test("keeps a limit with no reset time until a later attempt on that harness", () => {
    const { db, ...ids } = floor();
    attempt(db, ids, "grok", "limited");
    expect(harnessWithCapacity(db, ["grok", "codex"], NOW)).toBe("codex");

    attempt(db, ids, "grok", "succeeded");
    expect(harnessWithCapacity(db, ["grok", "codex"], NOW)).toBe("grok");
  });

  test("names every harness and its reset when all are limited", () => {
    const { db, ...ids } = floor();
    attempt(db, ids, "claude", "limited", "2026-09-27T16:50:00.000Z");
    attempt(db, ids, "grok", "limited");

    expect(() => harnessWithCapacity(db, ["claude", "grok"], NOW)).toThrow(
      expect.objectContaining({
        code: "harnesses_limited",
        message:
          "every harness is at its usage limit: claude until 2026-09-27T16:50:00.000Z, grok with no reset given",
      }),
    );
  });
});

describe("running a station on a harness with capacity", () => {
  test("moves to the next harness when a run is stopped by a usage limit", async () => {
    const { db, ...ids } = floor();
    const ran: HarnessName[] = [];

    const result = await onHarnessWithCapacity(
      db,
      "order-1",
      "plan",
      ["claude", "codex"],
      null,
      async (harness) => {
        ran.push(harness);
        if (harness === "claude") {
          attempt(db, ids, "claude", "limited", "2099-01-01T00:00:00.000Z");
          throw new Error("claude run failed");
        }
        return "planned";
      },
    );

    expect(result).toBe("planned");
    expect(ran).toEqual(["claude", "codex"]);
  });

  test("passes on a failure that was no usage limit", async () => {
    const { db, ...ids } = floor();

    await expect(
      onHarnessWithCapacity(db, "order-1", "plan", ["claude", "codex"], null, async () => {
        attempt(db, ids, "claude", "failed");
        throw new Error("claude crashed");
      }),
    ).rejects.toThrow("claude crashed");
  });

  test("runs a named harness even when its last attempt was limited", async () => {
    const { db, ...ids } = floor();
    attempt(db, ids, "claude", "limited", "2099-01-01T00:00:00.000Z");

    expect(
      await onHarnessWithCapacity(db, "order-1", "plan", ["codex"], "claude", async (harness) => harness),
    ).toBe("claude");
  });
});
