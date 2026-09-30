import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Machine, type MachineOptions, MODELS, newMachine } from "./support/machine";
import { addOrder, approve, messageWorker, runOrder, shipThrough, showOrder } from "./support/operator-acts";
import { actions, workerOf } from "./support/order-view";
import { type HarnessScript, readTranscript, transcriptPath } from "./support/scripted-harness-state";
import { BUILD_ARTIFACT, buildTurn, happyPath, planTurn, reviewTurn, sliceActs } from "./support/scripts";
import { ACTION, NEXT, REFUSAL } from "./support/vocabulary";

setDefaultTimeout(180_000);

const CHECKOUT = join(import.meta.dir, "..");

let machine: Machine;
afterEach(() => machine?.close());

async function scripted(script: HarnessScript, options: MachineOptions = {}): Promise<Machine> {
  machine = await newMachine(options);
  machine.script(script);
  return machine;
}

const toolResults = (m: Machine, role: string) =>
  m
    .invocations()
    .filter((call) => call.role === role)
    .flatMap((call) => readTranscript(transcriptPath(m.env.HOME as string, call.cwd, call.sessionId)))
    .filter((entry) => entry.type === "tool_result")
    .map((entry) => (entry.type === "tool_result" ? entry.output : ""));

describe("the operator", () => {
  test("a new operator session takes over the orders and replies of an operator session that is gone", async () => {
    const m = await scripted({
      planner: [planTurn()],
      builder: [[{ act: "message", text: "Is the second slice still wanted?" }, ...buildTurn()]],
      reviewer: [reviewTurn()],
    });
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);
    await m.operator.fire("SessionEnd");
    m.operator.close();

    const next = await m.newOperator();
    expect((await next.register()).ok).toBe(true);
    await approve(next, id);

    const order = await showOrder(next, id);
    const operators = order.workers.filter((worker) => worker.role === "operator");
    const newest = operators.at(-1)?.name;
    const message = order.log.find((entry) => entry.action === ACTION.messageSent);
    expect(message?.details?.to).toBe(newest);
    expect(order.next).toBe(NEXT.approve);
  });

  test("a second live operator session in a project is refused", async () => {
    const m = await scripted(happyPath());
    const second = await m.newOperator();

    const refused = await second.register();

    expect(refused.ok).toBe(false);
  });

  test("registering refuses a process with no active session of the project above it", async () => {
    const m = await scripted(happyPath());
    const ran = Bun.spawnSync(["dim", "operator", "register"], {
      cwd: m.repo,
      env: m.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(ran.exitCode).not.toBe(0);
    expect(ran.stderr.toString()).toContain(REFUSAL.noSession);
  });

  test("an order action from a session that is not the operator's is refused", async () => {
    const m = await scripted(happyPath());
    const id = await addOrder(m.operator);
    const bystander = await m.newOperator();
    await bystander.fire("SessionStart");

    for (const args of [
      ["order", "run", id],
      ["order", "cancel", id, "--reason", "not mine"],
      ["order", "add", "--title", "Mine", "--request", "Do my thing."],
    ]) {
      const refused = await bystander.dim(args);
      expect(refused.ok).toBe(false);
      expect(refused.error?.code).toBe(REFUSAL.notOperator);
    }
    expect((await showOrder(m.operator, id)).status).toBe("queued");
  });

  test("the operator's attempt to record a plan, a commit or findings itself is refused", async () => {
    const m = await scripted(happyPath());
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);
    const plan = join(m.root, "plan.json");
    writeFileSync(plan, JSON.stringify({ body: "x", slices: [{ title: "a", outcome: "b" }] }));
    const findings = join(m.root, "findings.json");
    writeFileSync(findings, "[]");
    const before = await showOrder(m.operator, id);

    for (const args of [
      ["plan", "return", plan],
      ["slice", "commit", "--subject", "feat: mine"],
      ["review", "return", "--findings", findings],
      ["build", "return", plan],
    ]) {
      expect((await m.operator.dim(args)).ok).toBe(false);
    }
    expect(await showOrder(m.operator, id)).toEqual(before);
  });
});

