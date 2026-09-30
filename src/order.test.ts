import { describe, expect, test } from "bun:test";
import { admit, fold, nextOf, type OrderState, orderIdOf } from "./order";
import { type Actor, type Detailed, type LogEntry, OrderId } from "./order-contract";

const OPERATOR: Actor = { kind: "worker", worker: "nut-1", session: "s-operator" };

function log(...details: readonly Detailed[]): LogEntry[] {
  return details.map((detail, index) => ({
    seq: index + 1,
    at: `2026-09-30T10:00:${String(index).padStart(2, "0")}Z`,
    by: OPERATOR,
    ...detail,
  }));
}

const ADDED: Detailed = {
  action: "order_added",
  title: "Greet the reader",
  description: "Add a greeting to the README.",
  project: "acme/widgets",
};
const RUN: Detailed = { action: "order_run" };
const BASE: Detailed = { action: "workspace_created", details: { base: "base0" } };
const PLAN: Detailed = {
  action: "plan_returned",
  body: "A greeting.",
  slices: [
    { title: "Write it", outcome: "greeting.txt exists." },
    { title: "Link it", outcome: "The README links it." },
  ],
};
const approve = (station: "plan" | "build" | "review"): Detailed => ({
  action: "artifact_approved",
  station,
  reason: "it does what the order asked",
  decidedBy: "owner",
});
const committed = (commit: string): Detailed => ({
  action: "slice_committed",
  details: { commit },
  evidence: [],
});
const BUILT: Detailed = { action: "build_returned", artifact: "Both slices." };
const REVIEWED: Detailed = {
  action: "review_returned",
  returned: {
    kind: "artifact",
    artifact: { body: "It does.", covered: ["correctness"], setAside: [], unverified: [] },
  },
};

const planned = [ADDED, RUN, BASE, PLAN];
const built = [...planned, approve("plan"), committed("c1"), committed("c2"), BUILT];
const reviewed = [...built, approve("build"), REVIEWED];

const state = (...details: readonly Detailed[]): OrderState => fold("k7m2qx4d", log(...details));
const next = (order: OrderState) => nextOf(order.phase);

