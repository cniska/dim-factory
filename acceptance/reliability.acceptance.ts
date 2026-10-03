import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { everyHookCommand, settingsHooks } from "./support/claude-hooks";
import { commandLine, parseDim, refusal, resultOf } from "./support/dim-output";
import type { HarnessScript, HarnessTurn } from "./support/harness-script";
import { type Machine, machines } from "./support/machine";
import {
  addOrder,
  approve,
  built,
  planned,
  STEP_ARGS_BY_NEXT,
  shipThrough,
  showOrder,
} from "./support/operator-acts";
import { actions, entriesOf, finalStop, type OrderView, sessionOf, workerOf } from "./support/order-view";
import { commandOf, descendants, killPid } from "./support/processes";
import {
  BUILD_ARTIFACT,
  happyPath,
  planTurn,
  REVIEW_ARTIFACT,
  reviewTurn,
  sliceActs,
} from "./support/scripts";
import { ACTION, type Action, type StationRole } from "./support/vocabulary";

const start = machines();

const RANDOM_KILLS_TEST_MS = 600_000;

const STEP_LIMIT = 40;

async function carryToShipped(m: Machine, id: string): Promise<OrderView> {
  let last = "";
  for (let step = 0; step < STEP_LIMIT; step++) {
    const order = await showOrder(m.operator, id);
    const args = order.next === null ? null : STEP_ARGS_BY_NEXT[order.next];
    if (order.status === "shipped" || args === null) return order;
    const ran = await m.operator.sh(commandLine(args(id)));
    last = `${ran.stdout}${ran.stderr}`.trim();
  }
  throw new Error(`order ${id} took ${STEP_LIMIT} steps without settling; the last printed ${last}`);
}

const OPERATOR_ACTIONS: readonly Action[] = [ACTION.added, ACTION.run, ACTION.approved];

describe("a station worker's session killed in its turn", () => {
  const fullBuild: HarnessTurn = [
    ...sliceActs(1),
    ...sliceActs(2),
    { act: "build-return", artifact: BUILD_ARTIFACT },
  ];
  const points: readonly (readonly [string, StationRole, HarnessTurn, HarnessTurn])[] = [
    ["before it starts", "builder", [{ act: "die" }], fullBuild],
    [
      "mid-turn",
      "builder",
      [{ act: "write", path: "slice-1.txt", content: "slice 1\n" }, { act: "die" }],
      [
        { act: "commit", subject: "feat: add slice 1" },
        ...sliceActs(2),
        { act: "build-return", artifact: BUILD_ARTIFACT },
      ],
    ],
    [
      "after committing some slices",
      "builder",
      [...sliceActs(1), { act: "die" }],
      [...sliceActs(2), { act: "build-return", artifact: BUILD_ARTIFACT }],
    ],
    [
      "before it returns",
      "builder",
      [...sliceActs(1), ...sliceActs(2), { act: "die" }],
      [{ act: "build-return", artifact: BUILD_ARTIFACT }],
    ],
    ["mid-plan", "planner", [{ act: "die" }], planTurn()],
    ["mid-review", "reviewer", [{ act: "die" }], reviewTurn()],
  ];

  for (const [point, role, dying, continuing] of points) {
    test(`AC-39 a ${role} killed ${point} gets a new session for the same worker and the order ships with only runs and approvals`, async () => {
      const script: HarnessScript = {
        planner: [planTurn()],
        builder: [fullBuild],
        reviewer: [reviewTurn()],
        [role]: [dying, continuing],
      };
      const m = await start({ script });
      const id = await addOrder(m.operator);

      const order = await carryToShipped(m, id);

      expect(order.status).toBe("shipped");
      const worker = workerOf(order, role);
      expect(worker.sessions).toHaveLength(2);
      expect(sessionOf(worker, 0).died?.code).toBeString();
      const operator = workerOf(order, "operator").name;
      const byOperator = order.log.filter(
        (entry) => entry.by.kind === "worker" && entry.by.worker === operator,
      );
      for (const entry of byOperator) expect(OPERATOR_ACTIONS).toContain(entry.action);
    });
  }
});

