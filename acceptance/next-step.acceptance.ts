import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type DimResult, refusal, resultOf } from "./support/dim-output";
import { checkHeld, holdCheck, holdingCheck, releaseCheck } from "./support/holds";
import { type Machine, machines } from "./support/machine";
import {
  addOrder,
  approve,
  cancelOrder,
  planned,
  returnArtifact,
  reviewed,
  reviseOrder,
  runOrder,
  showOrder,
} from "./support/operator-acts";
import type { OperatorSession } from "./support/operator-session";
import { actions, workerOf } from "./support/order-view";
import { alive } from "./support/processes";
import { buildTurn, happyPath, planTurn, reviewTurn, sliceActs } from "./support/scripts";
import { ACTION, NEXT, type Next, REFUSAL } from "./support/vocabulary";

const start = machines();

const OPERATOR_ACTIONS = ["run", "approve", "return", "revise"] as const;

type OperatorAction = (typeof OPERATOR_ACTIONS)[number];

const perform: Readonly<
  Record<OperatorAction, (operator: OperatorSession, id: string) => Promise<DimResult>>
> = {
  run: runOrder,
  approve,
  return: (operator, id) => returnArtifact(operator, id, "try again"),
  revise: (operator, id) => reviseOrder(operator, id, "Add a greeting to the README, in English."),
};

const ALLOWED_BY_NEXT: Readonly<Record<Next, readonly OperatorAction[]>> = {
  run: ["run"],
  approve: ["approve", "return"],
  revise: ["revise"],
  decide: [],
};

async function expectOnlyNextAllowed(m: Machine, id: string): Promise<void> {
  const before = await showOrder(m.operator, id);
  const allowed = before.next === null ? [] : ALLOWED_BY_NEXT[before.next];
  for (const action of OPERATOR_ACTIONS) {
    if (allowed.includes(action)) continue;
    const { code, meta } = refusal(await perform[action](m.operator, id));
    expect(code).toBe(REFUSAL.notNext);
    expect(meta).toHaveProperty("next", before.next);
    expect(await showOrder(m.operator, id)).toEqual(before);
  }
}

describe("an order's next step", () => {
  test("in every state, only the next step is allowed and every other action is refused naming it", async () => {
    const m = await start({
      script: {
        planner: [[{ act: "order-return", reason: "the request names no language" }], planTurn()],
        builder: [buildTurn()],
        reviewer: [reviewTurn()],
      },
    });
    const id = await addOrder(m.operator);
    await expectOnlyNextAllowed(m, id);
    await runOrder(m.operator, id);
    expect((await showOrder(m.operator, id)).next).toBe(NEXT.revise);
    await expectOnlyNextAllowed(m, id);
    await reviseOrder(m.operator, id, "Add a greeting to the README, in English.");
    await expectOnlyNextAllowed(m, id);
    await runOrder(m.operator, id);
    await expectOnlyNextAllowed(m, id);
    await approve(m.operator, id);
    await expectOnlyNextAllowed(m, id);
    await approve(m.operator, id);
    await expectOnlyNextAllowed(m, id);
    await approve(m.operator, id);
    const shipped = await showOrder(m.operator, id);
    expect(shipped.status).toBe("shipped");
    expect(shipped.next).toBeNull();
    await expectOnlyNextAllowed(m, id);
    expect(refusal(await cancelOrder(m.operator, id)).code).toBeString();
  });

  test("a cancelled order refuses every action", async () => {
    const m = await start({ script: happyPath() });
    const id = await planned(m.operator);
    resultOf(await cancelOrder(m.operator, id));

    const cancelled = await showOrder(m.operator, id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.next).toBeNull();
    await expectOnlyNextAllowed(m, id);
  });
});

describe("an order that is busy", () => {
  test("while a station's worker runs, a second run, an approval and a return are refused until its process ends", async () => {
    const m = await start({
      script: {
        planner: [[{ act: "signal", name: "planning" }, { act: "wait", name: "plan" }, ...planTurn()]],
      },
    });
    const id = await addOrder(m.operator);

    const running = runOrder(m.operator, id);
    const pid = await m.reached("planning");
    for (const refused of [
      await runOrder(m.operator, id),
      await approve(m.operator, id),
      await returnArtifact(m.operator, id, "early"),
    ]) {
      expect(refusal(refused).code).toBe(REFUSAL.busy);
    }
    m.release("plan");
    await running;

    expect(alive(pid)).toBe(false);
    resultOf(await approve(m.operator, id));
  });

  test("while an order ships, a run, an approval, a return and a cancel are refused", async () => {
    const m = await start({ script: happyPath(), check: holdingCheck });
    const id = await reviewed(m.operator);
    m.ownerCommits("CHANGELOG.md", "moved on\n");
    holdCheck(m);

    const shipping = approve(m.operator, id);
    await checkHeld(m);
    for (const refused of [
      await runOrder(m.operator, id),
      await approve(m.operator, id),
      await returnArtifact(m.operator, id, "wait"),
      await cancelOrder(m.operator, id),
    ]) {
      expect(refusal(refused).code).toBe(REFUSAL.busy);
    }
    releaseCheck(m);
    await shipping;
    expect((await showOrder(m.operator, id)).status).toBe("shipped");
  });
});

describe("cancelling and failing", () => {
  test("cancelling mid-build stops the builder, records nothing of its turn and keeps its commits and worktree", async () => {
    const m = await start({
      script: {
        planner: [planTurn()],
        builder: [
          [
            ...sliceActs(1),
            { act: "write", path: "unfinished.txt", content: "half\n" },
            { act: "signal", name: "mid-build" },
            { act: "wait", name: "never" },
          ],
        ],
      },
    });
    const id = await planned(m.operator);
    const building = approve(m.operator, id);
    const pid = await m.reached("mid-build");
    const before = await showOrder(m.operator, id);

    const cancelled = await cancelOrder(m.operator, id, "the owner changed their mind");
    const builderAliveAfterCancel = alive(pid);
    await building;

    resultOf(cancelled);
    expect(builderAliveAfterCancel).toBe(false);
    const order = await showOrder(m.operator, id);
    expect(order.status).toBe("cancelled");
    expect(order.log.slice(0, before.log.length)).toEqual([...before.log]);
    expect(actions(order).slice(before.log.length)).toEqual([ACTION.cancelled]);
    expect(m.commitsOn(order.branch)).toEqual(["feat: add slice 1"]);
    expect(existsSync(join(order.worktree, "unfinished.txt"))).toBe(true);
  });

  test("after a failed station, running the order again resumes the same worker where the record puts it", async () => {
    const m = await start({
      script: {
        planner: [planTurn()],
        builder: [
          [...sliceActs(1), { act: "say", text: "I stopped without returning." }],
          [...sliceActs(2), { act: "build-return", artifact: "## Outcome\n\nBoth slices." }],
        ],
        reviewer: [reviewTurn()],
      },
    });
    const id = await planned(m.operator);

    expect(refusal(await approve(m.operator, id)).code).toBeString();
    const after = await showOrder(m.operator, id);
    expect(after.station).toBe("build");
    expect(after.next).toBe(NEXT.run);

    resultOf(await runOrder(m.operator, id));
    expect(m.invocation("builder", 1).resumed).toBe(m.invocation("builder", 0).sessionId);
    const order = await showOrder(m.operator, id);
    expect(workerOf(order, "builder").sessions).toHaveLength(1);
    expect(order.next).toBe(NEXT.approve);
  });
});
