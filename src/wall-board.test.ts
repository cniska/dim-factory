import { describe, expect, test } from "bun:test";
import type { WallJob } from "./factory-wall";
import { jobsByLifecycle, STATION_LABELS, WALL_COLUMNS } from "./wall-board";

const job = (
  id: string,
  lifecycle: WallJob["lifecycle"],
  station: WallJob["station"],
  status: WallJob["status"],
): WallJob => ({
  id,
  item: id,
  station,
  lifecycle,
  agent: "agent",
  role: "builder",
  status,
  action: "Working",
  age: "2m",
  updatedAt: "2026-09-18T10:00:00.000Z",
  evidence: "check passed",
});

describe("factory wall board", () => {
  test("keeps the three lifecycle columns in flow order", () => {
    expect(WALL_COLUMNS.map((column) => [column.lifecycle, column.label])).toEqual([
      ["todo", "Todo"],
      ["active", "Active"],
      ["done", "Done"],
    ]);
  });

  test("names what each empty column means rather than saying it is empty", () => {
    expect(WALL_COLUMNS.map((column) => column.empty)).toEqual([
      "No claimed work waiting to start",
      "Nothing in motion",
      "Nothing finished yet",
    ]);
  });

  test("labels every station as card metadata rather than a column", () => {
    expect(STATION_LABELS).toEqual({ plan: "Plan", build: "Build", review: "Review", ship: "Ship" });
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
