import { describe, expect, test } from "bun:test";
import {
  admitOperator,
  fold,
  nextOf,
  type OperatorAct,
  type OrderState,
  operatorEntry,
  orderIdOf,
  phaseAfter,
  stationOf,
  workRefusal,
} from "./order";
import { type Actor, type Later, type LaterEntry, OrderId, type RunKind } from "./order-contract";
import type { Acting } from "./worker-contract";

const OPERATOR_ACTOR: Actor = { kind: "worker", worker: "nut-1", session: "s-operator" };
const OPERATOR: Acting = {
  worker: { role: "operator", name: "nut-1", project: "acme/widgets" },
  session: { id: "s-operator", worker: "nut-1", harness: "claude", process: { pid: 7, startedAt: "t" } },
};

const ADDED = {
  seq: 1,
  action: "order_added" as const,
  details: {
    title: "Greet the reader",
    description: "Add a greeting to the README.",
    project: "acme/widgets",
  },
};

function state(...later: readonly Later[]): OrderState {
  const entries = later.map(
    (detail, index): LaterEntry => ({
      seq: index + 2,
      at: `2026-09-30T10:00:${String(index).padStart(2, "0")}Z`,
      by: OPERATOR_ACTOR,
      ...detail,
    }),
  );
  return fold("k7m2qx4d", ADDED, entries);
}

const RUN: Later = { action: "order_run", details: {} };
const BASE: Later = { action: "workspace_created", details: { base: "base0" } };
const PLAN: Later = {
  action: "plan_returned",
  details: {
    body: "A greeting.",
    slices: [
      { title: "Write it", outcome: "greeting.txt exists." },
      { title: "Link it", outcome: "The README links it." },
    ],
  },
};
const approve = (station: "plan" | "build" | "review"): Later => ({
  action: "artifact_approved",
  details: { station, reason: "it does what the order asked", decidedBy: "owner" },
});
const committed = (commit: string): Later => ({
  action: "slice_committed",
  details: { commit },
  evidence: [],
});
const BUILT: Later = { action: "build_returned", details: { artifact: "Both slices." } };
const REVIEWED: Later = {
  action: "review_returned",
  details: {
    returned: {
      kind: "artifact",
      artifact: { body: "It does.", covered: ["correctness"], setAside: [], unverified: [] },
    },
  },
};
const SHIP_STARTED: Later = { action: "ship_started", details: {} };
const fromBuildEntry: Later = {
  action: "order_returned",
  details: { station: "build", reason: "the second slice contradicts the first" },
};

const planned = [RUN, BASE, PLAN];
const built = [...planned, approve("plan"), committed("c1"), committed("c2"), BUILT];
const reviewed = [...built, approve("build"), REVIEWED];

const at = (order: OrderState) => [stationOf(order), nextOf(order.phase)];

