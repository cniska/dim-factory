import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkHeld,
  holdCheck,
  holdingCheck,
  holdWhenMainMoves,
  killMatching,
  releaseCheck,
} from "./support/interrupt";
import { type Machine, newMachine } from "./support/machine";
import { addOrder, approve, returnArtifact, runOrder, shipThrough, showOrder } from "./support/operator-acts";
import { actions, workerOf } from "./support/order-view";
import { buildTurn, happyPath, planTurn, reviewTurn } from "./support/scripts";
import { ACTION, NEXT } from "./support/vocabulary";

setDefaultTimeout(120_000);

let machine: Machine;
afterEach(() => machine?.close());

async function started(options: Parameters<typeof newMachine>[0] = {}): Promise<Machine> {
  machine = await newMachine(options);
  machine.script(happyPath());
  return machine;
}

const onMain = (m: Machine, path: string) => m.git(["ls-tree", "--name-only", "main", path]) === path;

describe("an order from request to ship", () => {
  test("an order approved at every station lands on the default branch and is recorded as shipped", async () => {
    const m = await started();
    const id = await addOrder(m.operator);
    expect((await showOrder(m.operator, id)).status).toBe("queued");

    const shipped = await shipThrough(m.operator, id);

    expect(shipped.status).toBe("shipped");
    expect(onMain(m, "slice-1.txt")).toBe(true);
    expect(onMain(m, "slice-2.txt")).toBe(true);
    expect(actions(shipped)).toContain(ACTION.shipLanded);
  });

  test("the operator's only actions on a shipped order are adding it, running it once and approving", async () => {
    const m = await started();
    const id = await addOrder(m.operator);
    const shipped = await shipThrough(m.operator, id);
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
    const m = await started({ project: "acme/widgets" });
    const id = await addOrder(m.operator);
    expect((await showOrder(m.operator, id)).project).toBe("acme/widgets");
  });

  test("an order added outside any checkout is refused unless it names its project", async () => {
    const m = await started();
    const elsewhere = mkdtempSync(join(m.root, "elsewhere-"));
    const args = ["order", "add", "--title", "Greet", "--request", "Add a greeting."];

    const unnamed = await m.operator.dimIn(elsewhere, args);
    const named = await m.operator.dimIn(elsewhere, [...args, "--project", "acme/widgets"]);

    expect(unnamed.ok).toBe(false);
    expect(named.ok).toBe(true);
  });

  test("two orders build at once in their own worktrees and their ships do not overlap", async () => {
    const m = await newMachine({ check: holdingCheck });
    machine = m;
    const held = [
      { act: "write", path: "{order}.txt", content: "one\n" },
      { act: "commit", subject: "feat: add the order's file" },
      { act: "signal", name: "building" },
      { act: "wait", name: "build" },
      { act: "build-return", artifact: "## Outcome\n\nThe order's file." },
    ] as const;
    m.script({
      planner: [
        planTurn([{ title: "One file", outcome: "The order's file exists." }]),
        planTurn([{ title: "One file", outcome: "The order's file exists." }]),
      ],
      builder: [[...held], [...held]],
      reviewer: [reviewTurn(), reviewTurn()],
    });
    const first = await addOrder(m.operator, { title: "First" });
    const second = await addOrder(m.operator, { title: "Second" });
    await runOrder(m.operator, first);
    await runOrder(m.operator, second);

    const builds = [approve(m.operator, first), approve(m.operator, second)];
    while (m.invocations().filter((call) => call.role === "builder").length < 2) await Bun.sleep(20);
    const [a, b] = [await showOrder(m.operator, first), await showOrder(m.operator, second)];
    expect(a.worktree).not.toBe(b.worktree);
    expect(a.branch).not.toBe(b.branch);
    expect(existsSync(a.worktree) && existsSync(b.worktree)).toBe(true);
    m.release("build");
    await Promise.all(builds);
    await approve(m.operator, first);
    await approve(m.operator, second);

    holdCheck(m);
    const ships = [approve(m.operator, first), approve(m.operator, second)];
    await checkHeld();
    await Bun.sleep(500);
    releaseCheck(m);
    await Promise.all(ships);

    const spans = await Promise.all(
      [first, second].map(async (id) => {
        const log = (await showOrder(m.operator, id)).log;
        const start = log.find((entry) => entry.action === ACTION.shipStarted)?.at as string;
        const end = log.find((entry) => entry.action === ACTION.shipLanded)?.at as string;
        return [start, end] as const;
      }),
    );
    const [[s1, e1], [s2, e2]] = spans as [[string, string], [string, string]];
    expect(e1 <= s2 || e2 <= s1).toBe(true);
  });
});

