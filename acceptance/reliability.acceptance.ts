import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settingsHooks } from "./support/claude-hooks";
import { commandOf, descendants, killPid } from "./support/interrupt";
import { type Machine, type MachineOptions, newMachine } from "./support/machine";
import { addOrder, approve, runOrder, shipThrough, showOrder } from "./support/operator-acts";
import { parseDim } from "./support/operator-session";
import { actions, type OrderView, workerOf } from "./support/order-view";
import type { HarnessScript, HarnessTurn, Role } from "./support/scripted-harness-state";
import {
  BUILD_ARTIFACT,
  happyPath,
  planTurn,
  REVIEW_ARTIFACT,
  reviewTurn,
  sliceActs,
} from "./support/scripts";
import { ACTION, NEXT } from "./support/vocabulary";

setDefaultTimeout(600_000);

let machine: Machine;
afterEach(() => machine?.close());

async function scripted(script: HarnessScript, options: MachineOptions = {}): Promise<Machine> {
  machine = await newMachine(options);
  machine.script(script);
  return machine;
}

async function carryToShipped(m: Machine, id: string, limit = 30): Promise<OrderView> {
  for (let step = 0; step < limit; step++) {
    const order = await showOrder(m.operator, id);
    if (order.status === "shipped" || order.next === null) return order;
    if (order.next === NEXT.run) await runOrder(m.operator, id);
    else if (order.next === NEXT.approve) await approve(m.operator, id);
    else return order;
  }
  return showOrder(m.operator, id);
}

describe("a station worker's session killed in its turn", () => {
  const points: [string, Role, HarnessTurn, HarnessTurn][] = [
    [
      "before it starts",
      "builder",
      [{ act: "die" }],
      [...sliceActs(1), ...sliceActs(2), { act: "build-return", artifact: BUILD_ARTIFACT }],
    ],
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
      const turns: Record<Role, HarnessTurn[]> = {
        planner: [planTurn()],
        builder: [[...sliceActs(1), ...sliceActs(2), { act: "build-return", artifact: BUILD_ARTIFACT }]],
        reviewer: [reviewTurn()],
      };
      turns[role] = [dying, continuing];
      const m = await scripted(turns);
      const id = await addOrder(m.operator);

      const order = await carryToShipped(m, id);

      expect(order.status).toBe("shipped");
      const worker = workerOf(order, role);
      expect(worker.sessions).toHaveLength(2);
      expect(worker.sessions[0]?.died?.code).toBeString();
      const operator = workerOf(order, "operator").name;
      const operatorActions = order.log
        .filter((entry) => entry.by.kind === "worker" && entry.by.worker === operator)
        .map((entry) => entry.action);
      expect(
        operatorActions.every((action) =>
          [ACTION.added, ACTION.run, ACTION.approved].includes(action as never),
        ),
      ).toBe(true);
    });
  }
});

describe("random kills", () => {
  const RUNS = 5;
  const idempotent: HarnessScript = {
    planner: Array.from({ length: 20 }, () => planTurn()),
    builder: Array.from(
      { length: 20 },
      () => [{ act: "build-remaining", artifact: BUILD_ARTIFACT }] as HarnessTurn,
    ),
    reviewer: Array.from(
      { length: 20 },
      () => [{ act: "review-return", artifact: REVIEW_ARTIFACT }] as HarnessTurn,
    ),
  };
  const undisturbed = (order: OrderView) =>
    actions(order).filter(
      (action) =>
        ![
          ACTION.sessionDied,
          ACTION.sessionStarted,
          ACTION.stationFailed,
          ACTION.run,
          ACTION.shipStopped,
        ].includes(action as never),
    );

  test("an order whose stations, ships and sessions are killed at random ends shipped or reported, recording nothing twice", async () => {
    const baseline = await scripted(idempotent);
    const expected = undisturbed(await carryToShipped(baseline, await addOrder(baseline.operator)));
    baseline.close();

    let seed = 20260930;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };

    for (let run = 0; run < RUNS; run++) {
      const m = await scripted(idempotent);
      const id = await addOrder(m.operator);
      let kills = 0;
      let done = false;
      const killer = (async () => {
        while (!done && kills < 3) {
          await Bun.sleep(200 + random() * 3000);
          const targets = descendants(m.operator.pid).filter((pid) =>
            /cli\.ts|scripted-claude/.test(commandOf(pid)),
          );
          const target = targets[Math.floor(random() * targets.length)];
          if (target !== undefined && !done) {
            killPid(target);
            kills++;
          }
        }
      })();

      const order = await carryToShipped(m, id);
      done = true;
      await killer;
      const settled = await carryToShipped(m, id);

      if (settled.status === "shipped") {
        expect(undisturbed(settled)).toEqual(expected);
      } else {
        expect(settled.log.at(-1)?.code).toBeString();
      }
      const committed = settled.log.filter((entry) => entry.action === ACTION.sliceCommitted);
      expect(new Set(committed.map((entry) => JSON.stringify(entry.details))).size).toBe(committed.length);
      expect(order.id).toBe(id);
      m.close();
    }
  });
});

