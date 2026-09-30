import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settingsPath } from "./support/claude-hooks";
import { readTranscript, transcriptPath } from "./support/claude-transcript";
import { parseDim, refusal, resultOf } from "./support/dim-output";
import { type HarnessTurn, ORDER_PLACEHOLDER } from "./support/harness-script";
import { CHECKOUT, MODELS, machines } from "./support/machine";
import {
  addOrder,
  approve,
  built,
  messageWorker,
  planned,
  returnArtifact,
  runOrder,
  shipThrough,
  showOrder,
} from "./support/operator-acts";
import { actions, entriesOf, entryOf, sessionOf, workerOf } from "./support/order-view";
import { BUILD_ARTIFACT, buildTurn, happyPath, planTurn, reviewTurn, sliceActs } from "./support/scripts";
import { ACTION, NEXT, REFUSAL, STATION_ROLES, WORKER_ROLES } from "./support/vocabulary";

const start = machines();

describe("the operator", () => {
  test("a new operator session takes over the orders and replies of an operator session that is gone", async () => {
    const m = await start({
      script: {
        planner: [planTurn()],
        builder: [[{ act: "message", text: "Is the second slice still wanted?" }, ...buildTurn()]],
        reviewer: [reviewTurn()],
      },
    });
    const id = await planned(m.operator);
    await m.operator.fire("SessionEnd");
    m.operator.close();

    const next = m.createOperator();
    resultOf(await next.register());
    resultOf(await approve(next, id));

    const order = await showOrder(next, id);
    const operators = order.workers.filter((worker) => worker.role === "operator");
    expect(operators.map((worker) => worker.name)).toEqual([
      expect.any(String),
      entryOf(order, ACTION.messageSent).details.to,
    ]);
    expect(order.next).toBe(NEXT.approve);
  });

  test("a second live operator session in a project is refused", async () => {
    const m = await start({ script: happyPath() });
    const second = m.createOperator();

    const refused = await second.register();

    expect(refusal(refused).code).toBeString();
  });

  test("registering refuses a process with no active session of the project above it", async () => {
    const m = await start({ script: happyPath() });
    const ran = Bun.spawnSync(["dim", "operator", "register"], {
      cwd: m.repo,
      env: m.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const result = parseDim({
      exitCode: ran.exitCode,
      stdout: ran.stdout.toString(),
      stderr: ran.stderr.toString(),
    });
    expect(refusal(result).code).toBe(REFUSAL.noSession);
  });

  test("an order action from a session that is not the operator's is refused", async () => {
    const m = await start({ script: happyPath() });
    const id = await addOrder(m.operator);
    const bystander = m.createOperator();
    await bystander.fire("SessionStart");

    for (const args of [
      ["order", "run", id],
      ["order", "cancel", id, "--reason", "not mine"],
      ["order", "add", "--title", "Mine", "--description", "Do my thing."],
    ]) {
      expect(refusal(await bystander.dim(args)).code).toBe(REFUSAL.notOperator);
    }
    expect((await showOrder(m.operator, id)).status).toBe("queued");
  });

  test("the operator's attempt to record a plan, a commit or findings itself is refused", async () => {
    const m = await start({ script: happyPath() });
    const id = await planned(m.operator);
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
      expect(refusal(await m.operator.dim(args)).code).toBeString();
    }
    expect(await showOrder(m.operator, id)).toEqual(before);
  });
});

describe("station workers", () => {
  test("a station worker is refused every operator action and leaves the order unchanged", async () => {
    const operatorActs: HarnessTurn = [
      ["order", "add", "--title", "Mine", "--description", "Do my thing."],
      ["order", "approve", ORDER_PLACEHOLDER, "--reason", "self", "--decided", "owner"],
      ["order", "cancel", ORDER_PLACEHOLDER, "--reason", "self"],
      ["order", "update", ORDER_PLACEHOLDER, "--description", "self"],
      ["order", "run", ORDER_PLACEHOLDER],
    ].map((args) => ({ act: "dim", args }));
    const m = await start({ script: { planner: [[...operatorActs, ...planTurn()]] } });

    const id = await planned(m.operator);

    const order = await showOrder(m.operator, id);
    const planner = workerOf(order, "planner").name;
    const byPlanner = order.log.filter((entry) => entry.by.kind === "worker" && entry.by.worker === planner);
    expect(byPlanner.map((entry) => entry.action)).toEqual([ACTION.planReturned]);
    expect(order.next).toBe(NEXT.approve);
  });

  test("the operator's message runs a turn of the station worker's session and the reply reaches only the operator", async () => {
    const m = await start({
      script: {
        ...happyPath(),
        builder: [buildTurn(), [{ act: "say", text: "Both slices are committed." }]],
      },
    });
    const id = await built(m.operator);

    const replied = await messageWorker(m.operator, id, "build", "Where do the slices stand?");

    expect(JSON.stringify(resultOf(replied))).toContain("Both slices are committed.");
    expect(m.invocation("builder", 1).resumed).toBe(m.invocation("builder", 0).sessionId);
    expect(m.invocation("builder", 1).prompt).toContain("Where do the slices stand?");
    const order = await showOrder(m.operator, id);
    const operator = workerOf(order, "operator").name;
    const builder = workerOf(order, "builder").name;
    const sent = entriesOf(order, ACTION.messageSent);
    expect(sent.map((entry) => [entry.by.kind === "worker" && entry.by.worker, entry.details.to])).toEqual([
      [operator, builder],
      [builder, operator],
    ]);
  });

  test("a station worker's message to another station's worker or to the owner is refused and recorded as refused", async () => {
    const m = await start({
      script: {
        planner: [planTurn()],
        builder: [
          [
            { act: "message", text: "Review this early?", to: "review" },
            { act: "message", text: "Owner, a word?", to: "owner" },
            ...buildTurn(),
          ],
        ],
      },
    });
    const id = await built(m.operator);

    const order = await showOrder(m.operator, id);
    const builder = workerOf(order, "builder").name;
    const refused = entriesOf(order, ACTION.messageRefused);
    expect(refused).toHaveLength(2);
    for (const entry of refused) expect(entry.by.kind === "worker" && entry.by.worker).toBe(builder);
    expect(actions(order)).not.toContain(ACTION.messageSent);
  });

  test("a session the factory did not start for a station's worker cannot act as it", async () => {
    const m = await start({
      script: {
        planner: [planTurn()],
        builder: [[...sliceActs(1), { act: "signal", name: "building" }, { act: "wait", name: "build" }]],
      },
    });
    const id = await planned(m.operator);
    const building = approve(m.operator, id);
    await m.reached("building");
    const { workspace, branch } = await showOrder(m.operator, id);
    writeFileSync(join(workspace, "intruder.txt"), "x\n");
    const intruder = m.createOperator();
    await intruder.fire("SessionStart");

    const refused = await intruder.dimIn(workspace, [
      "slice",
      "commit",
      "--subject",
      "feat: not the builder's",
    ]);
    m.release("build");
    await building;

    expect(refusal(refused).code).toBeString();
    expect(m.commitsOn(branch)).toEqual(["feat: add slice 1"]);
  });

  test("every worker on a finished order has a generated name, a role and sessions with a harness and a process", async () => {
    const m = await start({ script: happyPath() });
    const order = await shipThrough(m.operator, await addOrder(m.operator));

    const names = order.workers.map((worker) => worker.name);
    expect(new Set(names).size).toBe(names.length);
    const operator = workerOf(order, "operator").name;
    for (const worker of order.workers) {
      expect(worker.name).toMatch(/^[a-z]+-\d+$/);
      expect(WORKER_ROLES).toContain(worker.role);
      if (worker.role !== "operator") expect(worker.createdBy).toBe(operator);
      for (const session of worker.sessions) {
        expect(session.harness).toBe("claude");
        expect(session.pid).toBeGreaterThan(0);
      }
    }
    for (const role of STATION_ROLES) expect(workerOf(order, role).sessions).toHaveLength(1);
  });

  test("each station's worker starts on its role's model strength", async () => {
    const m = await start({ script: happyPath() });
    await shipThrough(m.operator, await addOrder(m.operator));

    const models = Object.fromEntries(m.invocations().map((call) => [call.role, call.model]));
    expect(models).toEqual({ planner: MODELS.deep, builder: MODELS.standard, reviewer: MODELS.deep });
  });

  test("a session stays with the harness it started under when the harness setting changes", async () => {
    const m = await start({ script: { planner: [planTurn(), planTurn()] } });
    const id = await planned(m.operator);
    writeFileSync(join(m.bin, "codex"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(m.bin, "codex"), 0o755);
    m.routing({ claude: MODELS, codex: MODELS });
    m.userSettings({ harness: "codex" });

    resultOf(await returnArtifact(m.operator, id, "again"));

    expect(m.invocation("planner", 1).resumed).toBe(m.invocation("planner", 0).sessionId);
    const sessions = workerOf(await showOrder(m.operator, id), "planner").sessions;
    expect(sessions.map((session) => session.harness)).toEqual(["claude"]);
  });
});

describe("a session that dies", () => {
  test("a builder whose session hit a usage limit carries on in a new session holding the dead one's context", async () => {
    const m = await start({
      script: {
        planner: [planTurn()],
        builder: [
          [
            ...sliceActs(1),
            { act: "write", path: "uncommitted.txt", content: "half done\n" },
            { act: "limit", resetsAt: "2026-10-01T00:00:00Z" },
          ],
          [...sliceActs(2), { act: "build-return", artifact: BUILD_ARTIFACT }],
        ],
        reviewer: [reviewTurn()],
      },
    });
    const id = await planned(m.operator);
    expect(refusal(await approve(m.operator, id)).code).toBeString();
    const dead = m.invocation("builder", 0);
    const heldWhenItDied = readTranscript(transcriptPath(m.home, dead.cwd, dead.sessionId));

    resultOf(await runOrder(m.operator, id));

    expect(m.invocations("builder")).toHaveLength(2);
    const successor = m.invocation("builder", 1);
    expect(successor.sessionId).not.toBe(dead.sessionId);
    expect(successor.history.slice(0, heldWhenItDied.length)).toEqual([...heldWhenItDied]);
    const order = await showOrder(m.operator, id);
    const builder = workerOf(order, "builder");
    expect(builder.sessions).toHaveLength(2);
    expect(sessionOf(builder, 0).died?.code).toBeString();
    expect(actions(order)).toContain(ACTION.sessionDied);
    expect(m.commitsOn(order.branch)).toEqual(["feat: add slice 1", "feat: add slice 2"]);
    expect(existsSync(join(order.workspace, "uncommitted.txt"))).toBe(true);
    expect(order.next).toBe(NEXT.approve);
  });

  test("a builder whose session cannot be resumed carries on in a new session holding its context from the record", async () => {
    const m = await start({
      script: {
        planner: [planTurn()],
        builder: [
          [...sliceActs(1), { act: "say", text: "Stopping after the first slice." }],
          [...sliceActs(2), { act: "build-return", artifact: BUILD_ARTIFACT }],
        ],
        reviewer: [reviewTurn()],
      },
    });
    const id = await planned(m.operator);
    expect(refusal(await approve(m.operator, id)).code).toBeString();
    const first = m.invocation("builder", 0);
    const firstTranscript = transcriptPath(m.home, first.cwd, first.sessionId);
    const heldBeforeItWasLost = readTranscript(firstTranscript);
    rmSync(firstTranscript);

    resultOf(await runOrder(m.operator, id));

    const builders = m.invocations("builder");
    const successor = m.invocation("builder", builders.length - 1);
    expect(successor.sessionId).not.toBe(first.sessionId);
    expect(successor.history.slice(0, heldBeforeItWasLost.length)).toEqual([...heldBeforeItWasLost]);
    const builder = workerOf(await showOrder(m.operator, id), "builder");
    expect(builder.sessions).toHaveLength(2);
    expect(sessionOf(builder, 0).died?.code).toBeString();
    expect(builders.filter((call) => call.resumed === first.sessionId && call.turn > 1)).toEqual([]);
  });
});

describe("what a station worker can reach", () => {
  const OWNER_SECRETS = {
    ANTHROPIC_API_KEY: "sk-ant-owner",
    OPENAI_API_KEY: "sk-owner",
    GITHUB_TOKEN: "ghp_owner",
    SSH_AUTH_SOCK: "/tmp/owner-agent.sock",
  };
  const CLAUDE_LOGIN = "owner-claude-login";

  test("neither a station's worker nor the check sees the owner's keys, tokens or agent socket", async () => {
    const unset = [...Object.keys(OWNER_SECRETS), "CLAUDE_CODE_OAUTH_TOKEN"]
      .map((name) => `$${name}`)
      .join("");
    const m = await start({
      script: happyPath(),
      check: `[ -z "${unset}" ]`,
      ownerEnv: { ...OWNER_SECRETS, CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_LOGIN },
    });
    const order = await shipThrough(m.operator, await addOrder(m.operator));

    expect(order.status).toBe("shipped");
    for (const call of m.invocations()) {
      for (const name of Object.keys(OWNER_SECRETS)) expect(call.env[name]).toBeUndefined();
      expect(call.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(CLAUDE_LOGIN);
    }
  });

  test("a station worker's writes to the record, the factory's code, its installed skills, hooks or settings are refused", async () => {
    const probe = join(CHECKOUT, ".dim-acceptance-probe");
    const m = await start({
      script: {
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
      },
    });
    const settings = readFileSync(settingsPath(m.home), "utf8");
    try {
      await built(m.operator);

      expect(existsSync(join(m.dimHome, "planted"))).toBe(false);
      expect(existsSync(probe)).toBe(false);
      expect(existsSync(join(m.home, ".claude", "skills", "planted"))).toBe(false);
      expect(readFileSync(settingsPath(m.home), "utf8")).toBe(settings);
    } finally {
      rmSync(probe, { force: true });
    }
  });
});
