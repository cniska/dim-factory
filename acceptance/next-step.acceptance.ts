import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkHeld, holdCheck, holdingCheck, releaseCheck } from "./support/interrupt";
import { type Machine, newMachine } from "./support/machine";
import {
  addOrder,
  approve,
  cancelOrder,
  returnArtifact,
  reviseOrder,
  runOrder,
  showOrder,
} from "./support/operator-acts";
import type { DimResult, OperatorSession } from "./support/operator-session";
import { actions, workerOf } from "./support/order-view";
import { buildTurn, happyPath, planTurn, reviewTurn } from "./support/scripts";
import { ACTION, NEXT, REFUSAL } from "./support/vocabulary";

setDefaultTimeout(180_000);

let machine: Machine;
afterEach(() => machine?.close());

type Action = "run" | "approve" | "return" | "revise";

const perform: Record<Action, (operator: OperatorSession, id: string) => Promise<DimResult>> = {
  run: (operator, id) => runOrder(operator, id),
  approve: (operator, id) => approve(operator, id),
  return: (operator, id) => returnArtifact(operator, id, "try again"),
  revise: (operator, id) => reviseOrder(operator, id, "Add a greeting to the README, in English."),
};

const allowedBy: Record<string, Action[]> = {
  [NEXT.run]: ["run"],
  [NEXT.approve]: ["approve", "return"],
  [NEXT.revise]: ["revise"],
};

async function expectOnlyNextAllowed(m: Machine, id: string): Promise<void> {
  const before = await showOrder(m.operator, id);
  const allowed = before.next ? (allowedBy[before.next] ?? []) : [];
  for (const action of Object.keys(perform) as Action[]) {
    if (allowed.includes(action)) continue;
    const refused = await perform[action](m.operator, id);
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe(REFUSAL.notNext);
    expect(refused.error?.meta?.next ?? null).toBe(before.next);
    expect(await showOrder(m.operator, id)).toEqual(before);
  }
}

describe("an order's next step", () => {
  test("in every state, only the next step is allowed and every other action is refused naming it", async () => {
    machine = await newMachine();
    const m = machine;
    m.script({
      planner: [[{ act: "cannot-plan", reason: "the request names no language" }], planTurn()],
      builder: [buildTurn()],
      reviewer: [reviewTurn()],
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
    expect((await cancelOrder(m.operator, id)).ok).toBe(false);
  });

  test("a cancelled order refuses every action", async () => {
    machine = await newMachine();
    const m = machine;
    m.script(happyPath());
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);
    expect((await cancelOrder(m.operator, id)).ok).toBe(true);

    const cancelled = await showOrder(m.operator, id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.next).toBeNull();
    await expectOnlyNextAllowed(m, id);
  });
});

describe("an order that is busy", () => {
  test("while a station's worker runs, a second run, an approval and a return are refused until its process ends", async () => {
    machine = await newMachine();
    const m = machine;
    m.script({
      planner: [[{ act: "signal", name: "planning" }, { act: "wait", name: "plan" }, ...planTurn()]],
    });
    const id = await addOrder(m.operator);

    const running = runOrder(m.operator, id);
    const pid = await m.reached("planning");
    for (const refused of [
      await runOrder(m.operator, id),
      await approve(m.operator, id),
      await returnArtifact(m.operator, id, "early"),
    ]) {
      expect(refused.ok).toBe(false);
      expect(refused.error?.code).toBe(REFUSAL.busy);
    }
    m.release("plan");
    await running;

    expect(() => process.kill(pid, 0)).toThrow();
    expect((await approve(m.operator, id)).ok).toBe(true);
  });

  test("while an order ships, a run, an approval and a return are refused", async () => {
    machine = await newMachine({ check: holdingCheck });
    const m = machine;
    m.script(happyPath());
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);
    await approve(m.operator, id);
    await approve(m.operator, id);
    m.git(["commit", "-q", "--allow-empty", "-m", "chore: move main"]);
    holdCheck(m);

    const shipping = approve(m.operator, id);
    await checkHeld();
    for (const refused of [
      await runOrder(m.operator, id),
      await approve(m.operator, id),
      await returnArtifact(m.operator, id, "wait"),
      await cancelOrder(m.operator, id),
    ]) {
      expect(refused.ok).toBe(false);
      expect(refused.error?.code).toBe(REFUSAL.busy);
    }
    releaseCheck(m);
    await shipping;
    expect((await showOrder(m.operator, id)).status).toBe("shipped");
  });
});

describe("cancelling and failing", () => {
  test("cancelling mid-build stops the builder, records nothing of its turn and keeps its commits and worktree", async () => {
    machine = await newMachine();
    const m = machine;
    m.script({
      planner: [planTurn()],
      builder: [
        [
          { act: "write", path: "slice-1.txt", content: "slice 1\n" },
          { act: "commit", subject: "feat: add slice 1" },
          { act: "write", path: "unfinished.txt", content: "half\n" },
          { act: "signal", name: "mid-build" },
          { act: "wait", name: "never" },
          { act: "commit", subject: "feat: add the unfinished slice" },
          { act: "build-return", artifact: "## Outcome\n\nToo late." },
        ],
      ],
    });
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);
    const building = approve(m.operator, id);
    const pid = await m.reached("mid-build");
    const before = await showOrder(m.operator, id);

    const cancelled = await m.operator.sh(`dim order cancel ${id} --reason "the owner changed their mind"`);
    m.release("never");
    await building;

    expect(cancelled.exitCode).toBe(0);
    expect(() => process.kill(pid, 0)).toThrow();
    const order = await showOrder(m.operator, id);
    expect(order.status).toBe("cancelled");
    expect(order.log.slice(0, before.log.length)).toEqual(before.log);
    expect(actions(order).slice(before.log.length)).toEqual([ACTION.cancelled]);
    expect(m.git(["log", "--format=%s", `main..${order.branch}`])).toBe("feat: add slice 1");
    expect(existsSync(join(order.worktree, "unfinished.txt"))).toBe(true);
  });

  test("after a failed station, running the order again resumes the same worker where the record puts it", async () => {
    machine = await newMachine();
    const m = machine;
    m.script({
      planner: [planTurn()],
      builder: [
        [...buildTurn(1).slice(0, 2), { act: "say", text: "I stopped without returning." }],
        [...buildTurn(2).slice(2)],
      ],
      reviewer: [reviewTurn()],
    });
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);

    const failed = await approve(m.operator, id);
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBeString();
    const after = await showOrder(m.operator, id);
    expect(after.station).toBe("build");
    expect(after.next).toBe(NEXT.run);

    expect((await runOrder(m.operator, id)).ok).toBe(true);
    const builders = m.invocations().filter((call) => call.role === "builder");
    expect(builders[1]?.resumed).toBe(builders[0]?.sessionId as string);
    const order = await showOrder(m.operator, id);
    expect(workerOf(order, "builder").sessions).toHaveLength(1);
    expect(order.next).toBe(NEXT.approve);
  });
});