describe("an order's state, folded from its log", () => {
  test("waits to be run once added, and is queued until it runs", () => {
    expect(state().status).toBe("queued");
    expect(state().phase).toEqual({ kind: "run", station: "plan" });
  });

  test("waits for approval at each station that has returned its artifact", () => {
    expect(at(state(...planned))).toEqual(["plan", "approve"]);
    expect(at(state(...built))).toEqual(["build", "approve"]);
    expect(at(state(...reviewed))).toEqual(["review", "approve"]);
  });

  test("runs the next station once an artifact is approved, and ships after review", () => {
    expect(state(...planned, approve("plan")).phase).toEqual({ kind: "run", station: "build" });
    expect(state(...built, approve("build")).phase).toEqual({ kind: "run", station: "review" });
    expect(state(...reviewed, approve("review")).phase).toEqual({ kind: "ship" });
  });

  test("runs the same station again when its artifact is returned", () => {
    const order = state(...built, {
      action: "artifact_returned",
      details: { station: "build", reason: "say which check ran", decidedBy: "operator" },
    });
    expect(order.phase).toEqual({ kind: "run", station: "build" });
  });

  test("goes back to the operator for an update when the planner cannot plan it", () => {
    const order = state(RUN, BASE, {
      action: "order_returned",
      details: { station: "plan", reason: "which README?" },
    });
    expect(at(order)).toEqual(["plan", "update"]);
  });

  test("goes back one station when a builder or reviewer returns the order", () => {
    const fromBuild = state(...planned, approve("plan"), {
      action: "order_returned",
      details: { station: "build", reason: "x" },
    });
    expect(fromBuild.phase).toEqual({ kind: "run", station: "plan" });
    const fromReview = state(...built, approve("build"), {
      action: "order_returned",
      details: { station: "review", reason: "x" },
    });
    expect(fromReview.phase).toEqual({ kind: "run", station: "build" });
  });

  test("holds why the order came back for the station it goes back to, until that station returns again", () => {
    const returnedArtifact = state(...planned, {
      action: "artifact_returned",
      details: { station: "plan", reason: "name the file", decidedBy: "owner" },
    });
    expect(returnedArtifact.returned).toEqual({
      kind: "decision",
      decidedBy: "owner",
      reason: "name the file",
    });
    expect(state(...planned, approve("plan")).returned).toBeNull();
    const fromBuild = state(...planned, approve("plan"), {
      action: "order_returned",
      details: { station: "build", reason: "the second slice contradicts the first" },
    });
    expect(fromBuild.returned).toEqual({
      kind: "worker",
      station: "build",
      reason: "the second slice contradicts the first",
    });
    expect(state(...planned, approve("plan"), fromBuildEntry, PLAN).returned).toBeNull();
    const updated = state(
      RUN,
      BASE,
      { action: "order_returned", details: { station: "plan", reason: "which?" } },
      {
        action: "order_updated",
        details: { title: "Greet the reader", description: "The top-level README." },
      },
    );
    expect(updated.returned).toBeNull();
  });

  test("an update plans the order again with the new description", () => {
    const order = state(...planned, {
      action: "order_updated",
      details: { title: "Greet the reader", description: "In Finnish." },
    });
    expect([order.description, order.phase]).toEqual(["In Finnish.", { kind: "run", station: "plan" }]);
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
    const withFindings: Later[] = [
      ...built,
      approve("build"),
      { action: "review_returned", details: { returned: { kind: "findings", findings: [finding] } } },
    ];
    expect(state(...withFindings).phase).toEqual({ kind: "run", station: "build" });
    expect(state(...withFindings).findings).toEqual([{ ...finding, answer: null, reason: null }]);
    const answered = state(...withFindings, {
      action: "finding_answered",
      details: { finding: "f7-1", answer: "fixed", reason: "hello" },
    });
    expect(answered.findings.map((f) => f.answer)).toEqual(["fixed"]);
  });

  test("holds the Build artifact once it is returned, and each finding's answer with its reason", () => {
    expect(state(...built).buildArtifact).toBe("Both slices.");
    const finding = {
      id: "f7-1",
      area: "correctness",
      file: "a.ts",
      line: 1,
      failure: "x",
      fix: "y",
      severity: "high" as const,
    };
    const answered = state(
      ...built,
      approve("build"),
      { action: "review_returned", details: { returned: { kind: "findings", findings: [finding] } } },
      { action: "finding_answered", details: { finding: "f7-1", answer: "refused", reason: "it holds" } },
    );
    expect(answered.findings).toEqual([{ ...finding, answer: "refused", reason: "it holds" }]);
  });

  test("the recorded head starts at the workspace's base and moves with each commit and rebase", () => {
    expect(state(RUN, BASE).head).toBe("base0");
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
      { action: "order_returned", details: { station: "build", reason: "the third needs the second gone" } },
      PLAN,
    );
    expect(order.plan?.base).toBe(2);
  });

  test("a ship stopped by a conflict or a red check goes back to build, and any other stop ships again", () => {
    const shipping = [...reviewed, approve("review"), SHIP_STARTED];
    const conflicted = state(...shipping, {
      action: "ship_stopped",
      code: "ship_conflict",
      details: { commit: "c1", paths: ["slice-1.txt"] },
    });
    expect(conflicted.phase).toEqual({ kind: "run", station: "build" });
    const dirty = state(...shipping, {
      action: "ship_stopped",
      code: "checkout_dirty",
      details: { checkout: "/repo" },
    });
    expect(at(dirty)).toEqual(["review", "run"]);
    const unchecked = state(...shipping, {
      action: "ship_stopped",
      code: "ship_no_check",
      details: { head: "c2" },
      evidence: [],
    });
    expect(at(unchecked)).toEqual(["review", "run"]);
  });

  test("a red check at ship briefs the builder with the check that failed", () => {
    const check = { kind: "check" as const, command: "bun test", exitCode: 1, output: "1 fail" };
    const red = state(...reviewed, approve("review"), SHIP_STARTED, {
      action: "ship_stopped",
      code: "ship_check_failed",
      details: { head: "c2" },
      evidence: [{ kind: "rebase", onto: "m2", commits: [] }, check],
    });
    expect(red.phase).toEqual({ kind: "run", station: "build" });
    expect(red.returned).toEqual({
      kind: "ship",
      check: { command: "bun test", exitCode: 1, output: "1 fail" },
    });
  });

  test("a landed ship ends the order, and so does a cancel", () => {
    const shipped = state(...reviewed, approve("review"), SHIP_STARTED, {
      action: "ship_landed",
      details: { head: "m2", kept: [] },
      evidence: [],
    });
    expect([shipped.status, nextOf(shipped.phase)]).toEqual(["shipped", null]);
    const cancelled = state(...planned, {
      action: "order_cancelled",
      details: { reason: "no longer wanted" },
    });
    expect([cancelled.status, at(cancelled)]).toEqual(["cancelled", ["plan", null]]);
  });
});

describe("an order id", () => {
  test("is eight lowercase Crockford base32 characters, with no letter it reads as a digit", () => {
    expect(orderIdOf(new Uint8Array([0, 1, 10, 17, 18, 31, 32, 255]))).toBe("01ahjz0z");
    expect(OrderId.safeParse(orderIdOf(crypto.getRandomValues(new Uint8Array(8)))).success).toBe(true);
    expect(OrderId.safeParse("k7m2qx4i").success).toBe(false);
  });
});

