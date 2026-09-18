import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  createSchedule,
  listDueSchedules,
  recordScheduleEvaluation,
  setSchedulePaused,
} from "./factory-schedule";
import { SCHEMA_SQL } from "./schema";

describe("factory schedules", () => {
  test("selects an unevaluated schedule and respects its interval", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createSchedule(
      db,
      { id: "hourly", queueId: "build-order", intervalSeconds: 3600 },
      "2026-09-18T09:00:00.000Z",
    );

    expect(listDueSchedules(db, "2026-09-18T09:01:00.000Z").map((row) => row.id)).toEqual(["hourly"]);
    recordScheduleEvaluation(db, "hourly", "2026-09-18T09:01:00.000Z", true);
    expect(listDueSchedules(db, "2026-09-18T09:59:00.000Z")).toEqual([]);
    expect(listDueSchedules(db, "2026-09-18T10:01:00.000Z").map((row) => row.queue_id)).toEqual([
      "build-order",
    ]);
    db.close();
  });

  test("paused schedules are not due and retain their definition", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createSchedule(db, { id: "paused", queueId: "queue", intervalSeconds: 60 }, "2026-09-18T09:00:00.000Z");
    setSchedulePaused(db, "paused", true, "2026-09-18T09:02:00.000Z");

    expect(listDueSchedules(db, "2026-09-18T09:03:00.000Z")).toEqual([]);
    expect(
      db.query("SELECT queue_id, interval_seconds, paused FROM factory_schedule WHERE id = 'paused'").get(),
    ).toEqual({
      queue_id: "queue",
      interval_seconds: 60,
      paused: 1,
    });
    db.close();
  });

  test("missing schedules fail instead of inventing state", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    expect(() => setSchedulePaused(db, "missing", true)).toThrow("schedule not found: missing");
    expect(() => recordScheduleEvaluation(db, "missing", "2026-09-18T09:00:00.000Z", true)).toThrow(
      "schedule not found: missing",
    );
    db.close();
  });
});
