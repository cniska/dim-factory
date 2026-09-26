import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildTurn } from "./build-turn";
import {
  answerOrderFinding,
  appendOrderEvent,
  approveOrderBuild,
  approveOrderPlan,
  claimOrder,
  closeOrderReview,
  completeOrderBuildFollowup,
  isActiveOrderRun,
  moveOrder,
  openOrderReview,
  queueOrder,
  raiseOrderFinding,
  recordOrderBuild,
  recordOrderCheck,
  recordOrderCommit,
  recordOrderPlan,
  returnOrderArtifact,
  shipOrder,
} from "./factory-order";
import {
  endWorker,
  mintWorker,
  WORKER_NAME_VAR,
  WORKER_SESSION_VAR,
  WORKER_TOKEN_VAR,
} from "./factory-worker";
import { fakeHarness } from "./fake-harness";
import { confiningCheckSandbox, declareCheck, integratedRepo } from "./fixtures.test-support";
import type { HarnessAdapter, HarnessEvent, HarnessRequest, HarnessRun } from "./harness";
import { runOrderBuildLive } from "./order-build";
import { SCHEMA_SQL } from "./schema";
import { repoRoot } from "./wt-command";

const repos: string[] = [];
const homes: string[] = [];
afterAll(() => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/**
 * A builder that acts on the worktree in-process and ends its turn with `act`'s answer — a
 * BuildTurn as JSON on a code turn, or free text on an artifact revision turn — then emits
 * `afterAnswer` until the runner cancels it.
 */
function builderTurn(
  act: (request: HarnessRequest) => BuildTurn | string,
  afterAnswer: HarnessEvent[] = [],
): HarnessAdapter & { cancels(): number } {
  let cancels = 0;
  const run = async (request: HarnessRequest): Promise<HarnessRun> => {
    let cancelled = false;
    return {
      pid: process.pid,
      events: (async function* (): AsyncGenerator<HarnessEvent> {
        yield { type: "run.started", providerSessionId: "fake-session" };
        yield { type: "turn.started" };
        const answer = act(request);
        yield { type: "run.completed", output: typeof answer === "string" ? answer : JSON.stringify(answer) };
        for (const event of afterAnswer) {
          if (cancelled) return;
          yield event;
        }
      })(),
      cancel() {
        cancels += 1;
        cancelled = true;
      },
    };
  };
  return { start: run, resume: (_sessionId, request) => run(request), cancels: () => cancels };
}

/** An adapter whose harness never starts, and the brief it was handed. */
function unavailableHarness(): { adapter: HarnessAdapter; brief: () => string } {
  let brief = "";
  const refuse = async (request: HarnessRequest): Promise<HarnessRun> => {
    brief = request.brief;
    throw new Error("harness unavailable");
  };
  return { adapter: { start: refuse, resume: (_sessionId, request) => refuse(request) }, brief: () => brief };
}

function git(dir: string, args: string[]): string {
  return Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" })
    .stdout.toString()
    .trim();
}

function home(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  homes.push(dir);
  writeFileSync(
    join(dir, "routing.json"),
    '{ "codex": { "light": "small", "standard": "middling", "deep": "large" } }',
  );
  return dir;
}

/** A trunk declaring a check, and an order on it with an approved plan, moved to build. */
function orderAtBuild(
  db: Database,
  orderId: string,
  slices: { title: string; outcome: string }[],
  check = "true",
): { repo: { dir: string; sha: string }; operator: ReturnType<typeof mintWorker>; planner: string } {
  const trunk = integratedRepo();
  repos.push(trunk.dir);
  const repo = { dir: trunk.dir, sha: declareCheck(trunk.dir, check) };
  const operator = mintWorker(db, { role: "operator", sessionId: `${orderId}-operator` });
  queueOrder(db, { id: orderId, project: "cniska/dim-factory", title: "Build this" }, operator.name);
  claimOrder(
    db,
    orderId,
    { runId: "plan-run", station: "dim-station-plan", operatorWorker: operator.name },
    operator.name,
    undefined,
    repo.dir,
  );
  const planner = mintWorker(db, {
    role: "planner",
    parentWorker: operator.name,
    sessionId: `${orderId}/planner`,
  });
  recordOrderPlan(db, orderId, "## Outcome\n\nBuild the requested result.", planner.name, slices);
  approveOrderPlan(db, orderId, operator.name);
  moveOrder(db, orderId, "dim-station-build", operator.name);
  return { repo, operator, planner: planner.name };
}

function database(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  return db;
}

describe("builder station", () => {
  test("starts an attributed builder in the operator-allocated worktree", async () => {
    const db = database();
    const dimHome = home("dim-builder-");
    const { repo, operator, planner } = orderAtBuild(db, "builder-order", [
      { title: "Build the result", outcome: "The requested result is verified." },
    ]);
    const env = {
      DIM_HOME: dimHome,
      [WORKER_NAME_VAR]: operator.name,
      [WORKER_TOKEN_VAR]: operator.token,
      [WORKER_SESSION_VAR]: operator.sessionId,
    };

    let request: HarnessRequest | undefined;
    const outcome = await runOrderBuildLive(db, "builder-order", operator.name, {
      dir: repo.dir,
      env,
      checkSandbox: confiningCheckSandbox(),
      adapter: builderTurn((given) => {
        request = given;
        writeFileSync(join(given.cwd, "built.txt"), "built\n");
        return { subject: "feat: build it", artifact: "The requested result is built and verified." };
      }),
    });

    expect(request?.cwd).toBe(realpathSync(join(repo.dir, ".claude", "worktrees", "builder-order")));
    expect(request?.brief).toContain("The operator approved the following plan");
    expect(request?.brief).toContain("Build the requested result.");
    expect(request?.brief).toContain(
      `The record holds 0 commits from ${repoRoot(repo.dir)}, fewer than the 20 it takes to read a convention from`,
    );
    expect(request?.outputSchema).toEndWith("build-turn.schema.json");
    expect(outcome.worktree).toBe(request?.cwd ?? "");
    expect(
      db
        .query("SELECT role, parent_worker, ended_at FROM factory_worker WHERE name = ?")
        .get(outcome.builder),
    ).toEqual({ role: "builder", parent_worker: operator.name, ended_at: expect.any(String) });
    expect(
      db
        .query("SELECT kind, worker, station FROM factory_order_event WHERE order_id = ?")
        .all("builder-order"),
    ).toEqual([
      { kind: "queued", worker: operator.name, station: null },
      { kind: "claimed", worker: operator.name, station: "dim-station-plan" },
      { kind: "plan_artifact_written", worker: planner, station: null },
      { kind: "hold_set", worker: planner, station: null },
      { kind: "owner_verdict_recorded", worker: operator.name, station: null },
      { kind: "plan_approved", worker: operator.name, station: null },
      { kind: "hold_released", worker: operator.name, station: null },
      { kind: "moved", worker: operator.name, station: "dim-station-build" },
      { kind: "claimed", worker: outcome.builder, station: "dim-station-build" },
      { kind: "commit_created", worker: outcome.builder, station: null },
      { kind: "check_finished", worker: operator.name, station: null },
      { kind: "build_artifact_written", worker: outcome.builder, station: null },
      { kind: "hold_set", worker: outcome.builder, station: null },
    ]);

    const head = git(outcome.worktree, ["rev-parse", "HEAD"]);
    expect(git(outcome.worktree, ["rev-parse", "HEAD~1"])).toBe(repo.sha);
    expect(git(outcome.worktree, ["status", "--porcelain"])).toBe("");
    expect(git(outcome.worktree, ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%s"])).toBe(
      "Test <t@example.com>|Test <t@example.com>|feat: build it",
    );
    expect(
      Bun.spawnSync(["git", "-C", outcome.worktree, "verify-commit", head], {
        stdout: "pipe",
        stderr: "pipe",
      }).success,
    ).toBe(true);
    expect(db.query("SELECT sha, subject FROM factory_order_commit").all()).toEqual([
      { sha: head, subject: "feat: build it" },
    ]);
    expect(db.query("SELECT worker, path, added, removed FROM factory_order_file").all()).toEqual([
      { worker: outcome.builder, path: "built.txt", added: 1, removed: 0 },
    ]);
    expect(db.query("SELECT command, exit_code FROM factory_order_check").all()).toEqual([
      { command: "bun run verify", exit_code: 0 },
    ]);
    expect(db.query("SELECT body, head_sha, worker FROM factory_order_build").all()).toEqual([
      { body: "The requested result is built and verified.", head_sha: head, worker: outcome.builder },
    ]);
    expect(db.query("SELECT worker FROM factory_order_slice_completion").get()).toEqual({
      worker: outcome.builder,
    });
    expect(isActiveOrderRun(db, "builder-order", outcome.runId)).toBe(false);

    returnOrderArtifact(db, "builder-order", operator.name, "Explain what the build verified.");
    const unavailable = unavailableHarness();
    await expect(
      runOrderBuildLive(db, "builder-order", operator.name, {
        dir: repo.dir,
        env,
        adapter: unavailable.adapter,
      }),
    ).rejects.toThrow("harness unavailable");
    expect(unavailable.brief()).toContain("The owner returned the Build artifact to you.");
    expect(unavailable.brief()).toContain("Explain what the build verified.");
    await expect(
      runOrderBuildLive(db, "builder-order", operator.name, {
        dir: repo.dir,
        env,
        adapter: fakeHarness("crash"),
      }),
    ).rejects.toThrow("fake process crashed");
    expect(db.query("SELECT status, hold FROM factory_order WHERE id = ?").get("builder-order")).toEqual({
      status: "working",
      hold: null,
    });
    expect(
      db
        .query("SELECT kind FROM factory_order_event WHERE order_id = ? ORDER BY id DESC LIMIT 1")
        .get("builder-order"),
    ).toEqual({ kind: "hold_released" });
    db.close();
  });

  test("tells the builder the convention its repository's recorded log shows", async () => {
    const db = database();
    const dimHome = home("dim-builder-convention-");
    const { repo, operator } = orderAtBuild(db, "convention-order", [
      { title: "Build the result", outcome: "The requested result is verified." },
    ]);
    const root = repoRoot(repo.dir);
    for (let i = 0; i < 20; i++) {
      db.run(
        "INSERT INTO repo_commit (sha, repo, label, ts, author, subject, kind) VALUES (?, ?, NULL, '2026-01-01T00:00:00Z', 'a', ?, ?)",
        [
          `c${i}`,
          `${root}/.claude/worktrees/earlier`,
          i < 15 ? "fix: a short subject" : "a plain one",
          i < 15 ? "fix" : null,
        ],
      );
    }
    let brief = "";

    await runOrderBuildLive(db, "convention-order", operator.name, {
      dir: repo.dir,
      env: { DIM_HOME: dimHome },
      checkSandbox: confiningCheckSandbox(),
      adapter: builderTurn((request) => {
        brief = request.brief;
        writeFileSync(join(request.cwd, "built.txt"), "built\n");
        return { subject: "feat: build it", artifact: "Built." };
      }),
    });

    expect(brief).toContain("# Commit convention");
    expect(brief).toContain(
      `The record holds 20 commits from ${root}. 75% of their subjects carry a Conventional Commits type, most often fix; subjects average 18 characters and 0% run over 50.`,
    );
    db.close();
  });

  test("records a red check under the runner, commits nothing, and hands the output to the next turn", async () => {
    const db = database();
    const dimHome = home("dim-builder-red-");
    const { repo, operator } = orderAtBuild(
      db,
      "red-order",
      [
        { title: "First slice", outcome: "The first slice is verified." },
        { title: "Second slice", outcome: "The second slice is verified." },
      ],
      'test -f ok.txt || { echo "ok.txt is missing"; exit 1; }',
    );
    const options = { dir: repo.dir, env: { DIM_HOME: dimHome }, checkSandbox: confiningCheckSandbox() };

    await expect(
      runOrderBuildLive(db, "red-order", operator.name, {
        ...options,
        adapter: builderTurn((request) => {
          writeFileSync(join(request.cwd, "partial.txt"), "partial\n");
          return { subject: "feat: first slice", artifact: "" };
        }),
      }),
    ).rejects.toThrow("ok.txt is missing");
    const worktree = realpathSync(join(repo.dir, ".claude", "worktrees", "red-order"));
    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(repo.sha);
    expect(db.query("SELECT count(*) AS n FROM factory_order_commit").get()).toEqual({ n: 0 });
    expect(
      db
        .query(
          `SELECT c.exit_code, c.result LIKE '%ok.txt is missing%' AS carries_output, e.worker
           FROM factory_order_check c JOIN factory_order_event e ON e.check_id = c.id`,
        )
        .all(),
    ).toEqual([{ exit_code: 1, carries_output: 1, worker: operator.name }]);

    let retryBrief = "";
    const retry = await runOrderBuildLive(db, "red-order", operator.name, {
      ...options,
      adapter: builderTurn((request) => {
        retryBrief = request.brief;
        writeFileSync(join(request.cwd, "ok.txt"), "ok\n");
        return { subject: "feat: first slice", artifact: "" };
      }),
    });
    expect(retryBrief).toContain("# Previous failed Build attempt");
    expect(retryBrief).toContain("ok.txt is missing");
    expect(git(worktree, ["show", "--name-only", "--format=", "HEAD"]).split("\n").sort()).toEqual([
      "ok.txt",
      "partial.txt",
    ]);
    expect(git(worktree, ["log", "-1", "--format=%an"])).toBe("Test");
    expect(db.query("SELECT worker FROM factory_order_event WHERE kind = 'commit_created'").get()).toEqual({
      worker: retry.builder,
    });

    await expect(
      runOrderBuildLive(db, "red-order", operator.name, {
        ...options,
        adapter: builderTurn((request) => {
          writeFileSync(join(request.cwd, "second.txt"), "second\n");
          git(request.cwd, ["add", "second.txt"]);
          git(request.cwd, ["commit", "-q", "-m", "feat: second slice"]);
          return { subject: "feat: second slice", artifact: "Both slices are built." };
        }),
      }),
    ).rejects.toThrow("the runner commits a turn, so leave changes uncommitted");
    expect(db.query("SELECT count(*) AS n FROM factory_order_commit").get()).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) AS n FROM factory_order_slice_completion").get()).toEqual({ n: 1 });
    db.close();
  });

  test("refuses a turn whose check changed the tree it was checking", async () => {
    const db = database();
    const dimHome = home("dim-builder-drift-");
    const { repo, operator } = orderAtBuild(
      db,
      "drift-order",
      [{ title: "Build the result", outcome: "The requested result is verified." }],
      "echo planted > planted.txt",
    );

    await expect(
      runOrderBuildLive(db, "drift-order", operator.name, {
        dir: repo.dir,
        env: { DIM_HOME: dimHome },
        checkSandbox: confiningCheckSandbox(),
        adapter: builderTurn((request) => {
          writeFileSync(join(request.cwd, "built.txt"), "built\n");
          return { subject: "feat: build it", artifact: "Built." };
        }),
      }),
    ).rejects.toThrow("the check changed the worktree");
    const worktree = realpathSync(join(repo.dir, ".claude", "worktrees", "drift-order"));
    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(repo.sha);
    expect(db.query("SELECT count(*) AS n FROM factory_order_commit").get()).toEqual({ n: 0 });
    db.close();
  });

  test("refuses a turn that left a repository nested in the worktree, before any git runs in it", async () => {
    const db = database();
    const dimHome = home("dim-builder-nested-");
    const { repo, operator } = orderAtBuild(db, "nested-order", [
      { title: "Build the result", outcome: "The requested result is verified." },
    ]);
    const fired = join(dimHome, "fired");

    await expect(
      runOrderBuildLive(db, "nested-order", operator.name, {
        dir: repo.dir,
        env: { DIM_HOME: dimHome },
        checkSandbox: confiningCheckSandbox(),
        adapter: builderTurn((request) => {
          const nested = join(request.cwd, "vendor", "planted");
          mkdirSync(nested, { recursive: true });
          git(nested, ["init", "-q"]);
          git(nested, [
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@e",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "x",
          ]);
          git(nested, ["config", "core.fsmonitor", `touch ${fired}`]);
          return { subject: "feat: build it", artifact: "Built." };
        }),
      }),
    ).rejects.toThrow("vendor/planted");
    expect(existsSync(fired)).toBe(false);
    expect(db.query("SELECT count(*) AS n FROM factory_order_commit").get()).toEqual({ n: 0 });
    db.close();
  });

  test("refuses a turn that left HEAD off the order's branch", async () => {
    const db = database();
    const dimHome = home("dim-builder-detached-");
    const { repo, operator } = orderAtBuild(db, "detached-order", [
      { title: "Build the result", outcome: "The requested result is verified." },
    ]);

    await expect(
      runOrderBuildLive(db, "detached-order", operator.name, {
        dir: repo.dir,
        env: { DIM_HOME: dimHome },
        checkSandbox: confiningCheckSandbox(),
        adapter: builderTurn((request) => {
          git(request.cwd, ["checkout", "-q", "--detach"]);
          writeFileSync(join(request.cwd, "built.txt"), "built\n");
          return { subject: "feat: build it", artifact: "Built." };
        }),
      }),
    ).rejects.toThrow("detached-order");
    expect(db.query("SELECT count(*) AS n FROM factory_order_commit").get()).toEqual({ n: 0 });
    db.close();
  });

  test("runs a hook the repository keeps in its tree from the trunk's copy, not the builder's", async () => {
    const db = database();
    const dimHome = home("dim-builder-hooks-");
    const { repo, operator } = orderAtBuild(db, "hooks-order", [
      { title: "Build the result", outcome: "The requested result is verified." },
    ]);
    const marker = join(dimHome, "hook-ran");
    mkdirSync(join(repo.dir, ".husky"));
    writeFileSync(join(repo.dir, ".husky", "commit-msg"), `#!/bin/sh\necho trunk > ${marker}\n`, {
      mode: 0o755,
    });
    git(repo.dir, ["add", ".husky"]);
    git(repo.dir, ["commit", "-q", "-m", "chore: add the project's hook"]);
    git(repo.dir, ["config", "core.hooksPath", ".husky"]);
    git(join(repo.dir, ".claude", "worktrees", "hooks-order"), ["merge", "-q", "--ff-only", "main"]);

    await runOrderBuildLive(db, "hooks-order", operator.name, {
      dir: repo.dir,
      env: { DIM_HOME: dimHome },
      checkSandbox: confiningCheckSandbox(),
      adapter: builderTurn((request) => {
        writeFileSync(join(request.cwd, ".husky", "commit-msg"), `#!/bin/sh\necho builder > ${marker}\n`, {
          mode: 0o755,
        });
        writeFileSync(join(request.cwd, "built.txt"), "built\n");
        return { subject: "feat: build it", artifact: "Built." };
      }),
    });

    expect(readFileSync(marker, "utf8").trim()).toBe("trunk");
    db.close();
  });

  test("records a renamed file by its plain paths", async () => {
    const db = database();
    const dimHome = home("dim-builder-rename-");
    const { repo, operator } = orderAtBuild(db, "rename-order", [
      { title: "Build the result", outcome: "The requested result is verified." },
    ]);
    writeFileSync(join(repo.dir, "old.txt"), "content that stays the same\n");
    git(repo.dir, ["add", "old.txt"]);
    git(repo.dir, ["commit", "-q", "-m", "chore: add old.txt"]);
    git(join(repo.dir, ".claude", "worktrees", "rename-order"), ["merge", "-q", "--ff-only", "main"]);

    await runOrderBuildLive(db, "rename-order", operator.name, {
      dir: repo.dir,
      env: { DIM_HOME: dimHome },
      checkSandbox: confiningCheckSandbox(),
      adapter: builderTurn((request) => {
        renameSync(join(request.cwd, "old.txt"), join(request.cwd, "né.txt"));
        return { subject: "refactor: rename it", artifact: "Renamed." };
      }),
    });

    expect(
      db
        .query<{ path: string }, []>("SELECT path FROM factory_order_file ORDER BY path")
        .all()
        .map((row) => row.path),
    ).toEqual(["né.txt", "old.txt"]);
    db.close();
  });

  test("refuses a commit subject that carries more than one line", async () => {
    const db = database();
    const dimHome = home("dim-builder-subject-");
    const { repo, operator } = orderAtBuild(db, "subject-order", [
      { title: "Build the result", outcome: "The requested result is verified." },
    ]);

    await expect(
      runOrderBuildLive(db, "subject-order", operator.name, {
        dir: repo.dir,
        env: { DIM_HOME: dimHome },
        checkSandbox: confiningCheckSandbox(),
        adapter: builderTurn((request) => {
          writeFileSync(join(request.cwd, "built.txt"), "built\n");
          return { subject: "feat: build it\n\nCo-authored-by: someone <x@y>", artifact: "Built." };
        }),
      }),
    ).rejects.toThrow("one line");
    expect(db.query("SELECT count(*) AS n FROM factory_order_commit").get()).toEqual({ n: 0 });
    db.close();
  });

  test("refuses a first turn whose builder committed on its own", async () => {
    const db = database();
    const dimHome = home("dim-builder-first-");
    const { repo, operator } = orderAtBuild(db, "first-order", [
      { title: "Build the result", outcome: "The requested result is verified." },
    ]);

    await expect(
      runOrderBuildLive(db, "first-order", operator.name, {
        dir: repo.dir,
        env: { DIM_HOME: dimHome },
        checkSandbox: confiningCheckSandbox(),
        adapter: builderTurn((request) => {
          writeFileSync(join(request.cwd, "built.txt"), "built\n");
          git(request.cwd, ["add", "built.txt"]);
          git(request.cwd, ["commit", "-q", "-m", "feat: build it"]);
          return { subject: "feat: build it", artifact: "Built." };
        }),
      }),
    ).rejects.toThrow("leave changes uncommitted");
    expect(db.query("SELECT count(*) AS n FROM factory_order_commit").get()).toEqual({ n: 0 });
    db.close();
  });

  test("keeps an incomplete final slice while giving the builder returned artifact feedback", async () => {
    const db = database();
    const dimHome = home("dim-builder-return-");
    const { repo, operator } = orderAtBuild(db, "returned-builder-order", [
      { title: "Finish the result", outcome: "The result is verified." },
    ]);
    const options = { dir: repo.dir, env: { DIM_HOME: dimHome }, checkSandbox: confiningCheckSandbox() };
    const builder = mintWorker(db, {
      role: "builder",
      parentWorker: operator.name,
      sessionId: "return-operator/builder",
    });
    claimOrder(
      db,
      "returned-builder-order",
      { runId: "build-run", station: "dim-station-build", operatorWorker: operator.name },
      builder.name,
      undefined,
      repo.dir,
    );
    recordOrderCommit(db, "returned-builder-order", repo.sha, builder.name, "feat: build it");
    recordOrderCheck(
      db,
      "returned-builder-order",
      { command: "bun run verify", exitCode: 0, result: "green" },
      operator.name,
    );
    recordOrderBuild(db, "returned-builder-order", "The initial Build artifact.", repo.sha, builder.name);
    appendOrderEvent(db, "returned-builder-order", {
      kind: "failed",
      worker: builder.name,
      reason: "Artifact needs revision.",
    });
    returnOrderArtifact(
      db,
      "returned-builder-order",
      operator.name,
      "Explain the verification for the owner.",
    );

    const unavailable = unavailableHarness();
    await expect(
      runOrderBuildLive(db, "returned-builder-order", operator.name, {
        ...options,
        adapter: unavailable.adapter,
      }),
    ).rejects.toThrow("harness unavailable");
    const brief = unavailable.brief();
    expect(brief).toContain("# Current slice");
    expect(brief).toContain("Finish the result: The result is verified.");
    expect(brief).toContain("# Returned Build artifact");
    expect(brief).toContain("The initial Build artifact.");
    expect(brief).toContain("# Owner feedback");
    expect(brief).toContain("Explain the verification for the owner.");
    expect(brief).not.toContain("The code work is complete; revise only the artifact.");
    expect(db.query("SELECT count(*) AS n FROM factory_order_slice_completion").get()).toEqual({ n: 0 });

    // A turn that changes nothing on top of the recorded commit is committed as nothing, and its
    // check and artifact are recorded against that same commit.
    const outcome = await runOrderBuildLive(db, "returned-builder-order", operator.name, {
      ...options,
      adapter: builderTurn(() => ({
        subject: "feat: build it",
        artifact: "The revised Build artifact explains the verification.",
      })),
    });
    expect(db.query("SELECT count(*) AS n FROM factory_order_commit").get()).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) AS n FROM factory_order_slice_completion").get()).toEqual({ n: 1 });
    expect(db.query("SELECT worker FROM factory_order_slice_completion").get()).toEqual({
      worker: outcome.builder,
    });
    expect(
      db.query("SELECT revision, head_sha FROM factory_order_build ORDER BY revision DESC LIMIT 1").get(),
    ).toEqual({ revision: 2, head_sha: repo.sha });

    returnOrderArtifact(db, "returned-builder-order", operator.name, "Match the actual worktree HEAD.");
    const laterCommit = Bun.spawnSync(
      ["git", "-C", outcome.worktree, "commit", "--allow-empty", "-m", "fix: unrecorded head"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(laterCommit.success).toBe(true);
    const later = git(outcome.worktree, ["rev-parse", "HEAD"]);
    await expect(
      runOrderBuildLive(db, "returned-builder-order", operator.name, {
        ...options,
        adapter: builderTurn(() => {
          recordOrderBuild(
            db,
            "returned-builder-order",
            "Revision still points to the old head.",
            repo.sha,
            outcome.builder,
          );
          return "revised";
        }),
      }),
    ).rejects.toThrow("builder did not record worktree HEAD");

    returnOrderArtifact(db, "returned-builder-order", operator.name, "Record the check after that head.");
    await expect(
      runOrderBuildLive(db, "returned-builder-order", operator.name, {
        ...options,
        adapter: builderTurn(() => {
          recordOrderCommit(db, "returned-builder-order", later, outcome.builder, "fix: unrecorded head");
          recordOrderCheck(
            db,
            "returned-builder-order",
            { command: "bun run verify", exitCode: 0, result: "green" },
            outcome.builder,
          );
          recordOrderBuild(
            db,
            "returned-builder-order",
            "Revision on the later head.",
            later,
            outcome.builder,
          );
          return "revised";
        }),
      }),
    ).rejects.toThrow("the runner did not record a passing check after the latest commit");

    returnOrderArtifact(db, "returned-builder-order", operator.name, "Record an immutable commit ID.");
    recordOrderCommit(db, "returned-builder-order", "HEAD", outcome.builder, "fix: symbolic head");
    recordOrderCheck(db, "returned-builder-order", { command: "bun run verify", exitCode: 0 }, operator.name);
    await expect(
      runOrderBuildLive(db, "returned-builder-order", operator.name, {
        ...options,
        adapter: builderTurn(() => {
          recordOrderBuild(
            db,
            "returned-builder-order",
            "Revision names a moving ref.",
            "HEAD",
            outcome.builder,
          );
          return "revised";
        }),
      }),
    ).rejects.toThrow("builder did not record an immutable commit ID");
    db.close();
  });

  test("returns answered review findings to the same builder for a new Build artifact", async () => {
    const db = database();
    const dimHome = home("dim-builder-review-rework-");
    const { repo, operator } = orderAtBuild(db, "review-rework-order", [
      { title: "Build the result", outcome: "The result is verified." },
    ]);
    const options = { dir: repo.dir, env: { DIM_HOME: dimHome }, checkSandbox: confiningCheckSandbox() };

    const firstBuild = await runOrderBuildLive(db, "review-rework-order", operator.name, {
      ...options,
      adapter: builderTurn((request) => {
        writeFileSync(join(request.cwd, "first.txt"), "first\n");
        return { subject: "feat: build it", artifact: "Initial Build artifact." };
      }),
    });
    const first = git(firstBuild.worktree, ["rev-parse", "HEAD"]);
    approveOrderBuild(db, "review-rework-order", operator.name, "Build approved.");
    moveOrder(db, "review-rework-order", "dim-station-review", operator.name);
    const reviewer = mintWorker(db, {
      role: "reviewer",
      parentWorker: operator.name,
      sessionId: "review-rework-reviewer",
    });
    const review = openOrderReview(
      db,
      "review-rework-order",
      { reviewer: reviewer.name, baseSha: repo.sha, headSha: first },
      reviewer.name,
    );
    const finding = raiseOrderFinding(
      db,
      "review-rework-order",
      { dimension: "correctness", summary: "Count the actual order provenance." },
      reviewer.name,
    );
    closeOrderReview(db, review.id, "closed", reviewer.name);
    answerOrderFinding(db, finding, { answer: "fixed" }, operator.name);
    moveOrder(db, "review-rework-order", "dim-station-build", operator.name);

    let brief = "";
    const followup = await runOrderBuildLive(db, "review-rework-order", operator.name, {
      ...options,
      adapter: builderTurn((request) => {
        brief = request.brief;
        writeFileSync(join(request.cwd, "fix.txt"), "fix\n");
        expect(() => completeOrderBuildFollowup(db, "review-rework-order", firstBuild.builder)).toThrow(
          "no Build artifact after its latest Review",
        );
        return { subject: "fix: review finding", artifact: "Revised Build artifact." };
      }),
    });
    const head = git(followup.worktree, ["rev-parse", "HEAD"]);
    expect(head).not.toBe(first);
    expect(brief).toContain("Count the actual order provenance.");
    expect(brief).toContain("Review findings");
    expect(followup.builder).toBe(firstBuild.builder);
    expect(db.query("SELECT run_id FROM factory_order WHERE id = ?").get("review-rework-order")).toEqual({
      run_id: null,
    });
    expect(
      db.query("SELECT revision, head_sha FROM factory_order_build ORDER BY revision DESC LIMIT 1").get(),
    ).toEqual({ revision: 2, head_sha: head });
    db.close();
  });

  test("claims once and commits the answer when the builder begins another turn after answering", async () => {
    const db = database();
    const dimHome = home("dim-builder-second-turn-");
    const { repo, operator } = orderAtBuild(db, "second-turn-order", [
      { title: "Build the result", outcome: "The requested result is verified." },
    ]);
    const adapter = builderTurn(
      (request) => {
        writeFileSync(join(request.cwd, "built.txt"), "built\n");
        return { subject: "feat: build it", artifact: "Built." };
      },
      [{ type: "run.started", providerSessionId: "fake-session" }, { type: "turn.started" }],
    );

    const outcome = await runOrderBuildLive(db, "second-turn-order", operator.name, {
      dir: repo.dir,
      env: { DIM_HOME: dimHome },
      checkSandbox: confiningCheckSandbox(),
      adapter,
    });

    const events = db
      .query<{ kind: string; worker: string | null }, [string]>(
        "SELECT kind, worker FROM factory_order_event WHERE order_id = ? AND kind IN ('claimed', 'failed')",
      )
      .all("second-turn-order");
    expect(events).toEqual([
      { kind: "claimed", worker: operator.name },
      { kind: "claimed", worker: outcome.builder },
    ]);
    expect(adapter.cancels()).toBe(1);
    expect(db.query("SELECT subject FROM factory_order_commit").all()).toEqual([
      { subject: "feat: build it" },
    ]);
    db.close();
  });

  test("fails a builder run that starts twice as a harness fault, not a second claim", async () => {
    const db = database();
    const dimHome = home("dim-builder-second-start-");
    const { repo, operator } = orderAtBuild(db, "second-start-order", [
      { title: "Build the result", outcome: "The requested result is verified." },
    ]);

    await expect(
      runOrderBuildLive(db, "second-start-order", operator.name, {
        dir: repo.dir,
        env: { DIM_HOME: dimHome },
        adapter: fakeHarness("second-start"),
      }),
    ).rejects.toThrow("harness fault: the worker started a second run before answering");

    expect(
      db
        .query("SELECT kind FROM factory_order_event WHERE order_id = ? AND kind = 'claimed'")
        .all("second-start-order"),
    ).toHaveLength(2);
    db.close();
  });

  test("records a failed build when the configured harness cannot start", async () => {
    const db = database();
    const dimHome = home("dim-builder-failure-");
    const { repo, operator } = orderAtBuild(db, "failed-builder-order", [
      { title: "Try the build", outcome: "The build result is verified." },
    ]);

    await expect(
      runOrderBuildLive(db, "failed-builder-order", operator.name, {
        dir: repo.dir,
        env: { DIM_HOME: dimHome },
        adapter: unavailableHarness().adapter,
      }),
    ).rejects.toThrow("harness unavailable");

    expect(
      db
        .query("SELECT kind, worker, reason FROM factory_order_event WHERE order_id = ?")
        .all("failed-builder-order"),
    ).toContainEqual({ kind: "failed", worker: null, reason: "harness unavailable" });
    expect(
      db.query("SELECT status, run_id FROM factory_order WHERE id = ?").get("failed-builder-order"),
    ).toEqual({
      status: "queued",
      run_id: null,
    });
    db.close();
  });

  test("keeps the same builder identity after a failed build turn", async () => {
    const db = database();
    const dimHome = home("dim-builder-resume-");
    const { repo, operator } = orderAtBuild(db, "builder-resume-order", [
      { title: "Build the result", outcome: "The requested result is verified." },
    ]);
    const nextOperator = mintWorker(db, { role: "operator", sessionId: "builder-resume-operator-2" });
    const laterOperator = mintWorker(db, { role: "operator", sessionId: "builder-resume-operator-3" });

    const base = fakeHarness("crash");
    let starts = 0;
    let resumes = 0;
    const adapter = {
      ...base,
      start: async (request: Parameters<typeof base.start>[0]) => {
        starts += 1;
        return base.start(request);
      },
      resume: async (sessionId: string, request: Parameters<typeof base.start>[0]) => {
        resumes += 1;
        expect(sessionId).toBe("fake-session");
        expect(request.brief).toContain("# Previous failed Build attempt");
        expect(request.brief).toContain("fake process crashed");
        return base.resume(sessionId, request);
      },
    };
    const env = (worker: ReturnType<typeof mintWorker>) => ({
      DIM_HOME: dimHome,
      [WORKER_NAME_VAR]: worker.name,
      [WORKER_TOKEN_VAR]: worker.token,
      [WORKER_SESSION_VAR]: worker.sessionId,
    });

    await expect(
      runOrderBuildLive(db, "builder-resume-order", operator.name, {
        dir: repo.dir,
        env: env(operator),
        adapter: fakeHarness("bootstrap-failure"),
      }),
    ).rejects.toThrow("worker bootstrap failed");
    expect(db.query("SELECT count(*) AS n FROM factory_worker WHERE role = 'builder'").get()).toEqual({
      n: 0,
    });
    endWorker(db, operator.name);
    await expect(
      runOrderBuildLive(db, "builder-resume-order", nextOperator.name, {
        dir: repo.dir,
        env: env(nextOperator),
        adapter,
      }),
    ).rejects.toThrow("fake process crashed");
    await expect(
      runOrderBuildLive(db, "builder-resume-order", laterOperator.name, {
        dir: repo.dir,
        env: env(laterOperator),
        adapter,
      }),
    ).rejects.toThrow("fake process crashed");

    expect(starts).toBe(1);
    expect(resumes).toBe(1);
    expect(db.query("SELECT count(*) AS n FROM factory_worker WHERE role = 'builder'").get()).toEqual({
      n: 1,
    });
    expect(db.query("SELECT count(*) AS n FROM factory_order_worker").get()).toEqual({ n: 1 });
    expect(
      db
        .query(
          "SELECT kind, operator_worker FROM factory_order_attempt WHERE kind = 'started' AND station = 'dim-station-build' ORDER BY rowid",
        )
        .all(),
    ).toEqual([
      { kind: "started", operator_worker: nextOperator.name },
      { kind: "started", operator_worker: laterOperator.name },
    ]);
    expect(
      db
        .query(
          `SELECT count(*) AS n FROM factory_order_attempt
           WHERE kind = 'started' AND station = 'dim-station-build'
             AND session_id IS NOT NULL AND provider_session_id IS NOT NULL
             AND harness IS NOT NULL AND model IS NOT NULL AND tier IS NOT NULL
             AND started_at IS NOT NULL`,
        )
        .get(),
    ).toEqual({ n: 2 });
    expect(
      db
        .query(
          `SELECT parent_worker FROM factory_worker WHERE name = (
            SELECT worker FROM factory_order_worker WHERE order_id = ? AND role = 'builder'
          )`,
        )
        .get("builder-resume-order"),
    ).toEqual({ parent_worker: operator.name });
    db.close();
  });

  test("refuses a builder's next turn under another harness without failing the order", async () => {
    const db = database();
    const dimHome = home("dim-builder-harness-");
    writeFileSync(
      join(dimHome, "routing.json"),
      '{ "codex": { "light": "a", "standard": "b", "deep": "c" }, "claude": { "light": "a", "standard": "b", "deep": "c" } }',
    );
    const { repo, operator } = orderAtBuild(db, "harness-order", [
      { title: "Build it", outcome: "It is verified." },
    ]);
    const env = {
      DIM_HOME: dimHome,
      [WORKER_NAME_VAR]: operator.name,
      [WORKER_TOKEN_VAR]: operator.token,
      [WORKER_SESSION_VAR]: operator.sessionId,
    };
    const failures = () =>
      db
        .query("SELECT count(*) AS n FROM factory_order_event WHERE order_id = ? AND kind = 'failed'")
        .get("harness-order");

    await expect(
      runOrderBuildLive(db, "harness-order", operator.name, {
        dir: repo.dir,
        env,
        harness: "claude",
        adapter: fakeHarness("crash"),
      }),
    ).rejects.toThrow("fake process crashed");
    expect(failures()).toEqual({ n: 1 });
    // The fake reports no exit code, so the record must not claim one.
    expect(
      db
        .query<{ reason: string }, [string]>(
          "SELECT reason FROM factory_order_event WHERE order_id = ? AND kind = 'failed'",
        )
        .get("harness-order")?.reason,
    ).toMatch(/ did not finish: fake process crashed/);
    claimOrder(
      db,
      "harness-order",
      { runId: "retake-run", station: "dim-station-build", operatorWorker: operator.name },
      operator.name,
      undefined,
      repo.dir,
    );
    moveOrder(db, "harness-order", "dim-station-build", operator.name);
    const working = () =>
      db.query("SELECT status, run_id FROM factory_order WHERE id = ?").get("harness-order");
    expect(working()).toEqual({ status: "working", run_id: null });

    await expect(
      runOrderBuildLive(db, "harness-order", operator.name, { dir: repo.dir, env, harness: "codex" }),
    ).rejects.toThrow(
      "order harness-order builder runs under the claude harness; delegate it with --harness claude",
    );
    expect(failures()).toEqual({ n: 1 });
    expect(working()).toEqual({ status: "working", run_id: null });
    db.close();
  });
});

type BuilderCall = { kind: "start" | "resume"; sessionId?: string; brief: string };

/** A builder answering its turns in order, where an Error is a run that fails, and the turns it was given. */
function scriptedBuilder(answers: ((request: HarnessRequest) => BuildTurn | string | Error)[]): {
  adapter: HarnessAdapter;
  calls: BuilderCall[];
} {
  const calls: BuilderCall[] = [];
  const run = async (request: HarnessRequest, call: BuilderCall): Promise<HarnessRun> => {
    calls.push(call);
    const answer = answers[calls.length - 1]?.(request) ?? new Error("no turn scripted");
    return {
      pid: process.pid,
      events: (async function* (): AsyncGenerator<HarnessEvent> {
        yield { type: "run.started", providerSessionId: "fake-session" };
        yield { type: "turn.started" };
        if (answer instanceof Error) yield { type: "run.failed", reason: answer.message };
        else
          yield {
            type: "run.completed",
            output: typeof answer === "string" ? answer : JSON.stringify(answer),
          };
      })(),
      cancel() {},
    };
  };
  return {
    adapter: {
      start: (request) => run(request, { kind: "start", brief: request.brief }),
      resume: (sessionId, request) => run(request, { kind: "resume", sessionId, brief: request.brief }),
    },
    calls,
  };
}

/** A `commit-msg` hook in the repository's own hooks directory refusing a subject over `limit` characters. */
function refuseLongSubjects(dir: string, limit: number): void {
  const hooks = git(dir, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
  mkdirSync(hooks, { recursive: true });
  writeFileSync(
    join(hooks, "commit-msg"),
    [
      "#!/bin/sh",
      'subject=$(head -n 1 "$1")',
      `if [ \${#subject} -gt ${limit} ]; then`,
      `  echo "subject is \${#subject} characters, over the ${limit} allowed" >&2`,
      "  exit 1",
      "fi",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

describe("a commit git refuses", () => {
  const tooLong = { subject: "feat: build the whole requested result", artifact: "Built." };
  const corrected = { subject: "feat: build it", artifact: "Built." };

  function refusingOrder(
    orderId: string,
    db = database(),
    check = (checks: string) => `echo ran >> ${checks}`,
  ) {
    const dimHome = home(`dim-builder-${orderId}-`);
    const checks = join(dimHome, "checks");
    const { repo, operator } = orderAtBuild(
      db,
      orderId,
      [{ title: "Build the result", outcome: "The requested result is verified." }],
      check(checks),
    );
    refuseLongSubjects(repo.dir, 20);
    const worktree = realpathSync(join(repo.dir, ".claude", "worktrees", orderId));
    return {
      db,
      dimHome,
      repo,
      operator,
      worktree,
      options: { dir: repo.dir, env: { DIM_HOME: dimHome }, checkSandbox: confiningCheckSandbox() },
      checksRun: () =>
        existsSync(checks) ? readFileSync(checks, "utf8").split("\n").filter(Boolean).length : 0,
      events: (kind: string) =>
        db
          .query<{ worker: string | null; reason: string | null }, [string, string]>(
            "SELECT worker, reason FROM factory_order_event WHERE order_id = ? AND kind = ?",
          )
          .all(orderId, kind),
    };
  }

  const build = (request: HarnessRequest) => writeFileSync(join(request.cwd, "built.txt"), "built\n");

  test("resumes the same builder with git's refusal and commits its corrected subject in the same attempt", async () => {
    const order = refusingOrder("refused-order");
    const builder = scriptedBuilder([
      (request) => {
        build(request);
        return tooLong;
      },
      () => corrected,
    ]);

    const outcome = await runOrderBuildLive(order.db, "refused-order", order.operator.name, {
      ...order.options,
      adapter: builder.adapter,
    });

    expect(builder.calls.map((call) => [call.kind, call.sessionId])).toEqual([
      ["start", undefined],
      ["resume", "fake-session"],
    ]);
    const correction = builder.calls[1]?.brief ?? "";
    expect(correction).toContain(tooLong.subject);
    expect(correction).toContain("subject is 38 characters, over the 20 allowed");
    expect(correction).toContain("within the current Build attempt");
    expect(correction).toContain('{"subject": "...", "artifact": "..."}');
    expect(order.checksRun()).toBe(2);
    expect(git(order.worktree, ["rev-list", "--count", `${order.repo.sha}..HEAD`])).toBe("1");
    expect(git(order.worktree, ["log", "-1", "--format=%s"])).toBe("feat: build it");
    expect(order.db.query("SELECT subject FROM factory_order_commit").all()).toEqual([
      { subject: "feat: build it" },
    ]);
    expect(order.events("claimed")).toEqual([
      { worker: order.operator.name, reason: null },
      { worker: outcome.builder, reason: null },
    ]);
    expect(order.events("failed")).toEqual([]);
    expect(order.db.query("SELECT worker FROM factory_order_slice_completion").all()).toEqual([
      { worker: outcome.builder },
    ]);
    order.db.close();
  });

  test("fails the attempt with the latest refusal after two corrections are refused, keeping the work", async () => {
    const order = refusingOrder("still-refused-order");
    const builder = scriptedBuilder([
      (request) => {
        build(request);
        return tooLong;
      },
      () => ({ ...tooLong, subject: "feat: build the requested result again" }),
      () => ({ ...tooLong, subject: "feat: build the requested result at last" }),
      () => corrected,
    ]);

    await expect(
      runOrderBuildLive(order.db, "still-refused-order", order.operator.name, {
        ...order.options,
        adapter: builder.adapter,
      }),
    ).rejects.toThrow("subject is 40 characters, over the 20 allowed");

    expect(builder.calls.map((call) => call.kind)).toEqual(["start", "resume", "resume"]);
    expect(order.checksRun()).toBe(3);
    expect(git(order.worktree, ["rev-parse", "HEAD"])).toBe(order.repo.sha);
    expect(git(order.worktree, ["status", "--porcelain"])).toBe("?? built.txt");
    expect(order.db.query("SELECT count(*) AS n FROM factory_order_commit").get()).toEqual({ n: 0 });
    expect(order.db.query("SELECT count(*) AS n FROM factory_order_slice_completion").get()).toEqual({
      n: 0,
    });
    const failed = order.events("failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toContain("subject is 40 characters, over the 20 allowed");
    order.db.close();
  });

  test("fails without another correction when the builder's correction is not a build turn", async () => {
    const order = refusingOrder("malformed-order");
    const builder = scriptedBuilder([
      (request) => {
        build(request);
        return tooLong;
      },
      () => "the subject is fixed now",
      () => corrected,
    ]);

    await expect(
      runOrderBuildLive(order.db, "malformed-order", order.operator.name, {
        ...order.options,
        adapter: builder.adapter,
      }),
    ).rejects.toThrow("builder output must be valid JSON");

    expect(builder.calls.map((call) => call.kind)).toEqual(["start", "resume"]);
    expect(order.events("failed")).toHaveLength(1);
    expect(git(order.worktree, ["status", "--porcelain"])).toBe("?? built.txt");
    order.db.close();
  });

  test("fails without another correction when the correction's run fails", async () => {
    const order = refusingOrder("correction-crash-order");
    const builder = scriptedBuilder([
      (request) => {
        build(request);
        return tooLong;
      },
      () => new Error("correction crashed"),
      () => corrected,
    ]);

    await expect(
      runOrderBuildLive(order.db, "correction-crash-order", order.operator.name, {
        ...order.options,
        adapter: builder.adapter,
      }),
    ).rejects.toThrow("correction crashed");

    expect(builder.calls.map((call) => call.kind)).toEqual(["start", "resume"]);
    expect(order.events("failed")).toHaveLength(1);
    expect(order.db.query("SELECT count(*) AS n FROM factory_order_commit").get()).toEqual({ n: 0 });
    order.db.close();
  });

  test("fails without another correction when the correction is refused for another reason", async () => {
    const order = refusingOrder("correction-red-order");
    const builder = scriptedBuilder([
      (request) => {
        build(request);
        return tooLong;
      },
      (request) => {
        mkdirSync(join(request.cwd, "vendor", "planted"), { recursive: true });
        git(join(request.cwd, "vendor", "planted"), ["init", "-q"]);
        return corrected;
      },
      () => corrected,
    ]);

    await expect(
      runOrderBuildLive(order.db, "correction-red-order", order.operator.name, {
        ...order.options,
        adapter: builder.adapter,
      }),
    ).rejects.toThrow("vendor/planted");

    expect(builder.calls.map((call) => call.kind)).toEqual(["start", "resume"]);
    expect(order.events("failed")).toHaveLength(1);
    order.db.close();
  });

  test("commits nothing and records no failure once another run holds the order during the correction's check", async () => {
    const scratch = home("dim-builder-replaced-db-");
    const file = join(scratch, "dim.db");
    const db = new Database(file);
    db.run(SCHEMA_SQL);
    const replace = join(scratch, "replace.ts");
    const order = refusingOrder("replaced-order", db, (checks) => {
      writeFileSync(
        replace,
        [
          'import { Database } from "bun:sqlite";',
          'import { appendFileSync, readFileSync } from "node:fs";',
          `appendFileSync(${JSON.stringify(checks)}, "ran\\n");`,
          `if (readFileSync(${JSON.stringify(checks)}, "utf8").trim().split("\\n").length === 2) {`,
          `  new Database(${JSON.stringify(file)}).run("UPDATE factory_order SET run_id = 'build-replacement' WHERE id = 'replaced-order'");`,
          "}",
          "",
        ].join("\n"),
      );
      return `${process.execPath} ${replace}`;
    });
    const builder = scriptedBuilder([
      (request) => {
        build(request);
        return tooLong;
      },
      () => corrected,
      () => corrected,
    ]);

    await expect(
      runOrderBuildLive(db, "replaced-order", order.operator.name, {
        ...order.options,
        adapter: builder.adapter,
      }),
    ).rejects.toThrow("replaced-order");

    expect(builder.calls.map((call) => call.kind)).toEqual(["start", "resume"]);
    expect(order.checksRun()).toBe(2);
    expect(git(order.worktree, ["rev-parse", "HEAD"])).toBe(order.repo.sha);
    expect(db.query("SELECT count(*) AS n FROM factory_order_commit").get()).toEqual({ n: 0 });
    expect(order.events("failed")).toEqual([]);
    db.close();
  });

  test("does not resume the builder once another run took the order while git refused the commit", async () => {
    const scratch = home("dim-builder-taken-db-");
    const file = join(scratch, "dim.db");
    const db = new Database(file);
    db.run(SCHEMA_SQL);
    const order = refusingOrder("taken-order", db);
    const take = join(scratch, "take.ts");
    writeFileSync(
      take,
      `import { Database } from "bun:sqlite";\nnew Database(${JSON.stringify(file)}).run("UPDATE factory_order SET run_id = 'build-replacement' WHERE id = 'taken-order'");\n`,
    );
    const hooks = git(order.repo.dir, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
    writeFileSync(
      join(hooks, "commit-msg"),
      `#!/bin/sh\n${process.execPath} ${take}\necho "refused after the order was taken" >&2\nexit 1\n`,
      { mode: 0o755 },
    );
    const builder = scriptedBuilder([
      (request) => {
        build(request);
        return corrected;
      },
      () => corrected,
    ]);

    await expect(
      runOrderBuildLive(db, "taken-order", order.operator.name, {
        ...order.options,
        adapter: builder.adapter,
      }),
    ).rejects.toThrow("refused after the order was taken");

    expect(builder.calls.map((call) => call.kind)).toEqual(["start"]);
    expect(order.events("failed")).toEqual([]);
    db.close();
  });
});

describe("a conflict at ship", () => {
  test("goes back to the builder, whose resolution the runner continues, re-checks and hands to review", async () => {
    const db = database();
    const dimHome = home("dim-builder-conflict-");
    const { repo, operator } = orderAtBuild(db, "conflict-order", [
      { title: "Build one half", outcome: "One half is verified." },
      { title: "Build the other", outcome: "The other half is verified." },
    ]);
    const options = { dir: repo.dir, env: { DIM_HOME: dimHome }, checkSandbox: confiningCheckSandbox() };
    const worktree = realpathSync(join(repo.dir, ".claude", "worktrees", "conflict-order"));
    for (const [file, artifact] of [
      ["built.txt", ""],
      ["other.txt", "## Outcome\n\nBuilt."],
    ] as const) {
      await runOrderBuildLive(db, "conflict-order", operator.name, {
        ...options,
        adapter: scriptedBuilder([
          (request) => {
            writeFileSync(join(request.cwd, file), "built\n");
            return { subject: `feat: build ${file}`, artifact };
          },
        ]).adapter,
      });
    }
    approveOrderBuild(db, "conflict-order", operator.name, "built as planned");
    writeFileSync(join(repo.dir, "built.txt"), "trunk\n");
    writeFileSync(join(repo.dir, "other.txt"), "trunk\n");
    git(repo.dir, ["add", "built.txt", "other.txt"]);
    git(repo.dir, ["commit", "-q", "-m", "feat: build both on the trunk"]);
    const trunkTip = git(repo.dir, ["rev-parse", "HEAD"]);
    expect(() =>
      shipOrder(db, "conflict-order", worktree, operator.name, {
        env: options.env,
        checkSandbox: options.checkSandbox,
      }),
    ).toThrow(expect.objectContaining({ code: "ship_rebase_conflict" }));

    const resolve = (file: string) => (request: HarnessRequest) => {
      writeFileSync(join(request.cwd, file), "built\ntrunk\n");
      return { subject: "fix: resolve", artifact: "" };
    };
    const builder = scriptedBuilder([resolve("built.txt"), resolve("other.txt")]);
    await runOrderBuildLive(db, "conflict-order", operator.name, { ...options, adapter: builder.adapter });

    expect(builder.calls).toHaveLength(2);
    expect(builder.calls[0]?.brief).toContain("# Rebase conflict");
    expect(builder.calls[0]?.brief).toContain("- built.txt");
    expect(builder.calls[0]?.brief).not.toContain("# Commit convention");
    expect(builder.calls[0]?.brief).not.toContain("run the build station loop including simplification");
    expect(builder.calls[1]?.brief).toContain("- other.txt");
    expect(git(worktree, ["show", "HEAD:built.txt"])).toBe("built\ntrunk");
    expect(git(worktree, ["show", "HEAD:other.txt"])).toBe("built\ntrunk");
    expect(git(worktree, ["rev-parse", "HEAD~2"])).toBe(trunkTip);
    expect(db.query("SELECT patch_equal FROM factory_order_rewrite").all()).toEqual([{ patch_equal: 0 }]);
    expect(db.query("SELECT station FROM factory_order WHERE id = 'conflict-order'").get()).toEqual({
      station: "dim-station-review",
    });
    db.close();
  });
});
