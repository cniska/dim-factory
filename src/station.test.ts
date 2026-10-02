import { describe, expect, test } from "bun:test";
import { fold, type OrderState } from "./order";
import type { Later, LaterEntry } from "./order-contract";
import { closedTurn, modelOf, type TurnClose } from "./station";

describe("a station worker's model", () => {
  test("is the one named for its role, else the default, else none", () => {
    const models = { default: "sonnet", planner: "opus" };
    expect(modelOf(models, "planner")).toBe("opus");
    expect(modelOf(models, "builder")).toBe("sonnet");
    expect(modelOf({ planner: "opus" }, "builder")).toBeNull();
    expect(modelOf(undefined, "builder")).toBeNull();
  });
});

const ADDED = {
  seq: 1,
  action: "order_added" as const,
  details: { title: "Greet", description: "Add a greeting.", project: "acme/widgets" },
};

function state(...later: readonly Later[]): OrderState {
  const entries = later.map(
    (detail, index): LaterEntry => ({
      seq: index + 2,
      ts: `2026-10-02T10:00:${String(index).padStart(2, "0")}Z`,
      by: { kind: "worker", worker: "nut-1", session: "s-operator" },
      ...detail,
    }),
  );
  return fold("k7m2qx4d", ADDED, entries);
}

const RUN: Later = { action: "order_run", details: {} };
const BASE: Later = { action: "workspace_created", details: { base: "base0" } };
const PLAN: Later = {
  action: "plan_returned",
  details: { body: "Add it.", slices: [{ title: "Greet", outcome: "The README greets." }] },
};

const atPlan = state(RUN, BASE);
const planReturned = state(RUN, BASE, PLAN);
const cancelled = state(RUN, BASE, { action: "order_cancelled", details: { reason: "Not wanted." } });

const close = (over: Partial<TurnClose> = {}): TurnClose => ({
  session: "s1",
  stop: null,
  outcome: { kind: "finished", result: "done" },
  copied: true,
  resumed: false,
  ...over,
});

const died = (code: "killed" | "resume_failed") => ({ kind: "died", code }) as const;

describe("how a turn ends", () => {
  test("a turn on an order no longer running is closed and records nothing", () => {
    expect(closedTurn(cancelled, "plan", "return", close())).toEqual({
      ended: { end: "closed" },
      record: [],
    });
    expect(closedTurn(cancelled, "plan", "reply", close())).toEqual({ ended: { end: "closed" }, record: [] });
  });

  test("a changed git config fails a station turn but only ends a message turn", () => {
    const stop = { kind: "config_changed" } as const;
    expect(closedTurn(atPlan, "plan", "return", close({ stop })).record).toEqual([
      { action: "station_failed", code: "git_config_changed", details: { session: "s1" } },
    ]);
    expect(closedTurn(atPlan, "plan", "reply", close({ stop }))).toEqual({
      ended: { end: "config_changed", session: "s1" },
      record: [],
    });
  });

  test("a worker that returned has returned, even if its session died after", () => {
    expect(closedTurn(planReturned, "plan", "return", close())).toEqual({
      ended: { end: "returned" },
      record: [],
    });
    expect(closedTurn(planReturned, "plan", "return", close({ outcome: died("killed") }))).toEqual({
      ended: { end: "returned" },
      record: [{ action: "session_died", code: "killed", details: { session: "s1", copied: true } }],
    });
  });

  test("a worker that ended without returning fails the station", () => {
    expect(closedTurn(atPlan, "plan", "return", close())).toEqual({
      ended: { end: "no_return", session: "s1" },
      record: [{ action: "station_failed", code: "no_return", details: { session: "s1" } }],
    });
  });

  test("a resumed session that failed to resume is lost, with its death recorded, in either kind of turn", () => {
    for (const answers of ["return", "reply"] as const) {
      expect(
        closedTurn(atPlan, "plan", answers, close({ outcome: died("resume_failed"), resumed: true })),
      ).toEqual({
        ended: { end: "lost", session: "s1" },
        record: [{ action: "session_died", code: "resume_failed", details: { session: "s1", copied: true } }],
      });
    }
  });

  test("a session that dies fails a station turn, and only ends a message turn", () => {
    const death: Later = { action: "session_died", code: "killed", details: { session: "s1", copied: true } };
    expect(closedTurn(atPlan, "plan", "return", close({ outcome: died("killed") })).record).toEqual([
      death,
      { action: "station_failed", code: "session_died", details: { session: "s1" } },
    ]);
    expect(closedTurn(atPlan, "plan", "reply", close({ outcome: died("killed") }))).toEqual({
      ended: { end: "died", session: "s1", code: "killed" },
      record: [death],
    });
  });

  test("a message turn ends in its worker's reply, or in no reply", () => {
    expect(closedTurn(atPlan, "plan", "reply", close()).ended).toEqual({ end: "replied", reply: "done" });
    expect(
      closedTurn(atPlan, "plan", "reply", close({ outcome: { kind: "finished", result: null } })).ended,
    ).toEqual({ end: "no_reply", session: "s1" });
  });
});