describe("station workers", () => {
  test("a station worker is refused every operator action and leaves the order unchanged", async () => {
    const operatorActs = (id: string) =>
      [
        ["order", "add", "--title", "Mine", "--request", "Do my thing."],
        ["order", "approve", id, "--reason", "self", "--decided", "owner"],
        ["order", "cancel", id, "--reason", "self"],
        ["order", "revise", id, "--request", "self"],
        ["order", "run", id],
      ].map((args) => ({ act: "dim", args }) as const);
    const m = await scripted({ planner: [planTurn()], builder: [] });
    const id = await addOrder(m.operator);
    m.script({ planner: [[...operatorActs(id), ...planTurn()]] });

    await runOrder(m.operator, id);

    const order = await showOrder(m.operator, id);
    const planner = workerOf(order, "planner").name;
    expect(
      order.log
        .filter((entry) => entry.by.kind === "worker" && entry.by.worker === planner)
        .map((e) => e.action),
    ).toEqual([ACTION.planReturned]);
    expect(order.next).toBe(NEXT.approve);
  });

  test("the operator's message runs a turn of the station worker's session and the reply reaches only the operator", async () => {
    const m = await scripted({
      ...happyPath(),
      builder: [buildTurn(), [{ act: "say", text: "Both slices are committed." }]],
    });
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);
    await approve(m.operator, id);

    const replied = await messageWorker(m.operator, id, "build", "Where do the slices stand?");

    expect(replied.ok).toBe(true);
    expect(JSON.stringify(replied.result)).toContain("Both slices are committed.");
    const builders = m.invocations().filter((call) => call.role === "builder");
    expect(builders[1]?.resumed).toBe(builders[0]?.sessionId as string);
    expect(builders[1]?.prompt).toContain("Where do the slices stand?");
    const order = await showOrder(m.operator, id);
    const operator = workerOf(order, "operator").name;
    const builder = workerOf(order, "builder").name;
    const sent = order.log.filter((entry) => entry.action === ACTION.messageSent);
    expect(sent.map((entry) => [entry.by.kind === "worker" && entry.by.worker, entry.details?.to])).toEqual([
      [operator, builder],
      [builder, operator],
    ]);
  });

  test("a station worker's message to another station's worker or to the owner is refused and recorded as refused", async () => {
    const m = await scripted({
      planner: [planTurn()],
      builder: [
        [
          { act: "message", text: "Review this early?", to: "review" },
          { act: "message", text: "Owner, a word?", to: "owner" },
          ...buildTurn(),
        ],
      ],
    });
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);
    await approve(m.operator, id);

    const order = await showOrder(m.operator, id);
    const builder = workerOf(order, "builder").name;
    const refused = order.log.filter((entry) => entry.action === ACTION.messageRefused);
    expect(refused).toHaveLength(2);
    for (const entry of refused) expect(entry.by.kind === "worker" && entry.by.worker).toBe(builder);
    expect(actions(order)).not.toContain(ACTION.messageSent);
  });

  test("a second session trying to take on a station's worker is refused", async () => {
    const m = await scripted({
      planner: [[{ act: "dim", args: ["operator", "register"] }, ...planTurn()]],
    });
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);

    expect(toolResults(m, "planner")[0]).toContain('"ok":false');
    expect((await showOrder(m.operator, id)).workers.filter((w) => w.role === "operator")).toHaveLength(1);
  });

  test("every worker on a finished order has a generated name, a role and sessions with a harness and a process", async () => {
    const m = await scripted(happyPath());
    const order = await shipThrough(m.operator, await addOrder(m.operator));

    const names = order.workers.map((worker) => worker.name);
    expect(new Set(names).size).toBe(names.length);
    const operator = workerOf(order, "operator").name;
    for (const worker of order.workers) {
      expect(worker.name).toMatch(/^[a-z]+-\d+$/);
      expect(["operator", "planner", "builder", "reviewer"]).toContain(worker.role);
      if (worker.role !== "operator") expect(worker.createdBy).toBe(operator);
      for (const session of worker.sessions) {
        expect(session.harness).toBe("claude");
        expect(session.pid).toBeGreaterThan(0);
      }
    }
    for (const role of ["planner", "builder", "reviewer"])
      expect(workerOf(order, role).sessions.length).toBe(1);
  });

  test("each station's worker starts on its role's model strength", async () => {
    const m = await scripted(happyPath());
    await shipThrough(m.operator, await addOrder(m.operator));

    const models = Object.fromEntries(m.invocations().map((call) => [call.role, call.model]));
    expect(models).toEqual({ planner: MODELS.deep, builder: MODELS.standard, reviewer: MODELS.deep });
  });

  test("resuming a session under another harness is refused", async () => {
    const m = await scripted({ planner: [planTurn(), planTurn()] });
    writeFileSync(join(m.root, "bin", "codex"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(m.root, "bin", "codex"), 0o755);
    writeFileSync(
      join(m.env.DIM_HOME as string, "routing.json"),
      JSON.stringify({ claude: MODELS, codex: MODELS }),
    );
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);

    const refused = await m.operator.dim([
      "order",
      "return",
      id,
      "--reason",
      "again",
      "--decided",
      "owner",
      "--harness",
      "codex",
    ]);

    expect(refused.ok).toBe(false);
    expect(workerOf(await showOrder(m.operator, id), "planner").sessions.map((s) => s.harness)).toEqual([
      "claude",
    ]);
  });

  test.todo("a new session moves a worker to another harness under the same name", () => {});
});

