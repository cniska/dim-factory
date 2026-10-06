import { describe, expect, test } from "bun:test";
import {
  admits,
  fold,
  nextAct,
  nextOf,
  type OrderState,
  operatorActRefusal,
  operatorEntry,
  orderIdOf,
  phaseAfter,
  stationOf,
  workRefusal,
} from "./order";
import {
  type Actor,
  type Later,
  type LaterEntry,
  type OperatorAct,
  OrderId,
  type RunKind,
} from "./order-contract";
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
      ts: `2026-09-30T10:00:${String(index).padStart(2, "0")}Z`,
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
  action: "slice_accepted",
  details: { commit },
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
const CONFLICT: Later = {
  action: "ship_stopped",
  code: "ship_conflict",
  details: { onto: "m2", paths: ["slice-1.txt"] },
};
const rebasedOnto = (onto: string): Later => ({
  action: "branch_rebased",
  details: {
    head: "r2",
    onto,
    commits: [
      { from: "c1", to: "r1" },
      { from: "c2", to: "r2" },
    ],
  },
});
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
    expect(state(...withFindings).findings).toEqual([{ ...finding, answered: null }]);
    const answered = state(...withFindings, {
      action: "finding_answered",
      details: { finding: "f7-1", answer: "fixed", reason: "hello" },
    });
    expect(answered.findings.map((f) => f.answered?.answer)).toEqual(["fixed"]);
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
    expect(answered.findings).toEqual([{ ...finding, answered: { answer: "refused", reason: "it holds" } }]);
  });

  test("the recorded head starts at the workspace's base and moves with each commit and rebase", () => {
    expect(state(RUN, BASE).head).toBe("base0");
    expect(state(...built).head).toBe("c2");
    const rebased = state(...built, rebasedOnto("m2"));
    expect([rebased.head, rebased.commits]).toEqual(["r2", ["r1", "r2"]]);
  });

  test("a rebase that resolves a ship conflict clears it from the build's brief", () => {
    const conflicted = [...reviewed, approve("review"), SHIP_STARTED, CONFLICT];
    expect(state(...conflicted).conflict).toEqual({ onto: "m2", paths: ["slice-1.txt"] });
    expect(state(...conflicted, rebasedOnto("m2")).conflict).toBeNull();
  });

  test("a refused slice leaves the recorded head where it was", () => {
    const order = state(...planned, approve("plan"), committed("c1"), {
      action: "slice_refused",
      code: "check_changed",
      details: { tip: "t2" },
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
    expect(state(...shipping, CONFLICT).phase).toEqual({ kind: "run", station: "build" });
    const dirty = state(...shipping, {
      action: "ship_stopped",
      code: "checkout_dirty",
      details: { checkout: "/repo", reason: "tracked files have uncommitted changes" },
    });
    expect(at(dirty)).toEqual(["review", "run"]);
    const unchecked = state(...shipping, {
      action: "ship_stopped",
      code: "ship_no_check",
      details: { head: "c2" },
    });
    expect(at(unchecked)).toEqual(["review", "run"]);
    const unsigned = state(...shipping, {
      action: "ship_stopped",
      code: "rebase_failed",
      details: { onto: "m2", reason: "error: couldn't sign" },
    });
    expect(at(unsigned)).toEqual(["review", "run"]);
  });

  test("a red check at ship briefs the builder with the check that failed", () => {
    const check = { kind: "check" as const, command: "bun test", exitCode: 1, output: "1 fail" };
    const red = state(...reviewed, approve("review"), SHIP_STARTED, {
      action: "ship_stopped",
      code: "ship_check_failed",
      details: { head: "c2", command: "bun test", exitCode: 1 },
      evidence: [check],
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
      evidence: [{ kind: "check", command: "bun test", exitCode: 0, output: "" }],
    });
    expect([shipped.status, nextOf(shipped.phase)]).toEqual(["shipped", null]);
    const cancelled = state(...planned, {
      action: "order_cancelled",
      details: { reason: "no longer wanted" },
    });
    expect([cancelled.status, at(cancelled)]).toEqual(["cancelled", ["plan", null]]);
  });

  test("holds each session that died with its cause, and leaves the station where it was", () => {
    const died = state(...planned, approve("plan"), {
      action: "session_died",
      code: "usage_limit",
      details: { session: "s-builder", resetsAt: "2026-10-01T00:00:00Z" },
    });
    expect(died.died).toEqual([{ session: "s-builder", code: "usage_limit" }]);
    expect(at(died)).toEqual(["build", "run"]);
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
    by: Acting = OPERATOR,
    live: RunKind | null = null,
  ) => operatorActRefusal(order, by, act.kind, live)?.code ?? null;

  const workRefused = (order: OrderState, acting: Acting) =>
    workRefusal(order, "plan", { kind: "worker", acting })?.code ?? null;

  test("admits, for each kind of order, its step, an update before the plan is approved, a cancel and a message", () => {
    expect(admits(state())).toEqual(["run", "update", "cancel", "message"]);
    expect(admits(state(...planned))).toEqual(["approve", "return", "update", "cancel", "message"]);
    expect(admits(state(...planned, approve("plan")))).toEqual(["run", "cancel", "message"]);
    expect(admits(state(...planned, { action: "order_cancelled", details: { reason: "x" } }))).toEqual([]);
  });

  test("admits an update once the planner returns an order whose plan was approved, and the update needs the plan approved again", () => {
    const returned = [
      ...planned,
      approve("plan"),
      { action: "order_returned", details: { station: "build", reason: "the plan misses a case" } },
      RUN,
      { action: "order_returned", details: { station: "plan", reason: "which case?" } },
    ] satisfies Later[];
    expect(admits(state(...returned))).toEqual(["update", "cancel", "message"]);
    expect(nextAct(state(...returned))).toBe("update");

    const updated = state(...returned, {
      action: "order_updated",
      details: { title: "Greet", description: "Say hello, and the case." },
    });
    expect(admits(updated)).toEqual(["run", "update", "cancel", "message"]);
  });

  test("refuses an act the order does not admit, naming what it admits and its next step", () => {
    expect(operatorActRefusal(state(), OPERATOR, "approve", null)?.meta).toEqual({
      order: "k7m2qx4d",
      act: "approve",
      admits: ["run", "update", "cancel", "message"],
      next: "run",
    });
    expect(refusedCode(state(...planned), { kind: "run" })).toBe("not_admitted");
    expect(refusedCode(state(...planned), { kind: "approve" })).toBeNull();
    expect(refusedCode(state(...planned), { kind: "return" })).toBeNull();
  });

  test("admits an act only from the operator of the order's project", () => {
    const elsewhere: Acting = { ...OPERATOR, worker: { ...OPERATOR.worker, project: "acme/gadgets" } };
    const builder: Acting = {
      ...OPERATOR,
      worker: {
        role: "builder",
        name: "bolt-2",
        project: "acme/widgets",
        order: "k7m2qx4d",
        createdBy: "nut-1",
      },
    };
    expect(refusedCode(state(), { kind: "run" }, elsewhere)).toBe("not_operator");
    expect(refusedCode(state(), { kind: "run" }, builder)).toBe("not_operator");
    expect(refusedCode(state(), { kind: "run" })).toBeNull();
  });

  test("admits an update until the plan is approved, and refuses one after", () => {
    expect(refusedCode(state(), { kind: "update" })).toBeNull();
    expect(refusedCode(state(...planned), { kind: "update" })).toBeNull();
    expect(refusedCode(state(...planned, approve("plan")), { kind: "update" })).toBe("not_admitted");
  });

  test("admits a cancel at any point until the order ends", () => {
    expect(refusedCode(state(...built), { kind: "cancel" })).toBeNull();
    const cancelled = state(...planned, { action: "order_cancelled", details: { reason: "x" } });
    for (const kind of ["run", "approve", "return", "update", "cancel"] as const) {
      expect(refusedCode(cancelled, { kind })).toBe("not_admitted");
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
    expect(workRefused(state(...planned), planner)).toBe("not_at_station");
    const cancelled = state(RUN, BASE, { action: "order_cancelled", details: { reason: "x" } });
    expect(workRefused(cancelled, planner)).toBe("not_at_station");
    expect(workRefusal(running, "plan", { kind: "factory", cause: 2 })).toBeNull();
    expect(workRefusal(cancelled, "plan", { kind: "factory", cause: 2 })?.code).toBe("not_at_station");
  });

  test("builds what an admitted act records", () => {
    const decision = { reason: "it does", decidedBy: "owner" } as const;
    expect(operatorEntry(state(...planned), { kind: "approve", decision })).toEqual({
      action: "artifact_approved",
      details: { station: "plan", reason: "it does", decidedBy: "owner" },
    });
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
