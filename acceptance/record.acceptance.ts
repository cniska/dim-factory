import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDim, quote, refusal, resultOf } from "./support/dim-output";
import { type Machine, machines } from "./support/machine";
import {
  addOrder,
  approve,
  planned,
  reviewed,
  runOrder,
  shipThrough,
  showOrder,
  transcriptOf,
} from "./support/operator-acts";
import {
  actions,
  causeOf,
  entriesOf,
  entryOf,
  type LogEntry,
  type OrderView,
  sessionOf,
  workerOf,
} from "./support/order-view";
import { releasePath } from "./support/scripted-harness-state";
import { BUILD_ARTIFACT, buildTurn, happyPath, planTurn, reviewTurn, sliceActs } from "./support/scripts";
import { ACTION, REFUSAL } from "./support/vocabulary";
import { waitFor } from "./support/wait";

const start = machines();

async function shippedAfterMainMoved(m: Machine): Promise<OrderView> {
  const id = await reviewed(m.operator);
  m.ownerCommits("CHANGELOG.md", "moved on\n");
  await approve(m.operator, id);
  return showOrder(m.operator, id);
}

type FactoryEntry = LogEntry & { readonly by: Extract<LogEntry["by"], { readonly kind: "factory" }> };

const factoryEntries = (order: OrderView): readonly FactoryEntry[] =>
  order.log.filter((entry): entry is FactoryEntry => entry.by.kind === "factory");

