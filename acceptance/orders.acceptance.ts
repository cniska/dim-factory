import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commandLine, refusal, resultOf } from "./support/dim-output";
import { type HarnessTurn, ORDER_PLACEHOLDER } from "./support/harness-script";
import { checkHeld, holdCheck, holdingCheck, holdWhenMainMoves, releaseCheck } from "./support/holds";
import { type Machine, machines } from "./support/machine";
import {
  addOrder,
  approve,
  approveArgs,
  built,
  planned,
  returnArtifact,
  reviewed,
  runOrder,
  shipThrough,
  showOrder,
} from "./support/operator-acts";
import { actions, entriesOf, entryOf, type OrderView, workerOf } from "./support/order-view";
import { descendantRunning, killPid } from "./support/processes";
import { buildTurn, happyPath, planTurn, reviewTurn } from "./support/scripts";
import { ACTION, NEXT, REFUSAL } from "./support/vocabulary";
import { waitFor } from "./support/wait";

const start = machines();

const approveInFlight = (m: Machine, id: string) => m.operator.sh(commandLine(approveArgs(id)));

const killApproval = (m: Machine, id: string) =>
  killPid(descendantRunning(m.operator.pid, `order approve ${id}`));

const shipping = (order: OrderView) =>
  actions(order).includes(ACTION.shipStarted) && !actions(order).includes(ACTION.shipLanded);

describe("an order from added to shipped", () => {
  test("an order approved at every station lands on the default branch and is recorded as shipped", async () => {
    const m = await start({ script: happyPath() });
    const id = await addOrder(m.operator);
    expect((await showOrder(m.operator, id)).status).toBe("queued");

    const shipped = await shipThrough(m.operator, id);

    expect(shipped.status).toBe("shipped");
    expect(m.onMain("slice-1.txt")).toBe(true);
    expect(m.onMain("slice-2.txt")).toBe(true);
    expect(actions(shipped)).toContain(ACTION.shipLanded);
  });

  test("the operator's only actions on a shipped order are adding it, running it once and approving", async () => {
    const m = await start({ script: happyPath() });
    const shipped = await shipThrough(m.operator, await addOrder(m.operator));
    const operator = workerOf(shipped, "operator").name;

    const byOperator = shipped.log.filter(
      (entry) => entry.by.kind === "worker" && entry.by.worker === operator,
    );

    expect(byOperator.map((entry) => entry.action)).toEqual([
      ACTION.added,
      ACTION.run,
      ACTION.approved,
      ACTION.approved,
      ACTION.approved,
    ]);
  });

  test("an order added in a checkout belongs to the project its origin remote names", async () => {
    const m = await start({ project: "acme/widgets" });
    const id = await addOrder(m.operator);
    expect((await showOrder(m.operator, id)).project).toBe("acme/widgets");
  });

  test("an order added outside any checkout is refused unless it names its project", async () => {
    const m = await start();
    const elsewhere = mkdtempSync(join(m.root, "elsewhere-"));
    const args = ["order", "add", "--title", "Greet", "--description", "Add a greeting."];

    const unnamed = await m.operator.dimIn(elsewhere, args);
    const named = await m.operator.dimIn(elsewhere, [...args, "--project", "acme/widgets"]);

    expect(refusal(unnamed).code).toBeString();
    resultOf(named);
  });

  test("two orders build at once in their own workspaces", async () => {
    const held: HarnessTurn = [
      { act: "write", path: `${ORDER_PLACEHOLDER}.txt`, content: "one\n" },
      { act: "commit", subject: "feat: add the order's file" },
      { act: "signal", name: "building" },
      { act: "wait", name: "build" },
      { act: "build-return", artifact: "## Outcome\n\nThe order's file." },
    ];
    const plan = planTurn([{ title: "One file", outcome: "The order's file exists." }]);
    const m = await start({ script: { planner: [plan, plan], builder: [held, held] } });
    const first = await addOrder(m.operator, { title: "First" });
    const second = await addOrder(m.operator, { title: "Second" });
    await runOrder(m.operator, first);
    await runOrder(m.operator, second);

    const builds = [approve(m.operator, first), approve(m.operator, second)];
    await waitFor("both builders to start", () => m.invocations("builder").length === 2);
    const [a, b] = [await showOrder(m.operator, first), await showOrder(m.operator, second)];
    m.release("build");
    await Promise.all(builds);

    expect(a.workspace).not.toBe(b.workspace);
    expect(a.branch).not.toBe(b.branch);
    expect(existsSync(a.workspace) && existsSync(b.workspace)).toBe(true);
  });

  test("two orders approved together ship one after the other", async () => {
    const plan = planTurn([{ title: "One file", outcome: "The order's file exists." }]);
    const build: HarnessTurn = [
      { act: "write", path: `${ORDER_PLACEHOLDER}.txt`, content: "one\n" },
      { act: "commit", subject: "feat: add the order's file" },
      { act: "build-return", artifact: "## Outcome\n\nThe order's file." },
    ];
    const m = await start({
      check: holdingCheck,
      script: { planner: [plan, plan], builder: [build, build], reviewer: [reviewTurn(), reviewTurn()] },
    });
    const first = await reviewed(m.operator, { title: "First" });
    const second = await reviewed(m.operator, { title: "Second" });
    m.ownerCommits("CHANGELOG.md", "moved on\n");
    holdCheck(m);

    const ships = [approve(m.operator, first), approve(m.operator, second)];
    await checkHeld(m);
    const approvedThrice = async (id: string) =>
      entriesOf(await showOrder(m.operator, id), ACTION.approved).length === 3;
    await waitFor("both Review approvals to be recorded", async () =>
      (await Promise.all([first, second].map(approvedThrice))).every(Boolean),
    );
    const during = [await showOrder(m.operator, first), await showOrder(m.operator, second)];
    releaseCheck(m);
    const approvals = await Promise.all(ships);

    expect(during.filter(shipping)).toHaveLength(1);
    for (const approval of approvals) resultOf(approval);
    for (const id of [first, second]) expect((await showOrder(m.operator, id)).status).toBe("shipped");
  });
});