describe("a session that dies", () => {
  const builderThat = (dies: "limit" | "gone"): HarnessScript => ({
    planner: [planTurn()],
    builder: [
      [
        ...sliceActs(1),
        { act: "write", path: "uncommitted.txt", content: "half done\n" },
        ...(dies === "limit"
          ? [{ act: "limit", resetsAt: "2026-10-01T00:00:00Z" } as const]
          : [{ act: "die" } as const]),
      ],
      [...sliceActs(2), { act: "build-return", artifact: BUILD_ARTIFACT }],
    ],
    reviewer: [reviewTurn()],
  });

  for (const dies of ["limit", "gone"] as const) {
    test(`a builder whose session ${dies === "limit" ? "hit a usage limit" : "is gone"} carries on in a new session holding the dead one's context`, async () => {
      const m = await scripted(builderThat(dies));
      const id = await addOrder(m.operator);
      await runOrder(m.operator, id);
      await approve(m.operator, id);
      const [dead] = m.invocations().filter((call) => call.role === "builder");
      const deadTranscript = transcriptPath(
        m.env.HOME as string,
        dead?.cwd as string,
        dead?.sessionId as string,
      );
      const heldWhenItDied = readTranscript(deadTranscript);
      if (dies === "gone") rmSync(deadTranscript);

      expect((await runOrder(m.operator, id)).ok).toBe(true);

      const builders = m.invocations().filter((call) => call.role === "builder");
      expect(builders).toHaveLength(2);
      expect(builders[1]?.sessionId).not.toBe(dead?.sessionId as string);
      expect(builders[1]?.history.slice(0, heldWhenItDied.length)).toEqual(heldWhenItDied);
      const order = await showOrder(m.operator, id);
      const builder = workerOf(order, "builder");
      expect(builder.sessions).toHaveLength(2);
      expect(builder.sessions[0]?.died?.code).toBeString();
      expect(actions(order)).toContain(ACTION.sessionDied);
      expect(m.git(["log", "--format=%s", `main..${order.branch}`])).toBe(
        "feat: add slice 2\nfeat: add slice 1",
      );
      expect(existsSync(join(order.worktree, "uncommitted.txt"))).toBe(true);
      expect(order.next).toBe(NEXT.approve);
    });
  }
});