describe("command output", () => {
  test("each command prints one structured result, and each refusal carries a code, its details and the command that resolves it", async () => {
    const m = await scripted({ planner: [planTurn()] });
    const id = await addOrder(m.operator);
    for (const args of [
      ["order", "show", id],
      ["order", "approve", id, "--reason", "early", "--decided", "owner"],
      ["order", "show", "no-such-order"],
      ["order"],
      ["nonsense"],
    ]) {
      const ran = await m.operator.sh(["dim", ...args].map((arg) => `'${arg}'`).join(" "));
      const lines = `${ran.stdout}${ran.stderr}`.trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      const result = parseDim(ran);
      if (!result.ok) {
        expect(result.error?.code).toMatch(/^[a-z_]+$/);
        expect(result.error?.meta).toBeObject();
        expect((result.error as { resolve?: string } | undefined)?.resolve).toStartWith("dim ");
      }
    }
  });

  test("every command is one whole word, without a hyphen", async () => {
    const m = await scripted({});
    const listed = (await m.operator.dimOk([])) as { commands: { name: string }[] };
    for (const { name } of listed.commands) expect(name).toMatch(/^[a-z]{2,}$/);
  });
});

describe("hooks", () => {
  test("a session hook whose dim command fails or is missing still lets the session carry on", async () => {
    const m = await scripted({});
    const failing = join(m.root, "failing-bin");
    mkdirSync(failing);
    writeFileSync(join(failing, "dim"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(failing, "dim"), 0o755);
    const hooks = settingsHooks(m.env.HOME as string);
    const commands = Object.values(hooks).flatMap((entries) =>
      entries.flatMap((entry) => (entry.hooks ?? []).flatMap((hook) => (hook.command ? [hook.command] : []))),
    );
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
    const m = await scripted({}, { check: "exit 1" });
    await m.operator.dimOk(["gate", "install", "--owner", "github.com/acme"]);
    const commit = (message: string) =>
      Bun.spawnSync(["git", "commit", "-q", "--allow-empty", "-m", message], {
        cwd: m.repo,
        env: m.env,
        stderr: "pipe",
      });

    const blocked = commit("feat: blocked by the red check");
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.stderr.toString().trim().length).toBeGreaterThan(0);

    chmodSync(join(m.repo, "package.json"), 0o000);
    try {
      expect(commit("feat: through, the check is unreadable").exitCode).toBe(0);
    } finally {
      chmodSync(join(m.repo, "package.json"), 0o644);
    }
  });

  test("an edit in a station worker's session runs neither the worktree's format command nor its settings' hooks", async () => {
    const m = await scripted({
      planner: [planTurn([{ title: "One", outcome: "One file." }])],
      builder: [[...sliceActs(1), { act: "build-return", artifact: BUILD_ARTIFACT }]],
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
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);
    await approve(m.operator, id);

    const { worktree } = await showOrder(m.operator, id);
    expect(existsSync(join(worktree, "formatted.marker"))).toBe(false);
    expect(existsSync(join(worktree, "project-hook.marker"))).toBe(false);
  });

  test("a station worker, whether or not it may edit, cannot write the worktree's git data or the checkout's shared git data", async () => {
    const probe: HarnessTurn = [
      { act: "sh", command: 'touch "$(git rev-parse --git-dir)/probe-$$"' },
      { act: "sh", command: 'touch "$(git rev-parse --git-common-dir)/probe-$$"' },
    ];
    const m = await scripted({
      planner: [[...probe, ...planTurn([{ title: "One", outcome: "One file." }])]],
      builder: [[...probe, ...sliceActs(1), { act: "build-return", artifact: BUILD_ARTIFACT }]],
    });
    const id = await addOrder(m.operator);
    await runOrder(m.operator, id);
    await approve(m.operator, id);

    const { worktree } = await showOrder(m.operator, id);
    const gitDir = m.git(["rev-parse", "--absolute-git-dir"], worktree);
    const common = join(m.repo, ".git");
    const probes = (dir: string) =>
      Bun.spawnSync(["sh", "-c", `ls "${dir}" | grep -c '^probe-' || true`], { stdout: "pipe" })
        .stdout.toString()
        .trim();
    expect(probes(gitDir)).toBe("0");
    expect(probes(common)).toBe("0");
  });
});

describe("reading the record", () => {
  const db = (m: Machine) => join(m.env.DIM_HOME as string, "sessions.db");
  const sqlite = (path: string, sql: string) =>
    Bun.spawnSync(["sqlite3", path, sql], { stdout: "pipe" }).stdout.toString().trim();

  test("a write sent through a reader fails and leaves the database unchanged", async () => {
    const m = await scripted(happyPath());
    await shipThrough(m.operator, await addOrder(m.operator));
    const table = sqlite(db(m), "select name from sqlite_master where type = 'table' order by name limit 1");
    const count = sqlite(db(m), `select count(*) from "${table}"`);

    const refused = await m.operator.dim(["sql", `delete from "${table}"`]);

    expect(refused.ok).toBe(false);
    expect(sqlite(db(m), `select count(*) from "${table}"`)).toBe(count);
  });

  test("a query, dim sql and dim trace refuse a record from another version with the writer's error and leave it unchanged", async () => {
    const m = await scripted({});
    const id = await addOrder(m.operator);
    const version = Number(sqlite(db(m), "PRAGMA user_version"));
    sqlite(db(m), `PRAGMA user_version = ${version + 1}`);

    const writer = await m.operator.dim(["order", "add", "--title", "Two", "--request", "Another."]);
    expect(writer.ok).toBe(false);
    for (const args of [
      ["query", "search", "greeting"],
      ["sql", "select 1"],
      ["trace", id],
    ]) {
      const refused = await m.operator.dim(args);
      expect(refused.ok).toBe(false);
      expect(refused.error?.code).toBe(writer.error?.code as string);
    }
    expect(Number(sqlite(db(m), "PRAGMA user_version"))).toBe(version + 1);
  });
});
