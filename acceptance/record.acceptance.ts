import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Machine, type MachineOptions, newMachine } from "./support/machine";
import { addOrder, approve, runOrder, shipThrough, showOrder } from "./support/operator-acts";
import { actions, type LogEntry, type OrderView, workerOf } from "./support/order-view";
import type { HarnessScript } from "./support/scripted-harness-state";
import { BUILD_ARTIFACT, buildTurn, happyPath, planTurn, reviewTurn, sliceActs } from "./support/scripts";
import { ACTION } from "./support/vocabulary";

setDefaultTimeout(180_000);

let machine: Machine;
afterEach(() => machine?.close());

async function scripted(script: HarnessScript, options: MachineOptions = {}): Promise<Machine> {
  machine = await newMachine(options);
  machine.script(script);
  return machine;
}

async function shippedAfterMainMoved(m: Machine): Promise<OrderView> {
  const id = await addOrder(m.operator);
  await runOrder(m.operator, id);
  await approve(m.operator, id);
  await approve(m.operator, id);
  writeFileSync(join(m.repo, "CHANGELOG.md"), "moved on\n");
  m.git(["add", "CHANGELOG.md"]);
  m.git(["commit", "-q", "-m", "chore: move main"]);
  await approve(m.operator, id);
  return showOrder(m.operator, id);
}

const factoryEntries = (order: OrderView) => order.log.filter((entry) => entry.by.kind === "factory");

describe("attribution", () => {
  test("a finished order links each worker to every session it had and names the session behind every action", async () => {
    const m = await scripted(happyPath());
    const order = await shipThrough(m.operator, await addOrder(m.operator));

    const sessions = new Map(
      order.workers.flatMap((worker) => worker.sessions.map((s) => [s.id, worker.name])),
    );
    for (const entry of order.log) {
      if (entry.by.kind === "worker") expect(sessions.get(entry.by.session)).toBe(entry.by.worker);
      else expect(entry.by.kind).toBe("factory");
    }
    const stationSessions = m.invocations().map((call) => call.sessionId);
    for (const id of stationSessions) expect(sessions.has(id)).toBe(true);
  });

  test("a factory action names the factory's version and the action that caused it", async () => {
    const m = await scripted(happyPath());
    const order = await shippedAfterMainMoved(m);

    const bySeq = new Map(order.log.map((entry) => [entry.seq, entry]));
    for (const entry of factoryEntries(order)) {
      if (entry.by.kind !== "factory") continue;
      expect(entry.by.version).toBeString();
      expect(bySeq.has(entry.by.cause)).toBe(true);
    }
    const landed = order.log.find((entry) => entry.action === ACTION.shipLanded);
    const cause = landed?.by.kind === "factory" ? bySeq.get(landed.by.cause) : undefined;
    expect(cause?.action).toBe(ACTION.approved);
  });

  test("a refused slice names the commit that caused it, and a replaced session the session that died", async () => {
    const m = await scripted(
      {
        planner: [planTurn([{ title: "One", outcome: "One file." }])],
        builder: [
          [
            { act: "write", path: "red.txt", content: "x\n" },
            { act: "commit", subject: "feat: red" },
            { act: "sh", command: "rm red.txt" },
            { act: "write", path: "one.txt", content: "x\n" },
            { act: "die" },
          ],
          [
            { act: "commit", subject: "feat: one" },
            { act: "build-return", artifact: BUILD_ARTIFACT },
          ],
        ],
      },
      { check: "[ ! -e red.txt ]" },
    );
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);
    await approve(m.operator, id);
    await runOrder(m.operator, id);

    const order = await showOrder(m.operator, id);
    const bySeq = new Map(order.log.map((entry) => [entry.seq, entry]));
    const causeOf = (entry: LogEntry | undefined) =>
      entry?.by.kind === "factory" ? bySeq.get(entry.by.cause) : undefined;
    const refused = order.log.find((entry) => entry.action === ACTION.sliceRefused);
    expect(causeOf(refused)?.by.kind).toBe("worker");
    const died = order.log.find((entry) => entry.action === ACTION.sessionDied);
    const deadSession = workerOf(order, "builder").sessions[0]?.id;
    expect(died?.details?.session).toBe(deadSession);
  });

  test("an action from a process the factory cannot tie to a session is refused", async () => {
    const m = await scripted(happyPath());
    const id = await addOrder(m.operator);
    const env = { ...m.env, DIM_WORKER_NAME: workerOf(await showOrder(m.operator, id), "operator").name };

    const ran = Bun.spawnSync(["dim", "order", "run", id], {
      cwd: m.repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(ran.exitCode).not.toBe(0);
    expect((await showOrder(m.operator, id)).status).toBe("queued");
  });

  test("no command sets or changes who took an action", async () => {
    const m = await scripted(happyPath());
    const id = await addOrder(m.operator);
    for (const flag of ["--by", "--worker", "--session", "--as"]) {
      const refused = await m.operator.dim(["order", "run", id, flag, "someone"]);
      expect(refused.ok).toBe(false);
      expect(refused.error?.code).toBe("usage");
    }
  });
});

describe("the order log", () => {
  test("one log holds every action on the order once, in order, with the factory's checks, rebase, landing and cleanup and their evidence", async () => {
    const m = await scripted(happyPath());
    const order = await shippedAfterMainMoved(m);

    const seqs = order.log.map((entry) => entry.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const factory = factoryEntries(order);
    expect(factory.some((entry) => entry.evidence?.some((e) => e.kind === "check"))).toBe(true);
    expect(factory.some((entry) => entry.evidence?.some((e) => e.kind === "rebase"))).toBe(true);
    expect(actions(order)).toContain(ACTION.shipLanded);
    expect(actions(order)).toContain(ACTION.cleanedUp);
  });

  test("no command changes or removes an entry the log already holds", async () => {
    const m = await scripted(happyPath());
    const id = await addOrder(m.operator);
    const seen: LogEntry[][] = [];
    for (const step of [
      () => runOrder(m.operator, id),
      () => approve(m.operator, id),
      () => approve(m.operator, id),
      () => approve(m.operator, id),
      () => m.operator.dim(["order", "clean", id]),
    ]) {
      await step();
      seen.push((await showOrder(m.operator, id)).log);
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]?.slice(0, seen[i - 1]?.length)).toEqual(seen[i - 1] as LogEntry[]);
    }
  });

  test("a worker's session is readable in full: everything it was sent and everything it did", async () => {
    const m = await scripted(happyPath());
    const order = await shipThrough(m.operator, await addOrder(m.operator));
    const session = workerOf(order, "builder").sessions[0]?.id as string;

    const shown = (await m.operator.dimOk(["session", "show", session])) as { entries: unknown[] };

    const [builder] = m.invocations().filter((call) => call.role === "builder");
    expect(JSON.stringify(shown.entries)).toContain(builder?.prompt.slice(0, 40) as string);
    expect(JSON.stringify(shown.entries)).toContain("feat: add slice 2");
  });
});