describe("what a station worker can reach", () => {
  test("neither a station's worker nor the check sees the owner's keys, tokens or agent socket", async () => {
    const leaked =
      '[ -z "$ANTHROPIC_API_KEY$GITHUB_TOKEN$OPENAI_API_KEY$SSH_AUTH_SOCK$CLAUDE_CODE_OAUTH_TOKEN" ]';
    const m = await scripted(happyPath(), {
      check: leaked,
      ownerEnv: {
        ANTHROPIC_API_KEY: "sk-ant-owner",
        OPENAI_API_KEY: "sk-owner",
        GITHUB_TOKEN: "ghp_owner",
        SSH_AUTH_SOCK: "/tmp/owner-agent.sock",
        CLAUDE_CODE_OAUTH_TOKEN: "owner-claude-login",
      },
    });
    const order = await shipThrough(m.operator, await addOrder(m.operator));

    expect(order.status).toBe("shipped");
    for (const call of m.invocations()) {
      for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "SSH_AUTH_SOCK"]) {
        expect(call.env[name]).toBeUndefined();
      }
      expect(call.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("owner-claude-login");
    }
  });

  test("a station worker's writes to the record, the factory's code, its installed skills, hooks or settings are refused", async () => {
    const probe = join(CHECKOUT, ".dim-acceptance-probe");
    const m = await scripted({
      planner: [planTurn()],
      builder: [
        [
          { act: "sh", command: 'touch "$DIM_HOME/planted"' },
          { act: "sh", command: `touch "${probe}"` },
          {
            act: "sh",
            command:
              'mkdir -p "$HOME/.claude/skills/planted" && touch "$HOME/.claude/skills/planted/SKILL.md"',
          },
          { act: "sh", command: 'echo "{}" > "$HOME/.claude/settings.json"' },
          ...buildTurn(),
        ],
      ],
    });
    const settings = readFileSync(join(m.env.HOME as string, ".claude", "settings.json"), "utf8");
    try {
      const id = await addOrder(m.operator);
      await runOrder(m.operator, id);
      await approve(m.operator, id);

      expect(existsSync(join(m.env.DIM_HOME as string, "planted"))).toBe(false);
      expect(existsSync(probe)).toBe(false);
      expect(existsSync(join(m.env.HOME as string, ".claude", "skills", "planted"))).toBe(false);
      expect(readFileSync(join(m.env.HOME as string, ".claude", "settings.json"), "utf8")).toBe(settings);
    } finally {
      rmSync(probe, { force: true });
    }
  });

  test("an order that changes a script its check runs is judged by the default branch's version until it ships", async () => {
    const m = await scripted(
      {
        planner: [planTurn([{ title: "Break the check", outcome: "check.sh fails." }]), planTurn()],
        builder: [
          [
            { act: "write", path: "check.sh", content: "exit 1\n" },
            { act: "commit", subject: "chore: make the check fail" },
            { act: "build-return", artifact: BUILD_ARTIFACT },
          ],
          buildTurn(),
        ],
        reviewer: [reviewTurn(), reviewTurn()],
      },
      { check: "sh check.sh" },
    );
    writeFileSync(join(m.repo, "check.sh"), "exit 0\n");
    m.git(["add", "check.sh"]);
    m.git(["commit", "-q", "-m", "chore: add the check script"]);

    const first = await shipThrough(m.operator, await addOrder(m.operator, { title: "Break" }));
    expect(first.status).toBe("shipped");

    const second = await addOrder(m.operator, { title: "Next" });
    await runOrder(m.operator, second);
    await approve(m.operator, second);
    expect(actions(await showOrder(m.operator, second))).toContain(ACTION.sliceRefused);
  });
});
