import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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
  runOrder,
  showOrder,
  updateOrder,
} from "./support/operator-acts";
import type { OperatorSession } from "./support/operator-session";
import { actions, entriesOf, workerOf } from "./support/order-view";
import { alive } from "./support/processes";
import { buildTurn, happyPath, planTurn, reviewTurn, sliceActs } from "./support/scripts";
import { ACTION, NEXT, REFUSAL } from "./support/vocabulary";

const start = machines();

const OPERATOR_ACTIONS = ["run", "approve", "return"] as const;

type OperatorAction = (typeof OPERATOR_ACTIONS)[number];

const perform: Readonly<
  Record<OperatorAction, (operator: OperatorSession, id: string) => Promise<DimResult>>
> = {
  run: runOrder,
  approve,
  return: (operator, id) => returnArtifact(operator, id, "try again"),
};

const IN_ENGLISH = "Add a greeting to the README, in English.";

async function expectOnlyAdmitted(m: Machine, id: string, admitted: readonly string[]): Promise<void> {
  const before = await showOrder(m.operator, id);
  expect(before.admits).toEqual([...admitted]);
  for (const action of OPERATOR_ACTIONS) {
    if (admitted.includes(action)) continue;
    const { code, meta } = refusal(await perform[action](m.operator, id));
    expect(code).toBe(REFUSAL.notAdmitted);
    expect(meta).toHaveProperty("admits", [...admitted]);
    expect(await showOrder(m.operator, id)).toEqual(before);
  }
}

describe("what an order admits", () => {
  test("in every state, only the acts it admits are allowed and every other one is refused naming them", async () => {
    const m = await start({
      script: {
        planner: [[{ act: "order-return", reason: "the description names no language" }], planTurn()],
        builder: [buildTurn()],
        reviewer: [reviewTurn()],
      },
    });
    const id = await addOrder(m.operator);
    await expectOnlyAdmitted(m, id, ["run", "update", "cancel", "message"]);
    await runOrder(m.operator, id);
    expect((await showOrder(m.operator, id)).next).toBe(NEXT.update);
    await expectOnlyAdmitted(m, id, ["update", "cancel", "message"]);
    await updateOrder(m.operator, id, IN_ENGLISH);
    await expectOnlyAdmitted(m, id, ["run", "update", "cancel", "message"]);
    await runOrder(m.operator, id);
    await expectOnlyAdmitted(m, id, ["approve", "return", "update", "cancel", "message"]);
    await approve(m.operator, id);
    await expectOnlyAdmitted(m, id, ["approve", "return", "cancel", "message"]);
    await approve(m.operator, id);
    await expectOnlyAdmitted(m, id, ["approve", "return", "cancel", "message"]);
    await approve(m.operator, id);
    const shipped = await showOrder(m.operator, id);
    expect(shipped.status).toBe("shipped");
    expect(shipped.next).toBeNull();
    await expectOnlyAdmitted(m, id, []);
    expect(refusal(await cancelOrder(m.operator, id)).code).toBe(REFUSAL.notAdmitted);
  });

  test("an update is accepted until the plan is approved, replans the order, and is refused after", async () => {
    const m = await start({
      script: { planner: [planTurn(), planTurn()], builder: [buildTurn()] },
    });
    const id = await addOrder(m.operator);
    resultOf(await updateOrder(m.operator, id, IN_ENGLISH));
    resultOf(await runOrder(m.operator, id));
    expect(m.invocation("planner", 0).prompt).toContain(IN_ENGLISH);

    resultOf(await updateOrder(m.operator, id, "Add a greeting to the README, in Finnish."));
    const updated = await showOrder(m.operator, id);
    expect(updated.next).toBe(NEXT.run);
    expect(entriesOf(updated, ACTION.updated)).toHaveLength(2);
    resultOf(await runOrder(m.operator, id));
    expect(m.invocation("planner", 1).prompt).toContain("in Finnish");

    resultOf(await approve(m.operator, id));
    const building = await showOrder(m.operator, id);
    expect(refusal(await updateOrder(m.operator, id, "Something else entirely.")).code).toBeString();
    expect(await showOrder(m.operator, id)).toEqual(building);
  });

  test("a cancelled order refuses every action", async () => {
    const m = await start({ script: happyPath() });
    const id = await planned(m.operator);
    resultOf(await cancelOrder(m.operator, id));

    const cancelled = await showOrder(m.operator, id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.next).toBeNull();
    await expectOnlyAdmitted(m, id, []);
  });
});

describe("an order that is busy", () => {
  test("while a station's worker runs, a second run, an approval and a return are refused until its process ends", async () => {
    const m = await start({
      script: {
        planner: [[{ act: "signal", name: "planning" }, { act: "wait", name: "plan" }, ...planTurn()]],
        builder: [buildTurn()],
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
  test("cancelling mid-build stops the builder, records nothing of its turn, removes its workspace and keeps its commits on its branch", async () => {
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
    expect(existsSync(order.workspace)).toBe(false);
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
