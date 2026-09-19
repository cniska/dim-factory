import { describe, expect, test } from "bun:test";
import type { WallOrder } from "./factory-wall";
import { ordersByStage, WALL_COLUMNS } from "./wall-board";

const order = (
  id: string,
  stage: WallOrder["stage"],
  station: WallOrder["station"],
  status: WallOrder["status"],
): WallOrder => ({
  id,
  title: `Work on ${id}`,
  worker: "copper-1",
  station,
  stage,
  agent: "agent",
  role: "builder",
  status,
  age: "2m",
  lastEventAt: "2026-09-18T10:00:00.000Z",
  failedChecks: 0,
});

describe("factory wall board", () => {
  test("keeps the three stage columns in flow order", () => {
    expect(WALL_COLUMNS.map((column) => [column.stage, column.label])).toEqual([
      ["todo", "Todo"],
      ["active", "Active"],
      ["done", "Done"],
    ]);
  });

  test("groups each snapshot order into its stage without dropping empty columns", () => {
    const columns = ordersByStage([
      order("planned-item", "todo", "plan", "queued"),
      order("shipped-item", "done", "ship", "completed"),
      order("busy-item", "active", "review", "working"),
    ]);

    expect(columns).toEqual({
      todo: [order("planned-item", "todo", "plan", "queued")],
      active: [order("busy-item", "active", "review", "working")],
      done: [order("shipped-item", "done", "ship", "completed")],
    });
  });

  test("keeps the order the snapshot ranked its orders in", () => {
    const needsAnswer = { ...order("busy-item", "active", "build", "working"), attention: "scope unclear" };
    const columns = ordersByStage([
      order("first-running", "active", "build", "working"),
      order("second-running", "active", "build", "working"),
      needsAnswer,
    ]);

    expect(columns.active.map((entry) => entry.id)).toEqual(["first-running", "second-running", "busy-item"]);
  });

  test("groups by stage rather than by the status the card displays", () => {
    const columns = ordersByStage([
      order("running-item", "active", "build", "working"),
      order("handed-back-item", "todo", "build", "queued"),
      order("completed-item", "done", "build", "completed"),
    ]);

    expect(columns.active.map((entry) => entry.id)).toEqual(["running-item"]);
    expect(columns.todo.map((entry) => entry.id)).toEqual(["handed-back-item"]);
    expect(columns.done.map((entry) => entry.id)).toEqual(["completed-item"]);
  });

  test("keeps orders from every station in the same stage column", () => {
    const columns = ordersByStage([
      order("building", "active", "build", "working"),
      order("reviewing", "active", "review", "working"),
      order("planning", "active", "plan", "working"),
      order("shipping", "active", "ship", "working"),
    ]);

    expect(columns.active.map((entry) => entry.station)).toEqual(["build", "review", "plan", "ship"]);
  });
});
