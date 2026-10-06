import { describe, expect, test } from "bun:test";
import type { LogEntry, OrderView, Status } from "../order-contract";
import { itemViewOf, MAX_COLUMN_CARDS, snapshotOf } from "./views";
import type { WallTokens } from "./wall-contract";

const OPERATOR = { kind: "worker", worker: "hinge-1", session: "s-op" } as const;
const PLANNER = { kind: "worker", worker: "bolt-2", session: "s-plan" } as const;
const BUILDER = { kind: "worker", worker: "crank-3", session: "s-build" } as const;
const FACTORY = { kind: "factory", version: "0.1.0", cause: 1 } as const;

const ADDED: LogEntry = {
  seq: 1,
  ts: "2026-10-02T10:00:00.000Z",
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
  return viewOf({ id, status, log: [{ ...ADDED, ts: at(minute) }] });
}

describe("the board", () => {
  test("carries each order's title, project, description, station, worker and last change", () => {
    const view = viewOf({
      log: [ADDED, { seq: 2, ts: at(5), by: FACTORY, action: "order_run", details: {} }],
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
      ts: at(1),
      by: PLANNER,
      action: "plan_returned",
      details: { body: "## First", slices: [{ title: "a", outcome: "b" }] },
    },
    {
      seq: 3,
      ts: at(2),
      by: OPERATOR,
      action: "artifact_returned",
      details: { station: "plan", reason: "tighter", decidedBy: "owner" },
    },
    {
      seq: 4,
      ts: at(3),
      by: PLANNER,
      action: "plan_returned",
      details: { body: "## Second", slices: [{ title: "a", outcome: "b" }] },
    },
    {
      seq: 5,
      ts: at(4),
      by: OPERATOR,
      action: "artifact_approved",
      details: { station: "plan", reason: "good", decidedBy: "owner" },
    },
    {
      seq: 6,
      ts: at(5),
      by: FACTORY,
      action: "station_failed",
      code: "no_return",
      details: { session: "s-build" },
    },
    { seq: 7, ts: at(6), by: BUILDER, action: "build_returned", details: { artifact: "## Built" } },
  ];

  const TOKENS: Readonly<Record<string, WallTokens>> = {
    "hinge-1": { input: 5000, output: 500, cachedRead: 4000 },
    "bolt-2": { input: 300, output: 20, cachedRead: 200 },
    "crank-3": { input: 700, output: 80, cachedRead: 600 },
  };
  const tokensOf = (worker: string): WallTokens => TOKENS[worker] ?? { input: 0, output: 0, cachedRead: 0 };

  test("shows the latest revision of each artifact, who returned it, whether it was approved after, and its worker's tokens", () => {
    const item = itemViewOf(viewOf({ log }), tokensOf, null);

    expect(item.plan).toEqual({
      revision: 2,
      body: "## Second",
      worker: { name: "bolt-2", role: "planner" },
      approved: true,
      tokens: { input: 300, output: 20, cachedRead: 200 },
    });
    expect(item.build).toEqual({
      revision: 1,
      body: "## Built",
      worker: { name: "crank-3", role: "builder" },
      approved: false,
      tokens: { input: 700, output: 80, cachedRead: 600 },
    });
    expect(item.review).toBeNull();
  });

  test("totals the tokens of the order's station workers, leaving out the operator's session", () => {
    expect(itemViewOf(viewOf({ log }), tokensOf, null).tokens).toEqual({
      input: 1000,
      output: 100,
      cachedRead: 800,
    });
  });

  test("lists every log entry in order, with its station and the worker that recorded it, and no stop code", () => {
    const entries = itemViewOf(viewOf({ log }), tokensOf, null).entries;

    expect(entries.map((entry) => entry.action)).toEqual(log.map((entry) => entry.action));
    expect(entries[2]).toStrictEqual({
      at: at(2),
      action: "artifact_returned",
      station: "plan",
      worker: { name: "hinge-1", role: "operator" },
    });
    expect(entries[5]).toStrictEqual({
      at: at(5),
      action: "station_failed",
      station: null,
      worker: null,
    });
  });

  test("keeps a cancelled order's status, so an open dialog says so", () => {
    expect(itemViewOf(viewOf({ status: "cancelled", log: [ADDED] }), tokensOf, null).order.status).toBe(
      "cancelled",
    );
  });

  test("shows no work in progress while no run of the order is alive", () => {
    expect(itemViewOf(viewOf({ log }), tokensOf, null).working).toBeNull();
  });

  test("shows no work in progress once the station has returned, while its run is still ending", () => {
    expect(itemViewOf(viewOf({ next: "approve", log }), tokensOf, "station").working).toBeNull();
  });

  test("shows a live station run's worker with its tokens and the revision it is working on", () => {
    expect(itemViewOf(viewOf({ station: "plan", log }), tokensOf, "station").working).toEqual({
      kind: "station",
      station: "plan",
      worker: { name: "bolt-2", role: "planner", tokens: { input: 300, output: 20, cachedRead: 200 } },
      revision: 3,
    });
  });

  test("shows a live station run with no worker yet as unassigned, and a live ship as shipping", () => {
    const unassigned = viewOf({ station: "review", log });
    expect(itemViewOf(unassigned, tokensOf, "station").working).toEqual({
      kind: "station",
      station: "review",
      worker: null,
      revision: 1,
    });
    expect(itemViewOf(viewOf({ log }), tokensOf, "ship").working).toEqual({ kind: "ship" });
  });
});
