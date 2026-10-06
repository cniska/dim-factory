import { describe, expect, test } from "bun:test";
import { BoardPush, OrderPush, parsePush } from "./wall-contract";

const ORDER = {
  id: "k7m2qx4d",
  title: "Greet the reader",
  project: "acme/widgets",
  description: "Add a greeting.",
  station: "build",
  worker: { name: "crank-3", role: "builder" },
  status: "running",
  lastEventAt: "2026-10-02T10:00:00.000Z",
  next: "run",
};

const TOTALS = { queued: 0, running: 1, shipped: 0 };

const ENTRY = {
  at: "2026-10-02T10:00:00.000Z",
  action: "order_added",
  station: null,
  worker: null,
};

const NO_TOKENS = { input: 0, output: 0, cachedRead: 0 };

describe("parsePush", () => {
  test("reads a board snapshot", () => {
    const push = parsePush(
      BoardPush,
      JSON.stringify({ kind: "snapshot", snapshot: { orders: [ORDER], totals: TOTALS } }),
    );
    expect(push).toMatchObject({ kind: "snapshot", snapshot: { totals: TOTALS } });
  });

  test("ignores a snapshot without totals", () => {
    expect(
      parsePush(BoardPush, JSON.stringify({ kind: "snapshot", snapshot: { orders: [ORDER] } })),
    ).toBeNull();
  });

  test("ignores a board order that is cancelled, as the board has no column for it", () => {
    const cancelled = { ...ORDER, status: "cancelled" };
    const snapshot = { orders: [cancelled], totals: TOTALS };
    expect(parsePush(BoardPush, JSON.stringify({ kind: "snapshot", snapshot }))).toBeNull();
  });

  test("ignores text that is not JSON", () => {
    expect(parsePush(BoardPush, "{not json")).toBeNull();
  });

  test("reads a failure the server could not read the record for", () => {
    const failure = { code: "x", message: "m", meta: {}, resolve: "r" };
    expect(parsePush(OrderPush, JSON.stringify({ kind: "failure", failure }))).toEqual({
      kind: "failure",
      failure,
    });
  });

  test("reads an order view whose entries name an action the record holds", () => {
    const view = { order: ORDER, tokens: NO_TOKENS, plan: null, build: null, review: null, entries: [ENTRY] };
    expect(parsePush(OrderPush, JSON.stringify({ kind: "order", view }))).toMatchObject({ kind: "order" });
  });

  test("ignores an order view whose entry names an action the record never holds", () => {
    const entries = [{ ...ENTRY, action: "order_teleported" }];
    const view = { order: ORDER, tokens: NO_TOKENS, plan: null, build: null, review: null, entries };
    expect(parsePush(OrderPush, JSON.stringify({ kind: "order", view }))).toBeNull();
  });

  test("reads an action that sits inside a code-discriminated group", () => {
    const entries = ["slice_refused", "session_died", "station_failed", "ship_stopped"].map((action) => ({
      ...ENTRY,
      action,
    }));
    const view = { order: ORDER, tokens: NO_TOKENS, plan: null, build: null, review: null, entries };
    expect(parsePush(OrderPush, JSON.stringify({ kind: "order", view }))).toMatchObject({ kind: "order" });
  });
});