describe("returns and approvals", () => {
  test("a returned plan comes back revised by the same planner, briefed with the reason", async () => {
    const m = await started();
    m.script({ ...happyPath(), planner: [planTurn(), planTurn()] });
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);

    const returned = await returnArtifact(m.operator, id, "name the greeting's file");

    expect(returned.ok).toBe(true);
    const planners = m.invocations().filter((call) => call.role === "planner");
    expect(planners).toHaveLength(2);
    expect(planners[1]?.resumed).toBe(planners[0]?.sessionId as string);
    expect(planners[1]?.prompt).toContain("name the greeting's file");
    const order = await showOrder(m.operator, id);
    expect(order.station).toBe("plan");
    expect(order.next).toBe(NEXT.approve);
  });

  test("a builder that finds a problem in the plan puts the order back at plan with the problem in the planner's brief", async () => {
    const m = await started();
    m.script({
      planner: [planTurn(), planTurn()],
      builder: [[{ act: "send-back", reason: "the second slice contradicts the first" }]],
      reviewer: [],
    });
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);
    await approve(m.operator, id);

    const order = await showOrder(m.operator, id);
    expect(order.station).toBe("plan");
    await runOrder(m.operator, id);
    const planners = m.invocations().filter((call) => call.role === "planner");
    expect(planners.at(-1)?.prompt).toContain("the second slice contradicts the first");
  });

  test("a reviewer that finds a problem in the build puts the order back at build with the problem in the builder's brief", async () => {
    const m = await started();
    m.script({
      planner: [planTurn()],
      builder: [buildTurn(), [{ act: "build-return", artifact: "## Outcome\n\nRevised." }]],
      reviewer: [[{ act: "send-back", reason: "the Build artifact claims a check that never ran" }]],
    });
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);
    await approve(m.operator, id);
    await approve(m.operator, id);

    expect((await showOrder(m.operator, id)).station).toBe("build");
    await runOrder(m.operator, id);
    const builders = m.invocations().filter((call) => call.role === "builder");
    expect(builders.at(-1)?.prompt).toContain("the Build artifact claims a check that never ran");
  });

  test("a planner that cannot plan the order hands it back to the operator", async () => {
    const m = await started();
    m.script({ planner: [[{ act: "cannot-plan", reason: "the request names no file" }]] });
    const id = await addOrder(m.operator);

    await runOrder(m.operator, id);

    const order = await showOrder(m.operator, id);
    expect(order.next).toBe(NEXT.revise);
    expect(order.log.at(-1)?.reason).toBe("the request names no file");
  });

  test("the command that starts a station returns once the station has finished", async () => {
    const m = await started();
    const id = await addOrder(m.operator);

    const ran = await runOrder(m.operator, id);

    expect(ran.ok).toBe(true);
    const order = await showOrder(m.operator, id);
    expect(order.station).toBe("plan");
    expect(order.next).toBe(NEXT.approve);
    expect(order.slices.map((slice) => slice.title)).toEqual([
      "Write the greeting",
      "Link it from the README",
    ]);
  });

  test("no operator command takes a station name", async () => {
    const m = await started();
    const id = await addOrder(m.operator);
    for (const args of [
      ["order", "run", id, "plan"],
      ["order", "run", id, "--station", "plan"],
      ["order", "approve", id, "--to", "build", "--reason", "x", "--decided", "owner"],
      ["order", "return", id, "--to", "plan", "--reason", "x", "--decided", "owner"],
    ]) {
      const refused = await m.operator.dim(args);
      expect(refused.ok).toBe(false);
      expect(refused.error?.code).toBe("usage");
    }
  });
});

