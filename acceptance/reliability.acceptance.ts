import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { everyHookCommand, settingsHooks } from "./support/claude-hooks";
import { commandLine, parseDim, refusal, resultOf } from "./support/dim-output";
import type { HarnessScript, HarnessTurn } from "./support/harness-script";
import { type Machine, machines } from "./support/machine";
import { addOrder, built, STEP_ARGS_BY_NEXT, shipThrough, showOrder } from "./support/operator-acts";
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
  for (let step = 0; step < STEP_LIMIT; step++) {
    const order = await showOrder(m.operator, id);
    const args = order.next === null ? null : STEP_ARGS_BY_NEXT[order.next];
    if (order.status === "shipped" || args === null) return order;
    await m.operator.sh(commandLine(args(id)));
  }
  return showOrder(m.operator, id);
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
    test(`a ${role} killed ${point} gets a new session for the same worker and the order ships with only runs and approvals`, async () => {
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
    ACTION.sessionDied,
    ACTION.sessionStarted,
    ACTION.stationFailed,
    ACTION.run,
    ACTION.shipStopped,
  ];
  const undisturbed = (order: OrderView) => actions(order).filter((action) => !DISTURBANCE.includes(action));
  const KILLABLE = /cli\.ts order (run|approve)|scripted-claude/;

  test(
    "an order whose stations, ships and sessions are killed at random ends shipped or reported, recording nothing twice",
    async () => {
      const baseline = await start({ script: idempotent });
      const expected = undisturbed(await carryToShipped(baseline, await addOrder(baseline.operator)));

      let seed = 20260930;
      const random = () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed / 2 ** 31;
      };

      for (let run = 0; run < RUNS; run++) {
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

        await carryToShipped(m, id);
        done = true;
        await killer;
        const settled = await carryToShipped(m, id);

        if (settled.status === "shipped") expect(undisturbed(settled)).toEqual(expected);
        else expect(finalStop(settled).code).toBeString();
        const committed = entriesOf(settled, ACTION.sliceCommitted).map((entry) => entry.details.commit);
        expect(new Set(committed).size).toBe(committed.length);
      }
    },
    RANDOM_KILLS_TEST_MS,
  );
});

describe("command output", () => {
  test("each command prints one structured result, and each refusal carries a code, its details and the command that resolves it", async () => {
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

  test("every command is one whole word, without a hyphen", async () => {
    const m = await start();
    for (const name of await commandNames(m)) expect(name).toMatch(/^[a-z]{2,}$/);
  });
});

describe("hooks", () => {
  test("a session hook whose dim command fails or is missing still lets the session carry on", async () => {
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

  test("the commit gate lets a commit through when it cannot read the project's check, and says why when it blocks one", async () => {
    const m = await start({ check: "exit 1" });
    resultOf(await m.operator.dim(["gate", "install", "--owner", "github.com/acme"]));
    const commit = (message: string) =>
      Bun.spawnSync(["git", "commit", "-q", "--allow-empty", "-m", message], {
        cwd: m.repo,
        env: m.env,
        stderr: "pipe",
      });

    const blocked = commit("feat: blocked by the red check");
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.stderr.toString()).toContain("pre-commit:");

    chmodSync(join(m.repo, "package.json"), 0o000);
    try {
      const through = commit("feat: through, the check is unreadable");
      expect(through.exitCode).toBe(0);
      expect(through.stderr.toString()).toContain("not judged");
    } finally {
      chmodSync(join(m.repo, "package.json"), 0o644);
    }
  });

  test("an edit in a station worker's session runs neither the worktree's format command nor its settings' hooks", async () => {
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

    const { worktree } = await showOrder(m.operator, id);
    expect(existsSync(join(worktree, "formatted.marker"))).toBe(false);
    expect(existsSync(join(worktree, "project-hook.marker"))).toBe(false);
  });

  test("a station worker, whether or not it may edit, cannot write the worktree's git data or the checkout's shared git data", async () => {
    const probe: HarnessTurn = [
      { act: "sh", command: 'touch "$(git rev-parse --git-dir)/probe-$$"' },
      { act: "sh", command: 'touch "$(git rev-parse --git-common-dir)/probe-$$"' },
    ];
    const m = await start({
      script: {
        planner: [[...probe, ...planTurn([{ title: "One", outcome: "One file." }])]],
        builder: [[...probe, ...sliceActs(1), { act: "build-return", artifact: BUILD_ARTIFACT }]],
      },
    });
    const id = await built(m.operator);

    const { worktree } = await showOrder(m.operator, id);
    const probes = (dir: string) =>
      Bun.spawnSync(["sh", "-c", `ls "${dir}" | grep -c '^probe-' || true`], { stdout: "pipe" })
        .stdout.toString()
        .trim();
    expect(probes(m.git(["rev-parse", "--absolute-git-dir"], worktree))).toBe("0");
    expect(probes(join(m.repo, ".git"))).toBe("0");
  });
});

describe("reading the record", () => {
  const recordVersion = (m: Machine) => sqlite(m, "PRAGMA user_version");
  const sqlite = (m: Machine, sql: string) =>
    Bun.spawnSync(["sqlite3", join(m.dimHome, "sessions.db"), sql], { stdout: "pipe" })
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

  test("a write sent through a reader fails and leaves the database unchanged", async () => {
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

  test("a query, dim sql and dim trace refuse a record from another version with the writer's error and leave it unchanged", async () => {
    const m = await start();
    const id = await addOrder(m.operator);
    bumpRecordVersionPastTheWriters(m);
    const bumped = recordVersion(m);

    const writer = refusal(await m.operator.dim(["order", "add", "--title", "Two", "--request", "Another."]));
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