describe("an order's state, folded from its log", () => {
  test("waits to be run once added, and is queued until it runs", () => {
    const order = state(ADDED);
    expect([order.status, order.station, next(order)]).toEqual(["queued", null, "run"]);
    expect(order.phase).toEqual({ kind: "run", work: "plan" });
  });

  test("waits for approval at each station that has returned its artifact", () => {
    expect([state(...planned).station, next(state(...planned))]).toEqual(["plan", "approve"]);
    expect([state(...built).station, next(state(...built))]).toEqual(["build", "approve"]);
    expect([state(...reviewed).station, next(state(...reviewed))]).toEqual(["review", "approve"]);
  });

  test("runs the next station once an artifact is approved, and ships after review", () => {
    expect(state(...planned, approve("plan")).phase).toEqual({ kind: "run", work: "build" });
    expect(state(...built, approve("build")).phase).toEqual({ kind: "run", work: "review" });
    expect(state(...reviewed, approve("review")).phase).toEqual({ kind: "run", work: "ship" });
  });

  test("runs the same station again when its artifact is returned", () => {
    const order = state(...built, {
      action: "artifact_returned",
      station: "build",
      reason: "say which check ran",
      decidedBy: "operator",
    });
    expect([order.station, order.phase]).toEqual(["build", { kind: "run", work: "build" }]);
  });

  test("goes back to the operator for an update when the planner cannot plan it", () => {
    const order = state(ADDED, RUN, BASE, {
      action: "order_returned",
      station: "plan",
      reason: "which README?",
    });
    expect([order.station, next(order)]).toEqual(["plan", "update"]);
  });

  test("goes back one station when a builder or reviewer returns the order", () => {
    const fromBuild = state(...planned, approve("plan"), {
      action: "order_returned",
      station: "build",
      reason: "x",
    });
    expect(fromBuild.phase).toEqual({ kind: "run", work: "plan" });
    const fromReview = state(...built, approve("build"), {
      action: "order_returned",
      station: "review",
      reason: "x",
    });
    expect(fromReview.phase).toEqual({ kind: "run", work: "build" });
  });

  test("an update plans the order again with the new description", () => {
    const order = state(...planned, {
      action: "order_updated",
      title: "Greet the reader",
      description: "In Finnish.",
    });
    expect([order.description, order.phase]).toEqual(["In Finnish.", { kind: "run", work: "plan" }]);
  });

  test("findings put the order at build with each finding open, and an answer closes it", () => {
    const finding = {
      id: "f7-1",
      area: "maintainability",
      file: "slice-1.txt",
      line: 1,
      failure: "It repeats the file name.",
      fix: "Say hello.",
      severity: "medium" as const,
    };
    const withFindings = [
      ...built,
      approve("build"),
      { action: "review_returned" as const, returned: { kind: "findings" as const, findings: [finding] } },
    ];
    expect(state(...withFindings).phase).toEqual({ kind: "run", work: "build" });
    expect(state(...withFindings).findings).toEqual([{ ...finding, answer: null }]);
    const answered = state(...withFindings, {
      action: "finding_answered",
      finding: "f7-1",
      answer: "fixed",
      reason: "hello",
    });
    expect(answered.findings.map((f) => f.answer)).toEqual(["fixed"]);
  });

  test("the recorded head starts at the workspace's base and moves with each commit and rebase", () => {
    expect(state(ADDED, RUN, BASE).head).toBe("base0");
    expect(state(...built).head).toBe("c2");
    expect(state(...built, { action: "branch_rebased", details: { head: "r2" } }).head).toBe("r2");
  });

  test("a refused slice leaves the recorded head where it was", () => {
    const order = state(...planned, approve("plan"), committed("c1"), {
      action: "slice_refused",
      code: "check_failed",
      details: { tip: "t2" },
      evidence: [],
    });
    expect([order.head, order.commits]).toEqual(["c1", ["c1"]]);
  });

  test("a revised plan counts its slices from the commits already on the branch", () => {
    const order = state(
      ...planned,
      approve("plan"),
      committed("c1"),
      committed("c2"),
      {
        action: "order_returned",
        station: "build",
        reason: "the third needs the second gone",
      },
      PLAN,
    );
    expect(order.plan?.base).toBe(2);
  });

  test("a ship stopped by a conflict or a red check goes back to build, and any other stop ships again", () => {
    const shipping = [...reviewed, approve("review"), { action: "ship_started" as const }];
    const conflicted = state(...shipping, {
      action: "ship_stopped",
      code: "ship_conflict",
      details: { commit: "c1", paths: ["slice-1.txt"] },
    });
    expect(conflicted.phase).toEqual({ kind: "run", work: "build" });
    const dirty = state(...shipping, {
      action: "ship_stopped",
      code: "checkout_dirty",
      details: { checkout: "/repo" },
    });
    expect([dirty.station, dirty.phase]).toEqual(["review", { kind: "run", work: "ship" }]);
  });

  test("a landed ship ends the order, and so does a cancel", () => {
    const shipped = state(
      ...reviewed,
      approve("review"),
      { action: "ship_started" },
      {
        action: "ship_landed",
        details: { head: "m2", kept: [] },
        evidence: [],
      },
    );
    expect([shipped.status, next(shipped)]).toEqual(["shipped", null]);
    const cancelled = state(...planned, { action: "order_cancelled", reason: "no longer wanted" });
    expect([cancelled.status, next(cancelled)]).toEqual(["cancelled", null]);
  });

  test("a log that does not start with the order's addition is a fault", () => {
    expect(() => fold("k7m2qx4d", log(RUN))).toThrow("starts with order_added");
    expect(() => fold("k7m2qx4d", [])).toThrow("starts with order_added");
  });
});

describe("an order id", () => {
  test("is eight lowercase Crockford base32 characters, with no letter it reads as a digit", () => {
    const id = orderIdOf(new Uint8Array([0, 1, 10, 17, 18, 31, 32, 255]));
    expect(id).toBe("01ahjz0z");
    expect(OrderId.safeParse(orderIdOf(crypto.getRandomValues(new Uint8Array(8)))).success).toBe(true);
    expect(OrderId.safeParse("k7m2qx4i").success).toBe(false);
  });
});

describe("which act an order admits", () => {
  test("refuses an act that is not the next step, naming the next step", () => {
    expect(admit(state(ADDED), "approve")).toMatchObject({
      code: "not_next_step",
      meta: { order: "k7m2qx4d", next: "run" },
    });
    expect(admit(state(...planned), "run")).toMatchObject({
      code: "not_next_step",
      meta: { next: "approve" },
    });
    expect(admit(state(...planned), "approve")).toBeNull();
    expect(admit(state(...planned), "return")).toBeNull();
  });

  test("admits an update until the plan is approved, and refuses one after", () => {
    expect(admit(state(ADDED), "update")).toBeNull();
    expect(admit(state(...planned), "update")).toBeNull();
    expect(admit(state(...planned, approve("plan")), "update")).toMatchObject({ code: "plan_approved" });
  });

  test("admits a cancel at any point until the order ends", () => {
    expect(admit(state(...built), "cancel")).toBeNull();
    const cancelled = state(...planned, { action: "order_cancelled", reason: "x" });
    for (const act of ["run", "approve", "return", "update", "cancel"] as const) {
      expect(admit(cancelled, act)).toMatchObject({ code: "not_next_step", meta: { next: null } });
    }
  });
});
