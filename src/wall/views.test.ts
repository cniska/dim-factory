import { describe, expect, test } from "bun:test";
import type { LogEntry, Status } from "../order-contract";
import type { OrderView } from "../order-view";
import { itemViewOf, MAX_COLUMN_CARDS, snapshotOf } from "./views";

const OPERATOR = { kind: "worker", worker: "hinge-1", session: "s-op" } as const;
const PLANNER = { kind: "worker", worker: "bolt-2", session: "s-plan" } as const;
const BUILDER = { kind: "worker", worker: "crank-3", session: "s-build" } as const;
const FACTORY = { kind: "factory", version: "0.1.0", cause: 1 } as const;

const ADDED: LogEntry = {
  seq: 1,
  at: "2026-10-02T10:00:00.000Z",
  by: OPERATOR,
  action: "order_added",
  details: { title: "Greet the reader", description: "Add a greeting.", project: "acme/widgets" },
};

function viewOf(fields: Partial<OrderView> & { readonly log: readonly LogEntry[] }): OrderView {
  return {
    id: "k7m2qx4d",
    title: "Greet the reader",
    project: "acme/widgets",
    description: "Add a greeting.",
    status: "running",
    station: "build",
    next: "run",
    admits: ["cancel"],
    branch: "dim/k7m2qx4d",
    workspace: "/tmp/k7m2qx4d",
    workers: [
      { name: "hinge-1", role: "operator", sessions: [] },
      { name: "bolt-2", role: "planner", createdBy: "hinge-1", sessions: [] },
      { name: "crank-3", role: "builder", createdBy: "hinge-1", sessions: [] },
    ],
    slices: [],
    findings: [],
    ...fields,
  };
}

const at = (minute: number) => `2026-10-02T10:${String(minute).padStart(2, "0")}:00.000Z`;

function ordered(id: string, status: Status, minute: number): OrderView {
  return viewOf({ id, status, log: [{ ...ADDED, at: at(minute) }] });
}

describe("the board", () => {
  test("carries each order's title, project, description, station, worker and last change", () => {
    const view = viewOf({
      log: [ADDED, { seq: 2, at: at(5), by: FACTORY, action: "order_run", details: {} }],
    });

    expect(snapshotOf([view])).toEqual({
      orders: [
        {
          id: "k7m2qx4d",
          title: "Greet the reader",
          project: "acme/widgets",
          description: "Add a greeting.",
          station: "build",
          worker: { name: "crank-3", role: "builder" },
          status: "running",
          lastEventAt: at(5),
          next: "run",
        },
      ],
      totals: { queued: 0, running: 1, shipped: 0 },
    });
  });

  test("shows no station, worker or next step on an order that is not running", () => {
    const [queued, shipped] = snapshotOf([
      viewOf({ id: "aaaaaaaa", status: "queued", station: null, next: "run", log: [ADDED] }),
      viewOf({ id: "bbbbbbbb", status: "shipped", station: "review", next: null, log: [ADDED] }),
    ]).orders;

    expect(queued).toMatchObject({ station: null, worker: null, next: null });
    expect(shipped).toMatchObject({ station: null, worker: null, next: null });
  });

  test("leaves a cancelled order off the board and out of the totals", () => {
    const snapshot = snapshotOf([ordered("aaaaaaaa", "cancelled", 1), ordered("bbbbbbbb", "queued", 2)]);

    expect(snapshot.orders.map((order) => order.id)).toEqual(["bbbbbbbb"]);
    expect(snapshot.totals).toEqual({ queued: 1, running: 0, shipped: 0 });
  });

  test("ranks the most recently changed first and bounds each column while counting every order", () => {
    const views = Array.from({ length: MAX_COLUMN_CARDS + 2 }, (_, minute) =>
      ordered(`order${String(minute).padStart(3, "0")}`, "shipped", minute),
    );
    const snapshot = snapshotOf(views);

    expect(snapshot.orders).toHaveLength(MAX_COLUMN_CARDS);
    expect(snapshot.orders[0]?.lastEventAt).toBe(at(MAX_COLUMN_CARDS + 1));
    expect(snapshot.totals.shipped).toBe(MAX_COLUMN_CARDS + 2);
  });
});

describe("an opened order", () => {
  const log: readonly LogEntry[] = [
    ADDED,
    {
      seq: 2,
      at: at(1),
      by: PLANNER,
      action: "plan_returned",
      details: { body: "## First", slices: [{ title: "a", outcome: "b" }] },
    },
    {
      seq: 3,
      at: at(2),
      by: OPERATOR,
      action: "artifact_returned",
      details: { station: "plan", reason: "tighter", decidedBy: "owner" },
    },
    {
      seq: 4,
      at: at(3),
      by: PLANNER,
      action: "plan_returned",
      details: { body: "## Second", slices: [{ title: "a", outcome: "b" }] },
    },
    {
      seq: 5,
      at: at(4),
      by: OPERATOR,
      action: "artifact_approved",
      details: { station: "plan", reason: "good", decidedBy: "owner" },
    },
    {
      seq: 6,
      at: at(5),
      by: FACTORY,
      action: "station_failed",
      code: "no_return",
      details: { session: "s-build" },
    },
    { seq: 7, at: at(6), by: BUILDER, action: "build_returned", details: { artifact: "## Built" } },
  ];

  test("shows the latest revision of each artifact, who returned it and whether it was approved after", () => {
    const item = itemViewOf(viewOf({ log }));

    expect(item.plan).toEqual({
      revision: 2,
      body: "## Second",
      worker: { name: "bolt-2", role: "planner" },
      approved: true,
    });
    expect(item.build).toEqual({
      revision: 1,
      body: "## Built",
      worker: { name: "crank-3", role: "builder" },
      approved: false,
    });
    expect(item.review).toBeNull();
  });

  test("lists every log entry in order, with its station, its stop code and the worker that recorded it", () => {
    const entries = itemViewOf(viewOf({ log })).entries;

    expect(entries.map((entry) => entry.action)).toEqual(log.map((entry) => entry.action));
    expect(entries[2]).toEqual({
      at: at(2),
      action: "artifact_returned",
      code: null,
      station: "plan",
      worker: { name: "hinge-1", role: "operator" },
    });
    expect(entries[5]).toEqual({
      at: at(5),
      action: "station_failed",
      code: "no_return",
      station: null,
      worker: null,
    });
  });

  test("keeps a cancelled order's status, so an open dialog says so", () => {
    expect(itemViewOf(viewOf({ status: "cancelled", log: [ADDED] })).order.status).toBe("cancelled");
  });
});
