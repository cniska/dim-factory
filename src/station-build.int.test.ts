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
import { SCHEMA_SQL } from "./db-schema";
import {
  attemptIn,
  confiningCheckSandbox,
  declareCheck,
  integratedRepo,
  located,
} from "./fixtures.test-support";
import { installCommitGate } from "./gate-commit";
import type { HarnessAdapter, HarnessEvent, HarnessRequest, HarnessRun } from "./harness";
import { fakeHarness } from "./harness-fake";
import { approveOrder, returnOrderArtifact } from "./order-approval";
import { completeOrderBuildFollowup, recordOrderBuild, recordOrderPlan } from "./order-artifacts";
import { openAttempt } from "./order-attempt";
import { recordOrderCheck, recordOrderCommit } from "./order-evidence";
import {
  answerOrderFindings,
  BuildTurnRefused,
  raiseOrderFinding,
  recordOwnerRuling,
  ruleOnOrderFinding,
} from "./order-finding";
import { appendOrderEvent } from "./order-ledger";
import { queueOrder, startOrder } from "./order-lifecycle";
import { closeOrderReview, openOrderReview } from "./order-review";
import { shipOrder } from "./order-ship";
import { orderState } from "./order-state";
import { approveReviewAt } from "./station-approvals.test-support";
import { runOrderBuildLive } from "./station-build";
import type { BuildTurn } from "./station-build-turn";
import { endWorker, mintWorker, WORKER_NAME_VAR, WORKER_SESSION_VAR, WORKER_TOKEN_VAR } from "./worker";
import { repoRoot } from "./wt-command";