describe("random kills", () => {
  const RUNS = 5;
  const TURNS = 20;
  const idempotent: HarnessScript = {
    planner: Array.from({ length: TURNS }, () => planTurn()),
    builder: Array.from(
      { length: TURNS },
      (): HarnessTurn => [{ act: "build-remaining", artifact: BUILD_ARTIFACT }],
    ),
    reviewer: Array.from(
      { length: TURNS },
      (): HarnessTurn => [{ act: "review-return", artifact: REVIEW_ARTIFACT }],
    ),
  };
  const DISTURBANCE: readonly Action[] = [
    ACTION.shipStarted,
    ACTION.branchRebased,
    ACTION.sessionDied,
    ACTION.sessionStarted,
    ACTION.stationFailed,
    ACTION.run,
    ACTION.shipStopped,
  ];
  const undisturbed = (order: OrderView) => actions(order).filter((action) => !DISTURBANCE.includes(action));
  const KILLABLE = /cli\.ts order (run|approve)|scripted-claude/;
  let baseline: Promise<Action[]> | undefined;
  const expected = () => {
    baseline ??= (async () => {
      const m = await start({ script: idempotent });
      const order = await carryToShipped(m, await addOrder(m.operator));
      if (order.status !== "shipped")
        throw new Error(`the undisturbed order ${order.id} ended ${order.status}`);
      return undisturbed(order);
    })();
    return baseline;
  };

  for (let run = 0; run < RUNS; run++) {
    test(
      `AC-54 an order whose stations, ships and sessions are killed at random ends shipped or reported, recording nothing twice (seed ${20260930 + run})`,
      async () => {
        let seed = 20260930 + run;
        const random = () => {
          seed = (seed * 1103515245 + 12345) % 2 ** 31;
          return seed / 2 ** 31;
        };
        const m = await start({ script: idempotent });
        const id = await addOrder(m.operator);
        let kills = 0;
        let done = false;
        const killer = (async () => {
          while (!done && kills < 3) {
            await Bun.sleep(200 + random() * 3000);
            const targets = descendants(m.operator.pid).filter((pid) => KILLABLE.test(commandOf(pid)));
            const target = targets[Math.floor(random() * targets.length)];
            if (target === undefined || done) continue;
            killPid(target);
            kills++;
          }
        })();

        try {
          await carryToShipped(m, id);
          done = true;
          await killer;
          const settled = await carryToShipped(m, id);

          if (settled.status === "shipped") expect(undisturbed(settled)).toEqual(await expected());
          else expect(finalStop(settled).code).toBeString();
          const committed = entriesOf(settled, ACTION.sliceCommitted).map((entry) => entry.details.commit);
          expect(new Set(committed).size).toBe(committed.length);
        } catch (error) {
          done = true;
          const trace = await m.operator.sh(commandLine(["trace", id]));
          throw new Error(`${error}\n\ndim trace ${id}:\n${trace.stdout}`);
        }
      },
      RANDOM_KILLS_TEST_MS,
    );
  }
});

describe("command output", () => {
  test("AC-55 each command prints one structured result, and each refusal carries a code, its details and the command that resolves it", async () => {
    const m = await start({ script: { planner: [planTurn()] } });
    const id = await addOrder(m.operator);
    for (const args of [
      ["order", "show", id],
      ["order", "approve", id, "--reason", "early", "--decided", "owner"],
      ["order", "show", "no-such-order"],
      ["order"],
      ["nonsense"],
    ]) {
      const ran = await m.operator.sh(commandLine(args));
      const lines = `${ran.stdout}${ran.stderr}`.trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      const result = parseDim(ran);
      if (!result.ok) {
        expect(result.error.code).toMatch(/^[a-z_]+$/);
        expect(result.error.meta).toBeObject();
        expect(result.error.resolve).toStartWith("dim ");
      }
    }
  });

  async function commandNames(m: Machine): Promise<readonly string[]> {
    const listed = resultOf(await m.operator.dim([])) as {
      readonly commands: readonly { readonly name: string }[];
    };
    return listed.commands.map((command) => command.name);
  }

  test("AC-21 every command is one whole word, without a hyphen", async () => {
    const m = await start();
    for (const name of await commandNames(m)) expect(name).toMatch(/^[a-z]{2,}$/);
  });
});

