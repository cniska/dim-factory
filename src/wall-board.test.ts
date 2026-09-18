import { describe, expect, test } from "bun:test";
import type { WallJob } from "./factory-wall";
import { jobsByStation, WALL_COLUMNS } from "./wall-board";

const job = (id: string, station: WallJob["station"]): WallJob => ({
  id,
  item: id,
  station,
  agent: "agent",
  role: "builder",
  status: "running",
  action: "Working",
  age: "2m",
  updatedAt: "2026-09-18T10:00:00.000Z",
  evidence: "check passed",
});

describe("factory wall board", () => {
  test("keeps the four station columns in flow order", () => {
    expect(WALL_COLUMNS).toEqual([
      { station: "plan", label: "Plan" },
      { station: "build", label: "Build" },
      { station: "review", label: "Review" },
      { station: "ship", label: "Ship" },
    ]);
  });

  test("groups each snapshot job into its station without dropping empty columns", () => {
    const columns = jobsByStation([
      job("plan-item", "plan"),
      job("ship-item", "ship"),
      job("review-item", "review"),
    ]);

    expect(columns).toEqual({
      plan: [job("plan-item", "plan")],
      build: [],
      review: [job("review-item", "review")],
      ship: [job("ship-item", "ship")],
    });
  });
});