describe("returns and approvals", () => {
  test("a returned plan comes back revised by the same planner, briefed with the reason", async () => {
    const m = await start({ script: { ...happyPath(), planner: [planTurn(), planTurn()] } });
    const id = await planned(m.operator);

    const returned = await returnArtifact(m.operator, id, "name the greeting's file");

    resultOf(returned);
    expect(m.invocations("planner")).toHaveLength(2);
    expect(m.invocation("planner", 1).resumed).toBe(m.invocation("planner", 0).sessionId);
    expect(m.invocation("planner", 1).prompt).toContain("name the greeting's file");
    const order = await showOrder(m.operator, id);
    expect(order.station).toBe("plan");
    expect(order.next).toBe(NEXT.approve);
  });

  test("a builder that finds a problem in the plan puts the order back at plan with the problem in the planner's brief", async () => {
    const m = await start({
      script: {
        planner: [planTurn(), planTurn()],
        builder: [[{ act: "order-return", reason: "the second slice contradicts the first" }]],
      },
    });
    const id = await built(m.operator);

    expect((await showOrder(m.operator, id)).station).toBe("plan");
    resultOf(await runOrder(m.operator, id));
    expect(m.invocation("planner", 1).prompt).toContain("the second slice contradicts the first");
  });

  test("a reviewer that finds a problem in the build puts the order back at build with the problem in the builder's brief", async () => {
    const m = await start({
      script: {
        planner: [planTurn()],
        builder: [buildTurn(), [{ act: "build-return", artifact: "## Outcome\n\nRevised." }]],
        reviewer: [[{ act: "order-return", reason: "the Build artifact claims a check that never ran" }]],
      },
    });
    const id = await reviewed(m.operator);

    expect((await showOrder(m.operator, id)).station).toBe("build");
    resultOf(await runOrder(m.operator, id));
    expect(m.invocation("builder", 1).prompt).toContain("the Build artifact claims a check that never ran");
  });

  test("a planner that cannot plan the order hands it back to the operator", async () => {
    const m = await start({
      script: { planner: [[{ act: "order-return", reason: "the description names no file" }]] },
    });
    const id = await addOrder(m.operator);

    await runOrder(m.operator, id);

    const order = await showOrder(m.operator, id);
    expect(order.next).toBe(NEXT.update);
    expect(entryOf(order, ACTION.orderReturned).details.reason).toBe("the description names no file");
  });

  test("the command that starts a station returns once the station has finished", async () => {
    const m = await start({ script: happyPath() });
    const id = await addOrder(m.operator);

    const ran = await runOrder(m.operator, id);

    resultOf(ran);
    const order = await showOrder(m.operator, id);
    expect(order.station).toBe("plan");
    expect(order.next).toBe(NEXT.approve);
    expect(order.slices.map((slice) => slice.title)).toEqual([
      "Write the greeting",
      "Link it from the README",
    ]);
  });

  test("no operator command takes a station name", async () => {
    const m = await start({ script: happyPath() });
    const id = await addOrder(m.operator);
    for (const args of [
      ["order", "run", id, "plan"],
      ["order", "run", id, "--station", "plan"],
      ["order", "approve", id, "--to", "build", "--reason", "x", "--decided", "owner"],
      ["order", "return", id, "--to", "plan", "--reason", "x", "--decided", "owner"],
    ]) {
      expect(refusal(await m.operator.dim(args)).code).toBe(REFUSAL.usage);
    }
  });
});

