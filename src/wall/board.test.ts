import { describe, expect, test } from "bun:test";
import { ordersByStatus, WALL_COLUMNS } from "./board";
import type { WallOrder } from "./server";

const order = (id: string, status: WallOrder["status"], station: WallOrder["station"]): WallOrder => ({
  id,
  title: `Work on ${id}`,
  line: "feat",
  description: null,
  worker: { name: "copper-1", role: "builder" },
  station,
  status,
  lastEventAt: "2026-09-18T10:00:00.000Z",
  next: null,
});

describe("factory wall board", () => {
  test("keeps the three status columns in flow order", () => {
    expect(WALL_COLUMNS.map((column) => [column.status, column.label])).toEqual([
      ["queued", "Queued"],
      ["running", "Running"],
      ["shipped", "Shipped"],
    ]);
  });

  test("groups each snapshot order into its status without dropping empty columns", () => {
    const columns = ordersByStatus([
      order("planned-item", "queued", "plan"),
      order("shipped-item", "shipped", null),
      order("busy-item", "running", "review"),
    ]);

    expect(columns).toEqual({
      queued: [order("planned-item", "queued", "plan")],
      running: [order("busy-item", "running", "review")],
      shipped: [order("shipped-item", "shipped", null)],
    });
  });

  test("keeps the order the snapshot ranked its orders in", () => {
    const needsAnswer = { ...order("busy-item", "running", "build"), attention: "scope unclear" };
    const columns = ordersByStatus([
      order("first-running", "running", "build"),
      order("second-running", "running", "build"),
      needsAnswer,
    ]);

    expect(columns.running.map((entry) => entry.id)).toEqual([
      "first-running",
      "second-running",
      "busy-item",
    ]);
  });

  test("keeps a queued order in the queued column when it still names a station", () => {
    const columns = ordersByStatus([
      order("running-item", "running", "build"),
      order("handed-back-item", "queued", "build"),
      order("shipped-item", "shipped", "build"),
    ]);

    expect(columns.running.map((entry) => entry.id)).toEqual(["running-item"]);
    expect(columns.queued.map((entry) => entry.id)).toEqual(["handed-back-item"]);
    expect(columns.shipped.map((entry) => entry.id)).toEqual(["shipped-item"]);
  });

  test("keeps orders from every station in the same status column", () => {
    const columns = ordersByStatus([
      order("building", "running", "build"),
      order("reviewing", "running", "review"),
      order("planning", "running", "plan"),
    ]);

    expect(columns.running.map((entry) => entry.station)).toEqual(["build", "review", "plan"]);
  });
});