describe("hooks", () => {
  test.todo("AC-57 a git hook that cannot read the owner, settings or check lets the commit through, and one that blocks says why", () => {});

  test("AC-56 a session hook whose dim command fails or is missing still lets the session carry on", async () => {
    const m = await start();
    const failing = join(m.root, "failing-bin");
    mkdirSync(failing);
    writeFileSync(join(failing, "dim"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(failing, "dim"), 0o755);
    const commands = everyHookCommand(settingsHooks(m.home));
    expect(commands.length).toBeGreaterThan(0);

    for (const path of [`${failing}:/usr/bin:/bin`, "/usr/bin:/bin"]) {
      for (const command of commands) {
        const ran = Bun.spawnSync(["sh", "-c", command], {
          cwd: m.repo,
          env: { ...m.env, PATH: path },
          stdin: new TextEncoder().encode('{"session_id":"s","hook_event_name":"PostToolUse"}'),
        });
        expect(ran.exitCode).toBe(0);
      }
    }
  });

  test("AC-60 an edit in a station worker's session runs neither the workspace's format command nor its settings' hooks", async () => {
    const m = await start({
      script: {
        planner: [planTurn([{ title: "One", outcome: "One file." }])],
        builder: [[...sliceActs(1), { act: "build-return", artifact: BUILD_ARTIFACT }]],
      },
    });
    writeFileSync(
      join(m.repo, "package.json"),
      JSON.stringify({ scripts: { verify: "true", format: "touch formatted.marker" } }),
    );
    mkdirSync(join(m.repo, ".claude"), { recursive: true });
    writeFileSync(
      join(m.repo, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "touch project-hook.marker" }] }],
          PostToolUse: [{ hooks: [{ type: "command", command: "touch project-hook.marker" }] }],
        },
      }),
    );
    m.git(["add", "-f", "package.json", ".claude/settings.json"]);
    m.git(["commit", "-q", "-m", "chore: a format command and a project hook"]);
    const id = await built(m.operator);

    const { workspace } = await showOrder(m.operator, id);
    expect(existsSync(join(workspace, "formatted.marker"))).toBe(false);
    expect(existsSync(join(workspace, "project-hook.marker"))).toBe(false);
  });

  test("AC-61 a planner writes no git data, and a builder's write to the checkout's git hooks is refused", async () => {
    const checkoutGit = (m: Machine) => join(m.repo, ".git");
    const m = await start({ script: {} });
    m.script({
      planner: [
        [
          { act: "sh", command: `touch "${checkoutGit(m)}/probe-$$"` },
          { act: "sh", command: `git -C "${m.repo}" branch probe-$$` },
          { act: "sh", command: `git -C "${m.repo}" config probe.planner yes` },
          ...planTurn([{ title: "One", outcome: "One file." }]),
        ],
      ],
      builder: [
        [
          { act: "sh", command: `touch "${checkoutGit(m)}/hooks/probe-$$"` },
          ...sliceActs(1),
          { act: "build-return", artifact: BUILD_ARTIFACT },
        ],
      ],
    });
    const config = readFileSync(join(checkoutGit(m), "config"), "utf8");
    await built(m.operator);

    const probes = (dir: string) =>
      Bun.spawnSync(["sh", "-c", `ls "${dir}" | grep -c '^probe-' || true`], { stdout: "pipe" })
        .stdout.toString()
        .trim();
    expect(probes(checkoutGit(m))).toBe("0");
    expect(probes(join(checkoutGit(m), "hooks"))).toBe("0");
    expect(m.git(["branch", "--list", "probe-*"])).toBe("");
    expect(readFileSync(join(checkoutGit(m), "config"), "utf8")).toBe(config);
  });

  test("AC-61 a builder that changes the checkout's git config fails its station, with the config put back", async () => {
    const m = await start({
      script: {
        planner: [planTurn()],
        builder: [
          [
            ...sliceActs(1),
            { act: "sh", command: "git config core.hooksPath elsewhere" },
            ...sliceActs(2),
            { act: "build-return", artifact: BUILD_ARTIFACT },
          ],
        ],
      },
    });
    const config = readFileSync(join(m.repo, ".git", "config"), "utf8");
    const id = await planned(m.operator);

    expect(refusal(await approve(m.operator, id)).code).toBe("git_config_changed");

    expect(readFileSync(join(m.repo, ".git", "config"), "utf8")).toBe(config);
    const order = await showOrder(m.operator, id);
    expect(actions(order).filter((action) => action === ACTION.sliceCommitted)).toHaveLength(1);
  });
});

describe("reading the record", () => {
  const recordVersion = (m: Machine) => sqlite(m, "PRAGMA user_version");
  const sqlite = (m: Machine, sql: string) =>
    Bun.spawnSync(["sqlite3", join(m.record, "sessions.db"), sql], { stdout: "pipe" })
      .stdout.toString()
      .trim();
  const bumpRecordVersionPastTheWriters = (m: Machine) =>
    sqlite(m, `PRAGMA user_version = ${Number(recordVersion(m)) + 1}`);

  async function rows(m: Machine, sql: string): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const read = resultOf(await m.operator.dim(["sql", sql])) as {
      readonly rows: readonly Readonly<Record<string, unknown>>[];
    };
    return read.rows;
  }

  test("AC-58 a write sent through a reader fails and leaves the database unchanged", async () => {
    const m = await start({ script: happyPath() });
    await shipThrough(m.operator, await addOrder(m.operator));
    const [first] = await rows(
      m,
      "select name from sqlite_master where type = 'table' order by name limit 1",
    );
    if (typeof first?.name !== "string") throw new Error("the record holds no table");
    const table = first.name;
    const count = `select count(*) as n from "${table}"`;
    const before = await rows(m, count);

    const refused = await m.operator.dim(["sql", `delete from "${table}"`]);

    expect(refusal(refused).code).toBeString();
    expect(await rows(m, count)).toEqual([...before]);
  });

  test("AC-59 a query, dim sql and dim trace refuse a record from another version with the writer's error and leave it unchanged", async () => {
    const m = await start();
    const id = await addOrder(m.operator);
    bumpRecordVersionPastTheWriters(m);
    const bumped = recordVersion(m);

    const writer = refusal(
      await m.operator.dim(["order", "add", "--title", "Two", "--description", "Another."]),
    );
    for (const args of [
      ["query", "search", "greeting"],
      ["sql", "select 1"],
      ["trace", id],
    ]) {
      expect(refusal(await m.operator.dim(args)).code).toBe(writer.code);
    }
    expect(recordVersion(m)).toBe(bumped);
  });
});