describe("decisions", () => {
  test("a decision without a reason is refused, from the operator or a station's worker", async () => {
    const m = await scripted({
      planner: [planTurn()],
      builder: [[{ act: "dim", args: ["order", "return"] }, ...buildTurn()]],
      reviewer: [reviewTurn()],
    });
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);
    for (const args of [
      ["order", "approve", id, "--decided", "owner"],
      ["order", "return", id, "--decided", "owner"],
      ["order", "cancel", id],
    ]) {
      const refused = await m.operator.dim(args);
      expect(refused.ok).toBe(false);
    }
    await approve(m.operator, id);

    const order = await showOrder(m.operator, id);
    expect(order.station).toBe("build");
    expect(actions(order)).not.toContain(ACTION.sentBack);
  });

  test("each decision shows who decided it and why", async () => {
    const m = await scripted(happyPath());
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);
    await approve(m.operator, id, "the plan covers the request", "owner");
    await approve(m.operator, id, "both slices are there", "operator");

    const approvals = (await showOrder(m.operator, id)).log.filter(
      (entry) => entry.action === ACTION.approved,
    );
    expect(approvals.map(({ decidedBy, reason }) => ({ decidedBy, reason }))).toEqual([
      { decidedBy: "owner", reason: "the plan covers the request" },
      { decidedBy: "operator", reason: "both slices are there" },
    ]);
  });

  test("each failed station, refused slice and stopped ship shows its cause as a code", async () => {
    const m = await scripted(
      {
        planner: [planTurn([{ title: "One", outcome: "One file." }])],
        builder: [
          [
            { act: "write", path: "red.txt", content: "x\n" },
            { act: "commit", subject: "feat: red" },
            { act: "say", text: "stopping" },
          ],
          [
            { act: "sh", command: "rm red.txt" },
            ...sliceActs(1),
            { act: "build-return", artifact: BUILD_ARTIFACT },
          ],
        ],
        reviewer: [reviewTurn()],
      },
      { check: "[ ! -e red.txt ]" },
    );
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);
    await approve(m.operator, id);
    await runOrder(m.operator, id);
    await approve(m.operator, id);
    writeFileSync(join(m.repo, "README.md"), "# dirty\n");
    await approve(m.operator, id);

    const order = await showOrder(m.operator, id);
    for (const action of [ACTION.stationFailed, ACTION.sliceRefused, ACTION.shipStopped]) {
      const entry = order.log.find((e) => e.action === action);
      expect(entry?.code).toMatch(/^[a-z_]+$/);
    }
  });
});

describe("turns", () => {
  test("work returned after its worker's turn closed records nothing", async () => {
    const m = await scripted({
      planner: [planTurn([{ title: "One", outcome: "One file." }])],
      builder: [
        [
          { act: "write", path: "one.txt", content: "x\n" },
          { act: "sh", command: "(sleep 2; dim slice commit --subject 'feat: late') > /dev/null 2>&1 &" },
          { act: "say", text: "done for now" },
        ],
      ],
    });
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);
    await approve(m.operator, id);
    await Bun.sleep(4000);

    const order = await showOrder(m.operator, id);
    expect(actions(order)).not.toContain(ACTION.sliceCommitted);
    expect(m.git(["log", "--format=%s", `main..${order.branch}`])).toBe("");
  });
});

describe("the trace", () => {
  test("deleting the trace leaves every order's log and next step unchanged", async () => {
    const m = await scripted(happyPath());
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);
    const before = await showOrder(m.operator, id);

    await m.operator.dimOk(["trace", "clear"]);

    expect(await showOrder(m.operator, id)).toEqual(before);
  });

  test("the trace follows one order's factory steps while it runs", async () => {
    const m = await scripted({
      planner: [[{ act: "signal", name: "planning" }, { act: "wait", name: "plan" }, ...planTurn()]],
    });
    const id = await addOrder(m.operator);
    const following = Bun.spawn(["dim", "trace", id], { cwd: m.repo, env: m.env, stdout: "pipe" });
    const running = runOrder(m.operator, id);
    await m.reached("planning");
    await Bun.sleep(1000);
    m.release("plan");
    await running;
    await Bun.sleep(500);
    following.kill();

    const lines = (await new Response(following.stdout).text()).trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(JSON.parse(line).order).toBe(id);
  });
});

describe("measurement", () => {
  test.todo("the time each station took, returns and review rounds per order, and how often sessions died are each one query", () => {});
});