describe("which act an order admits", () => {
  const refusedCode = (
    order: OrderState,
    act: { readonly kind: OperatorAct["kind"] },
    by: Acting | null = OPERATOR,
    live: RunKind | null = null,
  ) => {
    const admission = admitOperator(order, by, act.kind, live);
    return admission.kind === "refused" ? admission.refusal.code : null;
  };

  const workRefused = (order: OrderState, acting: Acting) =>
    workRefusal(order, "plan", { kind: "worker", acting })?.code ?? null;

  test("refuses an act that is not the next step, naming the next step", () => {
    const admission = admitOperator(state(), OPERATOR, "approve", null);
    expect(admission.kind === "refused" && admission.refusal.meta).toEqual({
      order: "k7m2qx4d",
      next: "run",
    });
    expect(refusedCode(state(...planned), { kind: "run" })).toBe("not_next_step");
    expect(refusedCode(state(...planned), { kind: "approve" })).toBeNull();
    expect(refusedCode(state(...planned), { kind: "return" })).toBeNull();
  });

  test("admits an act only from the operator of the order's project", () => {
    const elsewhere: Acting = { ...OPERATOR, worker: { ...OPERATOR.worker, project: "acme/gadgets" } };
    expect(refusedCode(state(), { kind: "run" }, elsewhere)).toBe("not_operator");
    expect(refusedCode(state(), { kind: "run" }, null)).toBe("not_operator");
    expect(admitOperator(state(), OPERATOR, "run", null)).toEqual({
      kind: "admitted",
      by: OPERATOR,
    });
  });

  test("admits an update until the plan is approved, and refuses one after", () => {
    expect(refusedCode(state(), { kind: "update" })).toBeNull();
    expect(refusedCode(state(...planned), { kind: "update" })).toBeNull();
    expect(refusedCode(state(...planned, approve("plan")), { kind: "update" })).toBe("plan_approved");
  });

  test("admits a cancel at any point until the order ends", () => {
    expect(refusedCode(state(...built), { kind: "cancel" })).toBeNull();
    const cancelled = state(...planned, { action: "order_cancelled", details: { reason: "x" } });
    for (const kind of ["run", "approve", "return", "update", "cancel"] as const) {
      expect(refusedCode(cancelled, { kind })).toBe("not_next_step");
    }
  });

  test("refuses every step and an update while a station turn is alive, but admits a cancel", () => {
    const running = state(RUN, BASE);
    for (const kind of ["run", "approve", "return", "update"] as const) {
      expect(refusedCode(running, { kind }, OPERATOR, "station")).toBe("order_busy");
    }
    expect(refusedCode(running, { kind: "cancel" }, OPERATOR, "station")).toBeNull();
  });

  test("admits a station's work only from the order's worker at that station, while the order is there", () => {
    const plannerOf = (order: string): Acting => ({
      worker: { role: "planner", name: "cog-2", project: "acme/widgets", order, createdBy: "nut-1" },
      session: { id: "s-planner", worker: "cog-2", harness: "claude", process: { pid: 8, startedAt: "t" } },
    });
    const planner = plannerOf("k7m2qx4d");
    const otherOrder = plannerOf("zzzzzzzz");
    const running = state(RUN, BASE);
    expect(workRefused(running, planner)).toBeNull();
    expect(workRefused(running, OPERATOR)).toBe("not_station_worker");
    expect(workRefused(running, otherOrder)).toBe("not_station_worker");
    expect(workRefused(state(...planned), planner)).toBe("not_next_step");
    const cancelled = state(RUN, BASE, { action: "order_cancelled", details: { reason: "x" } });
    expect(workRefused(cancelled, planner)).toBe("not_next_step");
    expect(workRefusal(running, "plan", { kind: "factory", cause: 2 })).toBeNull();
    expect(workRefusal(cancelled, "plan", { kind: "factory", cause: 2 })?.code).toBe("not_next_step");
  });

  test("builds what an admitted act records, and refuses a decision or cancel without a reason", () => {
    const decision = { reason: "it does", decidedBy: "owner" } as const;
    expect(operatorEntry(state(...planned), { kind: "approve", decision })).toEqual({
      action: "artifact_approved",
      details: { station: "plan", reason: "it does", decidedBy: "owner" },
    });
    const noReason = { reason: " ", decidedBy: "owner" } as const;
    expect(() => operatorEntry(state(...planned), { kind: "return", decision: noReason })).toThrow(
      "no reason",
    );
    expect(() => operatorEntry(state(), { kind: "cancel", reason: "" })).toThrow("no reason");
    expect(phaseAfter(state(...planned), { kind: "approve", decision })).toEqual({
      kind: "run",
      station: "build",
    });
    expect(phaseAfter(state(), { kind: "approve", decision })).toBeNull();
  });

  test("refuses a cancel while the order ships", () => {
    const shipping = state(...reviewed, approve("review"), SHIP_STARTED);
    expect(refusedCode(shipping, { kind: "cancel" }, OPERATOR, "ship")).toBe("order_busy");
    expect(refusedCode(shipping, { kind: "run" }, OPERATOR, "ship")).toBe("order_busy");
  });
});