describe("attribution", () => {
  test("a finished order links each worker to every session it had and names the session behind every action", async () => {
    const m = await start({ script: happyPath() });
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
    const m = await start({ script: happyPath() });
    const order = await shippedAfterMainMoved(m);

    for (const entry of factoryEntries(order)) {
      expect(entry.by.version).toBeString();
      causeOf(order, entry);
    }
    expect(causeOf(order, entryOf(order, ACTION.shipLanded)).action).toBe(ACTION.approved);
  });

  test("a refused slice names the commit that caused it, and a replaced session the session that died", async () => {
    const m = await start({
      check: "[ ! -e red.txt ]",
      script: {
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
    });
    const id = await planned(m.operator);
    expect(refusal(await approve(m.operator, id)).code).toBeString();
    await runOrder(m.operator, id);

    const order = await showOrder(m.operator, id);
    const builder = workerOf(order, "builder");
    const submitted = causeOf(order, entryOf(order, ACTION.sliceRefused));
    expect(submitted.action).toBe(ACTION.sliceSubmitted);
    expect(submitted.by).toMatchObject({ kind: "worker", worker: builder.name });
    expect(entryOf(order, ACTION.sessionDied).details.session).toBe(sessionOf(builder, 0).id);
  });

  test("an action from a process the factory cannot tie to a session is refused", async () => {
    const m = await start({ script: happyPath() });
    const id = await addOrder(m.operator);
    const env = { ...m.env, DIM_WORKER_NAME: workerOf(await showOrder(m.operator, id), "operator").name };

    const ran = Bun.spawnSync(["dim", "order", "run", id], {
      cwd: m.repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const result = parseDim({
      exitCode: ran.exitCode,
      stdout: ran.stdout.toString(),
      stderr: ran.stderr.toString(),
    });

    expect(refusal(result).code).toBe(REFUSAL.noSession);
    expect((await showOrder(m.operator, id)).status).toBe("queued");
  });

  test("no command sets or changes who took an action", async () => {
    const m = await start({ script: happyPath() });
    const id = await addOrder(m.operator);
    for (const flag of ["--by", "--worker", "--session", "--as"]) {
      const refused = await m.operator.dim(["order", "run", id, flag, "someone"]);
      expect(refusal(refused).code).toBe(REFUSAL.usage);
    }
  });
});

describe("the order log", () => {
  test("one log holds every action on the order once, in order, with the factory's checks, rebase, landing and cleanup and their evidence", async () => {
    const m = await start({ script: happyPath() });
    const order = await shippedAfterMainMoved(m);

    const seqs = order.log.map((entry) => entry.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const evidence = factoryEntries(order).flatMap((entry) =>
      "evidence" in entry ? entry.evidence.map((item) => item.kind) : [],
    );
    expect(evidence).toContain("check");
    expect(entryOf(order, ACTION.branchRebased).details.commits).toHaveLength(2);
    expect(entryOf(order, ACTION.shipLanded).evidence.map((item) => item.kind)).toEqual(["check"]);
    expect(actions(order)).toContain(ACTION.cleanedUp);
  });

  test("no command changes or removes an entry the log already holds", async () => {
    const m = await start({ script: happyPath() });
    const id = await addOrder(m.operator);
    let previous: readonly LogEntry[] = [];
    for (const step of [
      () => runOrder(m.operator, id),
      () => approve(m.operator, id),
      () => approve(m.operator, id),
      () => approve(m.operator, id),
      () => m.operator.dim(["order", "clean", id]),
    ]) {
      resultOf(await step());
      const { log } = await showOrder(m.operator, id);
      expect(log.slice(0, previous.length)).toEqual([...previous]);
      previous = log;
    }
  });

  test("a worker's session is readable in full: everything it was sent and everything it did", async () => {
    const m = await start({ script: happyPath() });
    const order = await shipThrough(m.operator, await addOrder(m.operator));
    const session = sessionOf(workerOf(order, "builder"), 0).id;

    const entries = await transcriptOf(m.operator, session);

    expect(entries).toContainEqual({ type: "user", text: m.invocation("builder", 0).prompt });
    const commands = entries.flatMap((entry) =>
      entry.type === "tool_use" ? [String(entry.input.command)] : [],
    );
    expect(commands.some((command) => command.includes("feat: add slice 2"))).toBe(true);
  });
});

describe("decisions", () => {
  test("a decision without a reason is refused, from the operator or a station's worker", async () => {
    const m = await start({
      script: {
        planner: [planTurn()],
        builder: [[{ act: "dim", args: ["order", "return"] }, ...buildTurn()]],
        reviewer: [reviewTurn()],
      },
    });
    const id = await planned(m.operator);
    for (const args of [
      ["order", "approve", id, "--decided", "owner"],
      ["order", "return", id, "--decided", "owner"],
      ["order", "cancel", id],
    ]) {
      expect(refusal(await m.operator.dim(args)).code).toBeString();
    }
    resultOf(await approve(m.operator, id));

    const order = await showOrder(m.operator, id);
    expect(order.station).toBe("build");
    expect(actions(order)).not.toContain(ACTION.orderReturned);
    expect(actions(order)).not.toContain(ACTION.artifactReturned);
  });

  test("each decision shows who decided it and why", async () => {
    const m = await start({ script: happyPath() });
    const id = await planned(m.operator);
    await approve(m.operator, id, "the plan covers the description", "owner");
    await approve(m.operator, id, "both slices are there", "operator");

    const approvals = entriesOf(await showOrder(m.operator, id), ACTION.approved);
    expect(approvals.map(({ details: { decidedBy, reason } }) => ({ decidedBy, reason }))).toEqual([
      { decidedBy: "owner", reason: "the plan covers the description" },
      { decidedBy: "operator", reason: "both slices are there" },
    ]);
  });

  test("each failed station, refused slice and stopped ship shows its cause as a code", async () => {
    const m = await start({
      check: "[ ! -e red.txt ]",
      script: {
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
    });
    const id = await planned(m.operator);
    expect(refusal(await approve(m.operator, id)).code).toBeString();
    await runOrder(m.operator, id);
    await approve(m.operator, id);
    writeFileSync(join(m.repo, "README.md"), "# dirty\n");
    await approve(m.operator, id);

    const order = await showOrder(m.operator, id);
    for (const action of [ACTION.stationFailed, ACTION.sliceRefused, ACTION.shipStopped]) {
      expect(entryOf(order, action).code).toMatch(/^[a-z_]+$/);
    }
  });
});

describe("turns", () => {
  test("a commit made after its worker's turn closed is not recorded, and the next run takes it off the branch", async () => {
    const m = await start();
    const late = "feat: late";
    const turnClosed = quote(releasePath(m.state, "turn-closed"));
    m.script({
      planner: [planTurn([{ title: "One", outcome: "One file." }])],
      builder: [
        [
          { act: "write", path: "one.txt", content: "x\n" },
          {
            act: "sh",
            command: `(while [ ! -e ${turnClosed} ]; do sleep 0.05; done; git add -A && git commit -q -m ${quote(late)} && dim slice submit) > /dev/null 2>&1 &`,
          },
          { act: "say", text: "done for now" },
        ],
        [
          { act: "commit", subject: "feat: one" },
          { act: "build-return", artifact: BUILD_ARTIFACT },
        ],
      ],
    });
    const id = await planned(m.operator);
    expect(refusal(await approve(m.operator, id)).code).toBeString();
    m.release("turn-closed");
    await waitFor(
      "the late commit to finish",
      () => Bun.spawnSync(["pgrep", "-f", releasePath(m.state, "turn-closed")]).exitCode !== 0,
    );

    const closed = await showOrder(m.operator, id);
    expect(m.commitsOn(closed.branch)).toEqual([late]);
    expect(actions(closed)).not.toContain(ACTION.sliceSubmitted);

    resultOf(await runOrder(m.operator, id));

    const order = await showOrder(m.operator, id);
    expect(m.commitsOn(order.branch)).toEqual(["feat: one"]);
    expect(entriesOf(order, ACTION.sliceCommitted)).toHaveLength(1);
  });
});

describe("the trace", () => {
  test("deleting the trace leaves every order's log and next step unchanged", async () => {
    const m = await start({ script: happyPath() });
    const id = await planned(m.operator);
    const before = await showOrder(m.operator, id);

    resultOf(await m.operator.dim(["trace", "clear"]));

    expect(await showOrder(m.operator, id)).toEqual(before);
  });

  test("the trace follows one order's factory steps while it runs", async () => {
    const m = await start({
      script: {
        planner: [[{ act: "signal", name: "planning" }, { act: "wait", name: "plan" }, ...planTurn()]],
      },
    });
    const id = await addOrder(m.operator);
    const following = Bun.spawn(["dim", "trace", id], { cwd: m.repo, env: m.env, stdout: "pipe" });
    const printed: string[] = [];
    const reading = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of following.stdout) printed.push(decoder.decode(chunk));
    })();
    const lines = () => printed.join("").split("\n").slice(0, -1);
    const running = runOrder(m.operator, id);
    await m.reached("planning");
    await waitFor("the trace to print a step of the running order", () => lines().length > 0);
    m.release("plan");
    resultOf(await running);
    following.kill();
    await reading;

    for (const line of lines()) expect(JSON.parse(line).order).toBe(id);
  });
});
