import { describe, expect, test } from "bun:test";
import type { WallOrder } from "./factory-wall";
import { ordersByPhase, WALL_COLUMNS } from "./wall-board";

const order = (
  id: string,
  phase: WallOrder["phase"],
  station: WallOrder["station"],
  status: WallOrder["status"],
): WallOrder => ({
  id,
  title: `Work on ${id}`,
  itemId: id,
  worker: "copper-1",
  station,
  phase,
  agent: "agent",
  role: "builder",
  status,
  age: "2m",
  lastEventAt: "2026-09-18T10:00:00.000Z",
  failedChecks: 0,
});

describe("factory wall board", () => {
  test("keeps the three phase columns in flow order", () => {
    expect(WALL_COLUMNS.map((column) => [column.phase, column.label])).toEqual([
      ["todo", "Todo"],
      ["active", "Active"],
      ["done", "Done"],
    ]);
  });

  test("groups each snapshot order into its phase without dropping empty columns", () => {
    const columns = ordersByPhase([
      order("planned-item", "todo", "plan", "waiting"),
      order("shipped-item", "done", "ship", "completed"),
      order("fenced-item", "active", "review", "fenced"),
    ]);

    expect(columns).toEqual({
      todo: [order("planned-item", "todo", "plan", "waiting")],
      active: [order("fenced-item", "active", "review", "fenced")],
      done: [order("shipped-item", "done", "ship", "completed")],
    });
  });

  test("keeps the order the snapshot ranked its orders in", () => {
    const needsAnswer = { ...order("fenced-item", "active", "build", "fenced"), attention: "scope unclear" };
    const columns = ordersByPhase([
      order("first-running", "active", "build", "running"),
      order("second-running", "active", "build", "running"),
      needsAnswer,
    ]);

    expect(columns.active.map((entry) => entry.id)).toEqual([
      "first-running",
      "second-running",
      "fenced-item",
    ]);
  });

  test("groups by phase rather than by the status the card displays", () => {
    const columns = ordersByPhase([
      order("running-item", "active", "build", "running"),
      order("blocked-item", "active", "build", "blocked"),
      order("abandoned-item", "done", "build", "abandoned"),
      order("failed-item", "done", "build", "failed"),
    ]);

    expect(columns.active.map((entry) => entry.id)).toEqual(["running-item", "blocked-item"]);
    expect(columns.done.map((entry) => entry.id)).toEqual(["abandoned-item", "failed-item"]);
  });

  test("keeps orders from every station in the same phase column", () => {
    const columns = ordersByPhase([
      order("building", "active", "build", "running"),
      order("reviewing", "active", "review", "running"),
      order("planning", "active", "plan", "running"),
      order("shipping", "active", "ship", "running"),
    ]);

    expect(columns.active.map((entry) => entry.station)).toEqual(["build", "review", "plan", "ship"]);
  });
});
