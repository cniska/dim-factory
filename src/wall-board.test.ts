import { describe, expect, test } from "bun:test";
import type { WallJob } from "./factory-wall";
import { jobsByLifecycle, WALL_COLUMNS } from "./wall-board";

const job = (
  id: string,
  lifecycle: WallJob["lifecycle"],
  station: WallJob["station"],
  status: WallJob["status"],
): WallJob => ({
  id,
  title: `Work on ${id}`,
  itemId: id,
  worker: "copper-1",
  station,
  lifecycle,
  agent: "agent",
  role: "builder",
  status,
  age: "2m",
  lastEventAt: "2026-09-18T10:00:00.000Z",
  failedChecks: 0,
});

describe("factory wall board", () => {
  test("keeps the three lifecycle columns in flow order", () => {
    expect(WALL_COLUMNS.map((column) => [column.lifecycle, column.label])).toEqual([
      ["todo", "Todo"],
      ["active", "Active"],
      ["done", "Done"],
    ]);
  });

  test("groups each snapshot job into its lifecycle without dropping empty columns", () => {
    const columns = jobsByLifecycle([
      job("planned-item", "todo", "plan", "waiting"),
      job("shipped-item", "done", "ship", "completed"),
      job("fenced-item", "active", "review", "fenced"),
    ]);

    expect(columns).toEqual({
      todo: [job("planned-item", "todo", "plan", "waiting")],
      active: [job("fenced-item", "active", "review", "fenced")],
      done: [job("shipped-item", "done", "ship", "completed")],
    });
  });

  test("lifts a job that needs a person above one that is only moving", () => {
    const needsAnswer = { ...job("fenced-item", "active", "build", "fenced"), attention: "scope unclear" };
    const columns = jobsByLifecycle([
      job("first-running", "active", "build", "running"),
      needsAnswer,
      job("second-running", "active", "build", "running"),
    ]);

    expect(columns.active.map((entry) => entry.id)).toEqual([
      "fenced-item",
      "first-running",
      "second-running",
    ]);
  });

  test("groups by lifecycle rather than by the status the card displays", () => {
    const columns = jobsByLifecycle([
      job("running-item", "active", "build", "running"),
      job("blocked-item", "active", "build", "blocked"),
      job("abandoned-item", "done", "build", "abandoned"),
      job("failed-item", "done", "build", "failed"),
    ]);

    expect(columns.active.map((entry) => entry.id)).toEqual(["running-item", "blocked-item"]);
    expect(columns.done.map((entry) => entry.id)).toEqual(["abandoned-item", "failed-item"]);
  });

  test("keeps jobs from every station in the same lifecycle column", () => {
    const columns = jobsByLifecycle([
      job("building", "active", "build", "running"),
      job("reviewing", "active", "review", "running"),
      job("planning", "active", "plan", "running"),
      job("shipping", "active", "ship", "running"),
    ]);

    expect(columns.active.map((entry) => entry.station)).toEqual(["build", "review", "plan", "ship"]);
  });
});