describe("shipping", () => {
  test("approving the Review artifact lands the order with no other command", async () => {
    const m = await start({ script: happyPath() });
    const id = await reviewed(m.operator);

    const shipped = await approve(m.operator, id);

    resultOf(shipped);
    expect((await showOrder(m.operator, id)).status).toBe("shipped");
  });

  test("an order that applies cleanly on a default branch that moved on lands on top of it", async () => {
    const m = await start({ script: happyPath() });
    const id = await reviewed(m.operator);
    m.ownerCommits("CHANGELOG.md", "moved on\n");
    const moved = m.git(["rev-parse", "main"]);

    await approve(m.operator, id);

    expect((await showOrder(m.operator, id)).status).toBe("shipped");
    expect(m.git(["merge-base", "--is-ancestor", moved, "main"])).toBe("");
    expect(m.onMain("slice-2.txt") && m.onMain("CHANGELOG.md")).toBe(true);
  });

  test("a conflict with the moved default branch puts the order back at build", async () => {
    const m = await start({ script: happyPath() });
    const id = await reviewed(m.operator);
    m.ownerCommits("slice-1.txt", "the owner's own line\n");
    const main = m.git(["rev-parse", "main"]);

    expect(refusal(await approve(m.operator, id)).code).toBeString();

    const order = await showOrder(m.operator, id);
    expect(order.status).toBe("running");
    expect(order.station).toBe("build");
    expect(m.git(["rev-parse", "main"])).toBe(main);
  });

  test("a check that fails on the moved default branch puts the order back at build", async () => {
    const m = await start({ script: happyPath(), check: "[ ! -e breaks-the-check ]" });
    const id = await reviewed(m.operator);
    m.ownerCommits("breaks-the-check", "\n");
    const main = m.git(["rev-parse", "main"]);

    expect(refusal(await approve(m.operator, id)).code).toBeString();

    expect((await showOrder(m.operator, id)).station).toBe("build");
    expect(m.git(["rev-parse", "main"])).toBe(main);
  });

  test("a builder's resolution of a ship conflict passes the slice gates before the ship lands it", async () => {
    const m = await start({
      script: {
        planner: [planTurn()],
        builder: [
          buildTurn(),
          [
            { act: "write", path: "slice-1.txt", content: "the owner's own line\nslice 1\n" },
            { act: "commit", subject: "fix: keep the owner's line" },
            { act: "build-return", artifact: "## Outcome\n\nResolved the conflict." },
          ],
        ],
        reviewer: [reviewTurn(), reviewTurn()],
      },
    });
    const id = await reviewed(m.operator);
    m.ownerCommits("slice-1.txt", "the owner's own line\n");
    expect(refusal(await approve(m.operator, id)).code).toBeString();

    resultOf(await runOrder(m.operator, id));
    resultOf(await approve(m.operator, id));
    resultOf(await approve(m.operator, id));

    const order = await showOrder(m.operator, id);
    expect(order.status).toBe("shipped");
    expect(actions(order)).toContain(ACTION.sliceCommitted);
    expect(m.git(["show", "main:slice-1.txt"])).toBe("the owner's own line\nslice 1");
  });

  test("a ship killed after the default branch moved leaves every commit landed and the order shipped", async () => {
    const m = await start({ script: happyPath() });
    const id = await reviewed(m.operator);
    holdWhenMainMoves(m, "main-moved");

    const killed = approveInFlight(m, id);
    await m.reached("main-moved");
    killApproval(m, id);
    await killed;
    m.release("main-moved");

    await runOrder(m.operator, id);
    expect((await showOrder(m.operator, id)).status).toBe("shipped");
    expect(m.onMain("slice-1.txt") && m.onMain("slice-2.txt")).toBe(true);
  });

  test("a ship killed before the default branch moved leaves nothing landed and the order ready to ship again", async () => {
    const m = await start({ script: happyPath(), check: holdingCheck });
    const id = await reviewed(m.operator);
    m.ownerCommits("CHANGELOG.md", "moved on\n");
    const main = m.git(["rev-parse", "main"]);
    holdCheck(m);

    const killed = approveInFlight(m, id);
    const held = await checkHeld(m);
    killApproval(m, id);
    killPid(held);
    await killed;
    releaseCheck(m);

    expect(m.git(["rev-parse", "main"])).toBe(main);
    const again = await showOrder(m.operator, id);
    expect(again.status).toBe("running");
    expect(again.next).toBe(NEXT.run);
    await runOrder(m.operator, id);
    expect((await showOrder(m.operator, id)).status).toBe("shipped");
  });

  test("a ship stopped by uncommitted changes in the default branch's checkout lands once the checkout is clean", async () => {
    const m = await start({ script: happyPath() });
    const id = await reviewed(m.operator);
    writeFileSync(join(m.repo, "README.md"), "# widgets, edited\n");

    const stopped = await approve(m.operator, id);

    expect(refusal(stopped).code).toBeString();
    expect((await showOrder(m.operator, id)).status).toBe("running");
    m.git(["checkout", "--", "README.md"]);
    await runOrder(m.operator, id);
    expect((await showOrder(m.operator, id)).status).toBe("shipped");
  });

  test("an order whose workspace cannot be removed is still shipped and names what it kept", async () => {
    const m = await start({ script: happyPath() });
    const id = await reviewed(m.operator);
    const { workspace, branch } = await showOrder(m.operator, id);
    const held = join(workspace, "held-by-the-owner");
    mkdirSync(held);
    writeFileSync(join(held, "notes.txt"), "the owner is reading it\n");
    chmodSync(held, 0o555);

    await approve(m.operator, id);

    chmodSync(held, 0o755);
    const order = await showOrder(m.operator, id);
    expect(order.status).toBe("shipped");
    expect(existsSync(workspace)).toBe(true);
    const kept = JSON.stringify(entryOf(order, ACTION.shipLanded).details);
    expect(kept).toContain(workspace);
    expect(kept).toContain(branch);
  });
});