describe("shipping", () => {
  async function reviewed(m: Machine): Promise<string> {
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);
    await approve(m.operator, id);
    await approve(m.operator, id);
    return id;
  }

  function ownerCommits(m: Machine, path: string, content: string): void {
    writeFileSync(join(m.repo, path), content);
    m.git(["add", path]);
    m.git(["commit", "-q", "-m", `chore: owner edits ${path}`]);
  }

  test("approving the Review artifact lands the order with no other command", async () => {
    const m = await started();
    const id = await reviewed(m);

    const shipped = await approve(m.operator, id);

    expect(shipped.ok).toBe(true);
    expect((await showOrder(m.operator, id)).status).toBe("shipped");
  });

  test("an order that applies cleanly on a default branch that moved on lands on top of it", async () => {
    const m = await started();
    const id = await reviewed(m);
    ownerCommits(m, "CHANGELOG.md", "moved on\n");
    const moved = m.git(["rev-parse", "main"]);

    await approve(m.operator, id);

    expect((await showOrder(m.operator, id)).status).toBe("shipped");
    expect(m.git(["merge-base", "--is-ancestor", moved, "main"])).toBe("");
    expect(onMain(m, "slice-2.txt") && onMain(m, "CHANGELOG.md")).toBe(true);
  });

  test("a conflict with the moved default branch puts the order back at build", async () => {
    const m = await started();
    const id = await reviewed(m);
    ownerCommits(m, "slice-1.txt", "the owner's own line\n");
    const main = m.git(["rev-parse", "main"]);

    await approve(m.operator, id);

    const order = await showOrder(m.operator, id);
    expect(order.status).toBe("running");
    expect(order.station).toBe("build");
    expect(m.git(["rev-parse", "main"])).toBe(main);
  });

  test("a check that fails on the moved default branch puts the order back at build", async () => {
    const m = await started({ check: "[ ! -e breaks-the-check ]" });
    const id = await reviewed(m);
    ownerCommits(m, "breaks-the-check", "\n");
    const main = m.git(["rev-parse", "main"]);

    await approve(m.operator, id);

    expect((await showOrder(m.operator, id)).station).toBe("build");
    expect(m.git(["rev-parse", "main"])).toBe(main);
  });

  test("a builder's resolution of a ship conflict passes the slice gates before the ship lands it", async () => {
    const m = await started();
    m.script({
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
    });
    const id = await reviewed(m);
    ownerCommits(m, "slice-1.txt", "the owner's own line\n");
    await approve(m.operator, id);

    await runOrder(m.operator, id);
    await approve(m.operator, id);
    await approve(m.operator, id);

    const order = await showOrder(m.operator, id);
    expect(order.status).toBe("shipped");
    expect(actions(order)).toContain(ACTION.sliceCommitted);
    expect(m.git(["show", "main:slice-1.txt"])).toBe("the owner's own line\nslice 1");
  });

  test("a ship killed after the default branch moved leaves every commit landed and the order shipped", async () => {
    const m = await started();
    const id = await reviewed(m);
    holdWhenMainMoves(m, "main-moved");

    const shipping = m.operator.sh(`dim order approve ${id} --reason ship --decided owner`);
    await m.reached("main-moved");
    killMatching(`order approve ${id}`);
    await shipping;
    m.release("main-moved");

    await runOrder(m.operator, id);
    const order = await showOrder(m.operator, id);
    expect(order.status).toBe("shipped");
    expect(onMain(m, "slice-1.txt") && onMain(m, "slice-2.txt")).toBe(true);
  });

  test("a ship killed before the default branch moved leaves nothing landed and the order ready to ship again", async () => {
    const m = await started({ check: holdingCheck });
    const id = await reviewed(m);
    ownerCommits(m, "CHANGELOG.md", "moved on\n");
    const main = m.git(["rev-parse", "main"]);
    holdCheck(m);

    const shipping = m.operator.sh(`dim order approve ${id} --reason ship --decided owner`);
    await checkHeld();
    killMatching(`order approve ${id}`);
    killMatching("dim-held-check");
    await shipping;
    releaseCheck(m);

    expect(m.git(["rev-parse", "main"])).toBe(main);
    const again = await showOrder(m.operator, id);
    expect(again.status).toBe("running");
    expect(again.next).toBe(NEXT.run);
    await runOrder(m.operator, id);
    expect((await showOrder(m.operator, id)).status).toBe("shipped");
  });

  test("a ship stopped by uncommitted changes in the default branch's checkout lands once the checkout is clean", async () => {
    const m = await started();
    const id = await reviewed(m);
    writeFileSync(join(m.repo, "README.md"), "# widgets, edited\n");

    const stopped = await approve(m.operator, id);

    expect(stopped.ok).toBe(false);
    expect(stopped.error?.code).toBeString();
    expect((await showOrder(m.operator, id)).status).toBe("running");
    m.git(["checkout", "--", "README.md"]);
    await runOrder(m.operator, id);
    expect((await showOrder(m.operator, id)).status).toBe("shipped");
  });

  test("an order whose worktree cannot be removed is still shipped and names what it kept", async () => {
    const m = await started();
    const id = await reviewed(m);
    const { worktree, branch } = await showOrder(m.operator, id);
    m.git(["worktree", "lock", worktree, "--reason", "the owner is reading it"]);

    await approve(m.operator, id);

    const order = await showOrder(m.operator, id);
    expect(order.status).toBe("shipped");
    expect(existsSync(worktree)).toBe(true);
    const landed = order.log.find((entry) => entry.action === ACTION.shipLanded);
    expect(JSON.stringify(landed?.details)).toContain(worktree);
    expect(JSON.stringify(landed?.details)).toContain(branch);
  });
});