const repos: string[] = [];
const homes: string[] = [];
afterAll(() => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function builderTurn(
  act: (request: HarnessRequest) => (Omit<BuildTurn, "answers"> & Partial<BuildTurn>) | string,
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
        yield {
          type: "run.completed",
          output: typeof answer === "string" ? answer : JSON.stringify({ answers: [], ...answer }),
        };
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
  startOrder(db, orderId, operator.name, undefined, repo.dir);
  const planner = mintWorker(db, {
    role: "planner",
    parentWorker: operator.name,
    sessionId: `${orderId}/planner`,
  });
  recordOrderPlan(db, orderId, "## Outcome\n\nBuild the requested result.", planner.name, slices);
  approveOrder(db, orderId, operator.name, undefined);
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
      harness: "codex",
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
    expect(request?.outputSchema).toEndWith("station-build-turn.schema.json");
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
      { kind: "started", worker: operator.name, station: null },
      { kind: "artifact_written", worker: planner, station: null },
      { kind: "artifact_approved", worker: operator.name, station: null },
      { kind: "commit_created", worker: outcome.builder, station: null },
      { kind: "check_finished", worker: operator.name, station: null },
      { kind: "artifact_written", worker: outcome.builder, station: null },
    ]);
    expect(
      db
        .query(
          "SELECT run_id, worker, operator_worker, station, kind, outcome FROM factory_order_attempt ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        run_id: outcome.runId,
        worker: outcome.builder,
        operator_worker: operator.name,
        station: "build",
        kind: "started",
        outcome: "running",
      },
      {
        run_id: outcome.runId,
        worker: outcome.builder,
        operator_worker: operator.name,
        station: "build",
        kind: "finished",
        outcome: "succeeded",
      },
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
    expect(
      db
        .query(
          `SELECT a.body, a.head_sha, w.worker FROM factory_order_artifact a
           JOIN factory_order_event w ON w.artifact_id = a.id AND w.kind = 'artifact_written'
           WHERE a.kind = 'build'`,
        )
        .all(),
    ).toEqual([
      { body: "The requested result is built and verified.", head_sha: head, worker: outcome.builder },
    ]);
    expect(db.query("SELECT worker FROM factory_order_slice_completion").get()).toEqual({
      worker: outcome.builder,
    });
    expect(openAttempt(db, "builder-order")).toBeNull();
    expect(orderState(db, "builder-order")).toEqual({ station: "build", next: "approve" });

    returnOrderArtifact(db, "builder-order", operator.name, "Explain what the build verified.");
    const unavailable = unavailableHarness();
    await expect(
      runOrderBuildLive(db, "builder-order", operator.name, {
        dir: repo.dir,
        env,
        harness: "codex",
        adapter: unavailable.adapter,
      }),
    ).rejects.toThrow("harness unavailable");
    expect(unavailable.brief()).toContain("The owner returned the Build artifact to you.");
    expect(unavailable.brief()).toContain("Explain what the build verified.");
    await expect(
      runOrderBuildLive(db, "builder-order", operator.name, {
        dir: repo.dir,
        env,
        harness: "codex",
        adapter: fakeHarness("crash"),
      }),
    ).rejects.toThrow("fake process crashed");
    expect(db.query("SELECT status FROM factory_order WHERE id = ?").get("builder-order")).toEqual({
      status: "working",
    });
    expect(orderState(db, "builder-order")).toEqual({ station: "build", next: "run" });
    expect(
      db
        .query("SELECT kind FROM factory_order_event WHERE order_id = ? ORDER BY id DESC LIMIT 1")
        .get("builder-order"),
    ).toEqual({ kind: "artifact_returned" });
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
      harness: "codex",
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
    const options = {
      dir: repo.dir,
      env: { DIM_HOME: dimHome },
      harness: "codex" as const,
      checkSandbox: confiningCheckSandbox(),
    };

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
        harness: "codex",
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
        harness: "codex",
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
        harness: "codex",
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
      harness: "codex",
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
      harness: "codex",
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
        harness: "codex",
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
        harness: "codex",
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

  test("keeps an incomplete final slice after a failed attempt, and hands a later returned Build artifact's feedback to the builder", async () => {
    const db = database();
    const dimHome = home("dim-builder-return-");
    const { repo, operator } = orderAtBuild(db, "returned-builder-order", [
      { title: "Finish the result", outcome: "The result is verified." },
    ]);
    const options = {
      dir: repo.dir,
      env: { DIM_HOME: dimHome },
      harness: "codex" as const,
      checkSandbox: confiningCheckSandbox(),
    };
    const builder = mintWorker(db, {
      role: "builder",
      parentWorker: operator.name,
      sessionId: "return-operator/builder",
    });
    attemptIn(db, "returned-builder-order", builder.name, operator.name, "build-run");
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
    expect(() =>
      returnOrderArtifact(
        db,
        "returned-builder-order",
        operator.name,
        "Explain the verification for the owner.",
      ),
    ).toThrow(
      expect.objectContaining({ code: "not_next", message: expect.stringContaining("run at build") }),
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
    expect(brief).not.toContain("# Returned Build artifact");
    expect(brief).not.toContain("The code work is complete; revise only the artifact.");
    expect(db.query("SELECT count(*) AS n FROM factory_order_slice_completion").get()).toEqual({ n: 0 });

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
      db
        .query(
          "SELECT revision, head_sha FROM factory_order_artifact WHERE kind = 'build' ORDER BY revision DESC LIMIT 1",
        )
        .get(),
    ).toEqual({ revision: 2, head_sha: repo.sha });

    returnOrderArtifact(db, "returned-builder-order", operator.name, "Match the actual worktree HEAD.");
    const laterCommit = Bun.spawnSync(
      ["git", "-C", outcome.worktree, "commit", "--allow-empty", "-m", "fix: unrecorded head"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(laterCommit.success).toBe(true);
    const later = git(outcome.worktree, ["rev-parse", "HEAD"]);
    let returnedBrief = "";
    await expect(
      runOrderBuildLive(db, "returned-builder-order", operator.name, {
        ...options,
        adapter: builderTurn((request) => {
          returnedBrief = request.brief;
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
    expect(returnedBrief).toContain("# Returned Build artifact");
    expect(returnedBrief).toContain("The revised Build artifact explains the verification.");
    expect(returnedBrief).toContain("# Owner feedback");
    expect(returnedBrief).toContain("Match the actual worktree HEAD.");

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

  describe("a round that raised a finding", () => {
    async function reviewedAtBuild(orderId: string, check = "true") {
      const db = database();
      const dimHome = home(`dim-builder-${orderId}-`);
      const { repo, operator } = orderAtBuild(
        db,
        orderId,
        [{ title: "Build the result", outcome: "The result is verified." }],
        check,
      );
      const options = {
        dir: repo.dir,
        env: { DIM_HOME: dimHome },
        harness: "codex" as const,
        checkSandbox: confiningCheckSandbox(),
      };
      const firstBuild = await runOrderBuildLive(db, orderId, operator.name, {
        ...options,
        adapter: builderTurn((request) => {
          writeFileSync(join(request.cwd, "first.txt"), "first\n");
          return { subject: "feat: build it", artifact: "Initial Build artifact." };
        }),
      });
      const first = git(firstBuild.worktree, ["rev-parse", "HEAD"]);
      approveOrder(db, orderId, operator.name, "Build approved.");
      const reviewer = mintWorker(db, {
        role: "reviewer",
        parentWorker: operator.name,
        sessionId: `${orderId}-r`,
      });
      const review = openOrderReview(
        db,
        orderId,
        { reviewer: reviewer.name, baseSha: repo.sha, headSha: first },
        reviewer.name,
      );
      const finding = raiseOrderFinding(
        db,
        orderId,
        located({ dimension: "correctness", failure: "Count the actual order provenance." }),
        reviewer.name,
      );
      closeOrderReview(db, review.id, "closed", reviewer.name);
      return { db, operator, options, firstBuild, first, finding };
    }

    const answers = (db: Database) =>
      db.query("SELECT finding_id, run_id, answer, resolution FROM factory_order_finding_answer").all();
    const commits = (db: Database, orderId: string) =>
      db.query("SELECT sha FROM factory_order_commit WHERE order_id = ?").all(orderId);

    test("hands the finding to the same builder as work and records its answer under the builder and the run", async () => {
      const { db, operator, options, firstBuild, first, finding } =
        await reviewedAtBuild("review-rework-order");
      let brief = "";
      const followup = await runOrderBuildLive(db, "review-rework-order", operator.name, {
        ...options,
        adapter: builderTurn((request) => {
          brief = request.brief;
          writeFileSync(join(request.cwd, "fix.txt"), "fix\n");
          expect(() => completeOrderBuildFollowup(db, "review-rework-order")).toThrow(
            "no Build artifact after its latest Review",
          );
          return {
            subject: "fix: review finding",
            artifact: "Revised Build artifact.",
            answers: [{ finding, answer: "fixed", resolution: null }],
          };
        }),
      });
      const head = git(followup.worktree, ["rev-parse", "HEAD"]);
      expect(head).not.toBe(first);
      expect(brief).toContain(
        `# Review findings\n- Finding ${finding} (correctness, src/example.ts:1): Count the actual order provenance.`,
      );
      expect(followup.builder).toBe(firstBuild.builder);
      expect(answers(db)).toEqual([
        { finding_id: finding, run_id: followup.runId, answer: "fixed", resolution: null },
      ]);
      expect(
        db.query("SELECT worker, finding_id FROM factory_order_event WHERE kind = 'finding_answered'").all(),
      ).toEqual([{ worker: followup.builder, finding_id: finding }]);
      expect(openAttempt(db, "review-rework-order")).toBeNull();
      expect(orderState(db, "review-rework-order")).toEqual({ station: "build", next: "approve" });
      expect(
        db
          .query(
            "SELECT revision, head_sha FROM factory_order_artifact WHERE kind = 'build' ORDER BY revision DESC LIMIT 1",
          )
          .get(),
      ).toEqual({ revision: 2, head_sha: head });
      db.close();
    });

    test("records a refuse-only turn's answers and makes no commit", async () => {
      const { db, operator, options, first, finding } = await reviewedAtBuild("refused-rework-order");
      const before = commits(db, "refused-rework-order");
      const followup = await runOrderBuildLive(db, "refused-rework-order", operator.name, {
        ...options,
        adapter: builderTurn(() => ({
          subject: "docs: answer the review",
          artifact: "Build artifact refusing the finding.",
          answers: [{ finding, answer: "refused", resolution: "no doc names it" }],
        })),
      });
      expect(git(followup.worktree, ["rev-parse", "HEAD"])).toBe(first);
      expect(commits(db, "refused-rework-order")).toEqual(before);
      expect(answers(db)).toEqual([
        { finding_id: finding, run_id: followup.runId, answer: "refused", resolution: "no doc names it" },
      ]);
      expect(
        db
          .query(
            "SELECT revision, head_sha FROM factory_order_artifact WHERE kind = 'build' ORDER BY revision DESC LIMIT 1",
          )
          .get(),
      ).toEqual({ revision: 2, head_sha: first });
      expect(openAttempt(db, "refused-rework-order")).toBeNull();
      db.close();
    });

    async function refusedTurn(
      orderId: string,
      turn: (finding: number) => Omit<BuildTurn, "subject" | "artifact">,
      given: { change?: string; check?: string; prepare?: (db: Database) => void } = {},
    ) {
      const { db, operator, options, first, finding } = await reviewedAtBuild(orderId, given.check);
      const recorded = commits(db, orderId);
      given.prepare?.(db);
      const failure = await runOrderBuildLive(db, orderId, operator.name, {
        ...options,
        adapter: builderTurn((request) => {
          if (given.change !== "") writeFileSync(join(request.cwd, given.change ?? "fix.txt"), "fix\n");
          return { subject: "fix: review finding", artifact: "Revised Build artifact.", ...turn(finding) };
        }),
      }).then(
        () => undefined,
        (error: Error) => error,
      );
      const worktree = join(options.dir, ".claude", "worktrees", orderId);
      expect(git(worktree, ["rev-parse", "HEAD"])).toBe(first);
      expect(commits(db, orderId)).toEqual(recorded);
      expect(answers(db)).toEqual([]);
      db.close();
      return failure;
    }

    const fixed = (finding: number) => ({
      answers: [{ finding, answer: "fixed" as const, resolution: null }],
    });

    test("records no answer from a turn whose check is red", async () => {
      const failure = await refusedTurn("red-rework-order", fixed, {
        change: "red.txt",
        check: "test ! -f red.txt",
      });
      expect(failure?.cause).toMatchObject({ code: "check_failed" });
    });

    test("records no answer and takes the commit back when a write in the commit's transaction fails", async () => {
      const failure = await refusedTurn("unrecorded-rework-order", fixed, {
        prepare: (db) =>
          db.run(
            `CREATE TRIGGER refuse_answered BEFORE INSERT ON factory_order_event
             WHEN NEW.kind = 'finding_answered' BEGIN SELECT RAISE(ABORT, 'answer refused'); END`,
          ),
      });
      expect(failure?.message).toContain("answer refused");
    });

    test("refuses a second refusal of a finding whose refusal the owner overturned", async () => {
      const orderId = "overturned-rework-order";
      const { db, operator, options, firstBuild, first, finding } = await reviewedAtBuild(orderId);
      answerOrderFindings(
        db,
        orderId,
        "build-2",
        [{ finding, answer: "refused", resolution: "out of scope" }],
        firstBuild.builder,
      );
      const reviewer = mintWorker(db, {
        role: "reviewer",
        parentWorker: operator.name,
        sessionId: `${orderId}-r2`,
      });
      const second = openOrderReview(
        db,
        orderId,
        { reviewer: reviewer.name, baseSha: first, headSha: first },
        reviewer.name,
      );
      ruleOnOrderFinding(db, finding, { ruling: "refusal_contested", reason: "in scope" }, reviewer.name);
      closeOrderReview(db, second.id, "closed", reviewer.name);
      recordOwnerRuling(db, finding, { ruling: "refusal_overturned", reason: "fix it" }, operator.name);
      const failure = await runOrderBuildLive(db, orderId, operator.name, {
        ...options,
        adapter: builderTurn((request) => {
          writeFileSync(join(request.cwd, "fix.txt"), "fix\n");
          return {
            subject: "fix: review finding",
            artifact: "Revised Build artifact.",
            answers: [{ finding, answer: "refused", resolution: "still out of scope" }],
          };
        }),
      }).then(
        () => undefined,
        (error: Error) => error,
      );
      expect(failure?.cause).toBeInstanceOf(BuildTurnRefused);
      expect(failure?.cause).toMatchObject({ code: "refusal_overturned" });
      expect(git(join(options.dir, ".claude", "worktrees", orderId), ["rev-parse", "HEAD"])).toBe(first);
      expect(answers(db)).toHaveLength(1);
      db.close();
    });

    test("refuses a turn that answers one finding twice before committing", async () => {
      const failure = await refusedTurn("twice-rework-order", (finding) => ({
        answers: [
          { finding, answer: "fixed", resolution: null },
          { finding, answer: "fixed", resolution: null },
        ],
      }));
      expect(failure?.cause).toMatchObject({ code: "answer_not_owed" });
    });

    test("refuses a turn that leaves a briefed finding unanswered", async () => {
      expect((await refusedTurn("unanswered-rework-order", () => ({ answers: [] })))?.cause).toMatchObject({
        code: "finding_unanswered",
      });
    });

    test("refuses an answer to a finding the brief did not hand over as work", async () => {
      expect(
        (
          await refusedTurn("unowed-rework-order", (finding) => ({
            answers: [
              { finding, answer: "fixed", resolution: null },
              { finding: finding + 1, answer: "fixed", resolution: null },
            ],
          }))
        )?.cause,
      ).toMatchObject({ code: "answer_not_owed" });
    });

    test("refuses a fixed answer from a turn that changed nothing", async () => {
      expect((await refusedTurn("unchanged-rework-order", fixed, { change: "" }))?.cause).toMatchObject({
        code: "no_change",
      });
    });
  });

  test("starts one attempt and commits the answer when the builder begins another turn after answering", async () => {
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
      harness: "codex",
      env: { DIM_HOME: dimHome },
      checkSandbox: confiningCheckSandbox(),
      adapter,
    });

    expect(
      db
        .query("SELECT count(*) AS n FROM factory_order_event WHERE order_id = ? AND kind = 'failed'")
        .get("second-turn-order"),
    ).toEqual({ n: 0 });
    expect(
      db
        .query("SELECT worker, kind, outcome FROM factory_order_attempt WHERE order_id = ? ORDER BY id")
        .all("second-turn-order"),
    ).toEqual([
      { worker: outcome.builder, kind: "started", outcome: "running" },
      { worker: outcome.builder, kind: "finished", outcome: "succeeded" },
    ]);
    expect(adapter.cancels()).toBe(1);
    expect(db.query("SELECT subject FROM factory_order_commit").all()).toEqual([
      { subject: "feat: build it" },
    ]);
    db.close();
  });

  test("fails a builder run that starts twice as a harness fault, not a second attempt", async () => {
    const db = database();
    const dimHome = home("dim-builder-second-start-");
    const { repo, operator } = orderAtBuild(db, "second-start-order", [
      { title: "Build the result", outcome: "The requested result is verified." },
    ]);

    await expect(
      runOrderBuildLive(db, "second-start-order", operator.name, {
        dir: repo.dir,
        harness: "codex",
        env: { DIM_HOME: dimHome },
        adapter: fakeHarness("second-start"),
      }),
    ).rejects.toThrow("harness fault: the worker started a second run before answering");

    expect(
      db
        .query("SELECT kind, outcome FROM factory_order_attempt WHERE order_id = ? ORDER BY id")
        .all("second-start-order"),
    ).toEqual([
      { kind: "started", outcome: "running" },
      { kind: "finished", outcome: "failed" },
    ]);
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
        harness: "codex",
        env: { DIM_HOME: dimHome },
        adapter: unavailableHarness().adapter,
      }),
    ).rejects.toThrow("harness unavailable");

    expect(
      db
        .query("SELECT kind, worker, reason FROM factory_order_event WHERE order_id = ?")
        .all("failed-builder-order"),
    ).toContainEqual({ kind: "failed", worker: null, reason: "harness unavailable" });
    expect(db.query("SELECT status FROM factory_order WHERE id = ?").get("failed-builder-order")).toEqual({
      status: "working",
    });
    expect(openAttempt(db, "failed-builder-order")).toBeNull();
    expect(orderState(db, "failed-builder-order")).toEqual({ station: "build", next: "run" });
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
        harness: "codex",
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
        harness: "codex",
        env: env(nextOperator),
        adapter,
      }),
    ).rejects.toThrow("fake process crashed");
    await expect(
      runOrderBuildLive(db, "builder-resume-order", laterOperator.name, {
        dir: repo.dir,
        harness: "codex",
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
          "SELECT kind, operator_worker FROM factory_order_attempt WHERE kind = 'started' AND station = 'build' ORDER BY rowid",
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
           WHERE kind = 'started' AND station = 'build'
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
    expect(
      db
        .query<{ reason: string }, [string]>(
          "SELECT reason FROM factory_order_event WHERE order_id = ? AND kind = 'failed'",
        )
        .get("harness-order")?.reason,
    ).toMatch(/ did not finish: fake process crashed/);
    const working = () => ({
      status: db
        .query<{ status: string }, [string]>("SELECT status FROM factory_order WHERE id = ?")
        .get("harness-order")?.status,
      attempt: openAttempt(db, "harness-order"),
    });
    expect(working()).toEqual({ status: "working", attempt: null });

    await expect(
      runOrderBuildLive(db, "harness-order", operator.name, { dir: repo.dir, env, harness: "codex" }),
    ).rejects.toThrow(
      "order harness-order builder runs under the claude harness; delegate it with --harness claude",
    );
    expect(failures()).toEqual({ n: 1 });
    expect(working()).toEqual({ status: "working", attempt: null });
    db.close();
  });
});

type BuilderCall = { kind: "start" | "resume"; sessionId?: string; brief: string };

function scriptedBuilder(
  answers: ((
    request: HarnessRequest,
  ) => (Omit<BuildTurn, "answers"> & Partial<BuildTurn>) | string | Error)[],
): {
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
            output: typeof answer === "string" ? answer : JSON.stringify({ answers: [], ...answer }),
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
      options: {
        dir: repo.dir,
        env: { DIM_HOME: dimHome },
        harness: "codex" as const,
        checkSandbox: confiningCheckSandbox(),
      },
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
    expect(correction).toContain('{"subject": "...", "artifact": "...", "answers": [...]}');
    expect(order.checksRun()).toBe(2);
    expect(git(order.worktree, ["rev-list", "--count", `${order.repo.sha}..HEAD`])).toBe("1");
    expect(git(order.worktree, ["log", "-1", "--format=%s"])).toBe("feat: build it");
    expect(order.db.query("SELECT subject FROM factory_order_commit").all()).toEqual([
      { subject: "feat: build it" },
    ]);
    expect(
      order.db.query("SELECT worker, kind, outcome FROM factory_order_attempt ORDER BY id").all(),
    ).toEqual([
      { worker: outcome.builder, kind: "started", outcome: "running" },
      { worker: outcome.builder, kind: "finished", outcome: "succeeded" },
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
});

describe("a comment a builder adds", () => {
  const commented = "// why it is built\nexport const built = 1;\n";
  const plain = "export const built = 1;\n";
  const turn = { subject: "feat: build it", artifact: "Built." };

  function commentOrder(
    orderId: string,
    setting: string,
    gate: { owner?: string | null; remote?: { name: string; url: string } | null } = {},
  ) {
    const db = database();
    const dimHome = home(`dim-builder-${orderId}-`);
    const checks = join(dimHome, "checks");
    const { repo, operator } = orderAtBuild(
      db,
      orderId,
      [{ title: "Build the result", outcome: "The requested result is verified." }],
      `echo ran >> ${checks}`,
    );
    const remote =
      gate.remote === undefined ? { name: "origin", url: "git@github.com:cniska/thing.git" } : gate.remote;
    if (remote !== null) git(repo.dir, ["remote", "add", remote.name, remote.url]);
    const env = {
      DIM_HOME: dimHome,
      HOME: join(dimHome, "home"),
      GIT_CONFIG_GLOBAL: join(dimHome, "gitconfig"),
    };
    const owner = gate.owner === undefined ? "github.com/cniska" : gate.owner;
    if (owner !== null) installCommitGate([owner], [], env);
    mkdirSync(join(env.HOME, ".config", "dim"), { recursive: true });
    writeFileSync(join(env.HOME, ".config", "dim", "config.json"), setting);
    return {
      db,
      repo,
      operator,
      worktree: realpathSync(join(repo.dir, ".claude", "worktrees", orderId)),
      options: { dir: repo.dir, env, harness: "codex" as const, checkSandbox: confiningCheckSandbox() },
      checksRun: () =>
        existsSync(checks) ? readFileSync(checks, "utf8").split("\n").filter(Boolean).length : 0,
      failures: () =>
        db
          .query<{ reason: string | null }, [string]>(
            "SELECT reason FROM factory_order_event WHERE order_id = ? AND kind = 'failed'",
          )
          .all(orderId),
    };
  }

  const write =
    (content: string, others: Record<string, string> = {}) =>
    (request: HarnessRequest) => {
      writeFileSync(join(request.cwd, "built.ts"), content);
      for (const [path, text] of Object.entries(others)) writeFileSync(join(request.cwd, path), text);
      return turn;
    };

  test("refuses the turn before its check where the repo bans comments, naming each line, and leaves HEAD where it was", async () => {
    const order = commentOrder("comment-order", '{ "comments": "banned" }');
    const both = write(commented, { "a.ts": "const a = 1;\n// why\n", "c.ts": "const = ;\n" });
    const builder = scriptedBuilder([both, both, both]);

    const error = await runOrderBuildLive(order.db, "comment-order", order.operator.name, {
      ...order.options,
      adapter: builder.adapter,
    }).catch((caught: unknown) => caught);

    const refusal =
      "the turn adds a code comment, which cniska/thing bans:\n  a.ts:2\n  built.ts:1\nput the why in a name, a test, or the doc that owns the subject";
    const cause = (error as Error).cause;
    expect(cause).toBeInstanceOf(BuildTurnRefused);
    expect(cause).toMatchObject({ code: "comment_added", message: refusal });
    expect(builder.calls.map((call) => call.kind)).toEqual(["start", "resume", "resume"]);
    expect(builder.calls[1]?.brief).toContain(refusal);
    expect(builder.calls[1]?.brief).toContain("before running its check");
    expect(builder.calls[1]?.brief).not.toContain("check passed");
    expect(order.checksRun()).toBe(0);
    expect(git(order.worktree, ["rev-parse", "HEAD"])).toBe(order.repo.sha);
    expect(git(order.worktree, ["status", "--porcelain"])).toBe("?? a.ts\n?? built.ts\n?? c.ts");
    expect(order.db.query("SELECT count(*) AS n FROM factory_order_commit").get()).toEqual({ n: 0 });
    expect(
      order.db.query("SELECT count(*) AS n FROM trace_event WHERE event = 'order.file_unparsed'").get(),
    ).toEqual({ n: 0 });
    expect(order.failures()).toHaveLength(1);
    order.db.close();
  });

  test("reads the ban the trunk commits, so a builder cannot lift it from its worktree", async () => {
    const order = commentOrder("comment-trunk-ban-order", "{}");
    mkdirSync(join(order.repo.dir, ".dim"), { recursive: true });
    writeFileSync(join(order.repo.dir, ".dim", "config.json"), '{ "comments": "banned" }\n');
    git(order.repo.dir, ["add", ".dim/config.json"]);
    git(order.repo.dir, ["commit", "-q", "--no-verify", "-m", "chore: ban comments"]);
    const lifted = (request: HarnessRequest) => {
      mkdirSync(join(request.cwd, ".dim"), { recursive: true });
      writeFileSync(join(request.cwd, ".dim", "config.json"), '{ "comments": "allowed" }\n');
      return write(commented)(request);
    };
    const builder = scriptedBuilder([lifted, lifted, lifted]);

    const error = await runOrderBuildLive(order.db, "comment-trunk-ban-order", order.operator.name, {
      ...order.options,
      adapter: builder.adapter,
    }).catch((caught: unknown) => caught);

    expect((error as Error).cause).toMatchObject({ code: "comment_added" });
    expect(order.checksRun()).toBe(0);
    order.db.close();
  });

  test("fails the attempt where git's config cannot be read", async () => {
    const order = commentOrder("comment-git-config-order", '{ "comments": "banned" }');
    writeFileSync(order.options.env.GIT_CONFIG_GLOBAL, "[core\n");
    const builder = scriptedBuilder([write(commented)]);

    await expect(
      runOrderBuildLive(order.db, "comment-git-config-order", order.operator.name, {
        ...order.options,
        adapter: builder.adapter,
      }),
    ).rejects.toThrow("git config --type=path --get core.hooksPath failed");

    expect(builder.calls.map((call) => call.kind)).toEqual(["start"]);
    expect(order.checksRun()).toBe(0);
    expect(git(order.worktree, ["rev-parse", "HEAD"])).toBe(order.repo.sha);
    expect(order.failures()).toHaveLength(1);
    order.db.close();
  });

  test("fails the attempt where the setting cannot be read", async () => {
    const order = commentOrder("comment-malformed-order", '{ "comments": ');
    const builder = scriptedBuilder([write(commented)]);

    await expect(
      runOrderBuildLive(order.db, "comment-malformed-order", order.operator.name, {
        ...order.options,
        adapter: builder.adapter,
      }),
    ).rejects.toThrow("config.json");

    expect(builder.calls.map((call) => call.kind)).toEqual(["start"]);
    expect(order.checksRun()).toBe(0);
    expect(git(order.worktree, ["rev-parse", "HEAD"])).toBe(order.repo.sha);
    expect(order.failures()).toHaveLength(1);
    order.db.close();
  });

  test("commits a file it cannot parse and traces it under the order", async () => {
    const order = commentOrder("comment-unparsed-order", '{ "comments": "banned" }');
    const builder = scriptedBuilder([write(plain, { "a.ts": "const = ;\n// why\n" })]);

    await runOrderBuildLive(order.db, "comment-unparsed-order", order.operator.name, {
      ...order.options,
      adapter: builder.adapter,
    });

    expect(git(order.worktree, ["show", "HEAD:a.ts"])).toBe("const = ;\n// why");
    expect(
      order.db.query("SELECT order_id, path FROM trace_event WHERE event = 'order.file_unparsed'").all(),
    ).toEqual([{ order_id: "comment-unparsed-order", path: "a.ts" }]);
    order.db.close();
  });

  test("commits the builder's correction in the same attempt", async () => {
    const order = commentOrder("comment-corrected-order", '{ "comments": "banned" }');
    const builder = scriptedBuilder([write(commented), write(plain)]);

    await runOrderBuildLive(order.db, "comment-corrected-order", order.operator.name, {
      ...order.options,
      adapter: builder.adapter,
    });

    expect(builder.calls.map((call) => call.kind)).toEqual(["start", "resume"]);
    expect(git(order.worktree, ["show", "HEAD:built.ts"])).toBe(plain.trim());
    order.db.close();
  });

  test("commits the comment where the setting does not ban comments in the repo", async () => {
    const order = commentOrder("comment-allowed-order", '{ "comments": "allowed" }');
    const builder = scriptedBuilder([write(commented)]);

    await runOrderBuildLive(order.db, "comment-allowed-order", order.operator.name, {
      ...order.options,
      adapter: builder.adapter,
    });

    expect(git(order.worktree, ["show", "HEAD:built.ts"])).toBe(commented.trim());
    order.db.close();
  });

  for (const [what, orderId, prepare] of [
    [
      "the commit gate covers other owners",
      "comment-uncovered-order",
      () =>
        commentOrder("comment-uncovered-order", '{ "comments": "banned" }', {
          owner: "github.com/someone-else",
        }),
    ],
    [
      "no commit gate is installed",
      "comment-unhooked-order",
      () => commentOrder("comment-unhooked-order", '{ "comments": "banned" }', { owner: null }),
    ],
    [
      "the checkout has no remote to label it by",
      "comment-unlabeled-order",
      () => commentOrder("comment-unlabeled-order", '{ "comments": "banned" }', { remote: null }),
    ],
    [
      "only an upstream remote names the repository, so no origin is covered",
      "comment-upstream-order",
      () =>
        commentOrder("comment-upstream-order", '{ "comments": "banned" }', {
          remote: { name: "upstream", url: "git@github.com:cniska/thing.git" },
        }),
    ],
    [
      "a covered origin is a path, which labels no repository",
      "comment-path-origin-order",
      () =>
        commentOrder("comment-path-origin-order", '{ "comments": "banned" }', {
          owner: "/srv/cniska",
          remote: { name: "origin", url: "/srv/cniska/thing" },
        }),
    ],
    [
      "the repository runs its own hooks",
      "comment-own-hooks-order",
      () => {
        const order = commentOrder("comment-own-hooks-order", '{ "comments": "banned" }');
        git(order.repo.dir, ["config", "core.hooksPath", ".githooks"]);
        return order;
      },
    ],
  ] as const) {
    test(`commits the comment where ${what}`, async () => {
      const order = prepare();
      const builder = scriptedBuilder([write(commented)]);

      await runOrderBuildLive(order.db, orderId, order.operator.name, {
        ...order.options,
        adapter: builder.adapter,
      });

      expect(git(order.worktree, ["show", "HEAD:built.ts"])).toBe(commented.trim());
      order.db.close();
    });
  }

  test("commits a turn that leaves an existing comment untouched", async () => {
    const order = commentOrder("comment-kept-order", '{ "comments": "banned" }');
    writeFileSync(join(order.repo.dir, "built.ts"), commented);
    git(order.repo.dir, ["add", "built.ts"]);
    git(order.repo.dir, ["commit", "-q", "-m", "feat: add built.ts"]);
    git(order.worktree, ["merge", "-q", "--ff-only", "main"]);
    const builder = scriptedBuilder([write(`${commented}export const more = 2;\n`)]);

    await runOrderBuildLive(order.db, "comment-kept-order", order.operator.name, {
      ...order.options,
      adapter: builder.adapter,
    });

    expect(git(order.worktree, ["log", "-1", "--format=%s"])).toBe("feat: build it");
    order.db.close();
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
    const options = {
      dir: repo.dir,
      env: { DIM_HOME: dimHome },
      harness: "codex" as const,
      checkSandbox: confiningCheckSandbox(),
    };
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
    approveOrder(db, "conflict-order", operator.name, "built as planned");
    approveReviewAt(db, "conflict-order", git(worktree, ["rev-parse", "HEAD"]), operator.name);
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
    expect(orderState(db, "conflict-order")).toEqual({ station: "review", next: "run" });
    expect(openAttempt(db, "conflict-order")).toBeNull();
    db.close();
  });
});
