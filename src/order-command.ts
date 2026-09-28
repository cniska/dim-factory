import type { Database } from "bun:sqlite";
import { type Command, UsageError } from "./cli-contract";
import { readFlags, requiredFlag } from "./cli-flags";
import { closeDb, openDb } from "./db";
import { assertOperator } from "./factory-operator";
import { checkoutRoot } from "./git-checkout";
import { labelFor } from "./git-remote";
import { HARNESSES, type HarnessName, isHarness, parseHarness } from "./harness-name";
import { requireCurrentHooks } from "./hooks";
import { approveOrder, returnOrder } from "./order-approval";
import { nextOrderSlice } from "./order-artifacts";
import { latestOrderCommit } from "./order-commits";
import { amendOrder, dropOrder, queueOrder, setOrderPriority } from "./order-lifecycle";
import { isOrderLine, ORDER_LINES } from "./order-line";
import { readyOrders } from "./order-ready";
import { shipOrder } from "./order-ship";
import { orderState } from "./order-state";
import { ORDER_PRIORITIES, type OrderPriority } from "./order-status";
import { dbPath, type Env } from "./paths";
import type { ShipOutcome } from "./ship";
import { runOrderBuildLive } from "./station-build";
import { runOrderPlanLive } from "./station-plan";
import { runOrderReviewLive } from "./station-review";
import { boundStationHarness, type OrderStationName } from "./station-worker";
import { clearRunnerBarrier, registerRunnerBarrier, resolveWorker, withRunnerBarrier } from "./worker";

export const ORDER_USAGE = `usage: dim order add <order-id> --title "..." [--line <${ORDER_LINES.join("|")}>] [--description "..."]
                     [--priority <${ORDER_PRIORITIES.join("|")}>] [--project <owner/repo>]
       dim order ready [--limit <n>] [--project <owner/repo>]
       dim order priority <order-id> <${ORDER_PRIORITIES.join("|")}>
       dim order review <order-id> [--harness <${HARNESSES.join("|")}>]
       dim order plan <order-id> [--harness <${HARNESSES.join("|")}>]
       dim order build <order-id> [--harness <${HARNESSES.join("|")}>]
       dim order approve <order-id> [--reason "..."]   --reason is required on a Build artifact
       dim order return <order-id> --reason "..." [--to plan|build]
       dim order ship <order-id>
       dim order amend <order-id> [--title "..."] [--description "..."]
       dim order drop <order-id> --reason "..."

An order defaults to this checkout's owner/repo, so work belongs to the project it
is built in rather than to wherever the command was typed.`;

const ADD_FLAGS = ["--title", "--line", "--description", "--priority", "--project"];

const fail = (message: string): Error => new UsageError(message);

function namedHarness(given: Map<string, string>): HarnessName | null {
  const named = given.get("--harness");
  return named === undefined ? null : parseHarness(named, fail);
}

function recordedHarness(db: Database, worker: string): HarnessName | null {
  const tool = db
    .query<{ tool: string }, [string]>(
      `SELECT h.tool FROM hook_event h
       JOIN factory_worker w ON w.session_id = h.session_id
       WHERE w.name = ? AND h.event = 'session_start'
       ORDER BY h.ts LIMIT 1`,
    )
    .get(worker)?.tool;
  return isHarness(tool) ? tool : null;
}

function stationHarness(
  db: Database,
  orderId: string,
  station: OrderStationName,
  operator: string,
  named: HarnessName | null,
): HarnessName {
  const harness = named ?? boundStationHarness(db, orderId, station) ?? recordedHarness(db, operator);
  if (harness) return harness;
  throw fail(
    `${operator} runs in no recorded harness session; delegate with --harness <${HARNESSES.join("|")}>`,
  );
}

function flags(args: string[], allowed: string[]): Map<string, string> {
  return readFlags(args, allowed, fail);
}

function required(given: Map<string, string>, flag: string): string {
  return requiredFlag(given, flag, fail);
}

function priority(given: string | undefined): OrderPriority | undefined {
  if (given === undefined) return undefined;
  if (!(ORDER_PRIORITIES as readonly string[]).includes(given)) {
    throw new UsageError(`${given} is not a priority; one of ${ORDER_PRIORITIES.join(", ")}`);
  }
  return given as OrderPriority;
}

function add(
  db: Database,
  orderId: string,
  args: string[],
  defaultProject: string | null,
  worker: string,
): string {
  const given = flags(args, ADD_FLAGS);
  const project = given.get("--project") ?? defaultProject;
  if (!project) throw fail("--project is required outside a checkout with a remote");
  const line = given.get("--line") ?? "feat";
  if (!isOrderLine(line)) throw fail(`${line} is not a line; one of ${ORDER_LINES.join(", ")}`);
  queueOrder(
    db,
    {
      id: orderId,
      project,
      title: required(given, "--title"),
      line,
      description: given.get("--description"),
      priority: priority(given.get("--priority")),
    },
    worker,
  );
  return `queued ${orderId} on ${project}`;
}

const SHIP_OUTCOME_TEXT: Record<ShipOutcome["landed"], string> = {
  already: "already on the default branch",
  fast_forward: "fast-forwarded onto the default branch",
  rebased: "rebased onto the default branch, re-checked and fast-forwarded",
};

function ship(db: Database, orderId: string, cwd: string, env: Env, worker: string, retry: boolean): string {
  const outcome = withRunnerBarrier(db, () => shipOrder(db, orderId, cwd, worker, { env, retry }));
  const kept = [
    outcome.worktreeKept === undefined ? [] : [`worktree kept: ${outcome.worktreeKept}`],
    outcome.branchKept === undefined ? [] : [`branch ${orderId} kept: ${outcome.branchKept}`],
  ].flat();
  return [`${orderId} is ${SHIP_OUTCOME_TEXT[outcome.landed]} and shipped`, ...kept].join("; ");
}

const AMEND_FLAGS = ["--title", "--description"];

function amend(db: Database, orderId: string, args: string[], worker: string): string {
  const given = flags(args, AMEND_FLAGS);
  const title = given.get("--title");
  const description = given.get("--description");
  if (title === undefined && description === undefined) {
    throw fail("amend needs --title or --description; nothing to change is not a call");
  }
  amendOrder(db, orderId, { title, description }, worker);
  return `${orderId} amended`;
}

function drop(db: Database, orderId: string, args: string[], worker: string): string {
  const reason = required(flags(args, ["--reason"]), "--reason");
  dropOrder(db, orderId, reason, worker);
  return `${orderId} is dropped: ${reason}`;
}

export function runOrderCommand(
  db: Database,
  args: string[],
  defaultProject: string | null = null,
  cwd = process.cwd(),
  env: Env = process.env,
): unknown {
  const [command, orderId, ...rest] = args;
  if (command === "ready") {
    const given = flags(
      [orderId, ...rest].filter((one) => one !== undefined),
      ["--limit", "--project"],
    );
    const project = given.get("--project") ?? defaultProject;
    if (!project) throw fail("--project is required outside a checkout with a remote");
    const limit = given.get("--limit");
    if (limit !== undefined && !/^[1-9]\d*$/.test(limit)) throw fail("--limit takes a positive whole number");
    return readyOrders(db, project, limit === undefined ? undefined : Number(limit));
  }
  if (!command || !orderId) throw new UsageError("order takes a subcommand and an order id");
  const worker = resolveWorker(db);
  if (command === "add") return add(db, orderId, rest, defaultProject, worker);
  if (command === "priority") {
    const [level] = rest;
    const chosen = priority(level);
    if (!chosen) throw fail("priority takes the level to set");
    setOrderPriority(db, orderId, chosen, worker);
    return `${orderId} is ${chosen}`;
  }
  if (command === "return") {
    const given = flags(rest, ["--reason", "--to"]);
    const reason = required(given, "--reason");
    const destination = given.get("--to");
    if (destination !== undefined && destination !== "plan" && destination !== "build") {
      throw fail("--to must name plan or build");
    }
    const returned = returnOrder(db, orderId, worker, reason, destination);
    const artifacts = `${returned.join(" and ")} artifact${returned.length === 1 ? "" : "s"}`;
    return `${orderId} ${artifacts} returned to ${returned.at(-1)}`;
  }
  if (command === "approve") {
    const station = approveOrder(db, orderId, worker, flags(rest, ["--reason"]).get("--reason"));
    const approved = `${orderId} ${station} approved by ${worker}`;
    if (station !== "review") return approved;
    return `${approved}; ${ship(db, orderId, cwd, env, worker, false)}`;
  }
  if (command === "ship") {
    flags(rest, []);
    return ship(db, orderId, cwd, env, worker, true);
  }
  if (command === "amend") return amend(db, orderId, rest, worker);
  if (command === "drop") return drop(db, orderId, rest, worker);
  throw new UsageError(`${command} is not an order subcommand`);
}

export async function runRemainingBuilds<T>(
  orderId: string,
  read: () => { waiting: boolean; progress: string },
  run: () => Promise<T>,
): Promise<T> {
  let outcome: T;
  for (;;) {
    const before = read().progress;
    outcome = await run();
    const after = read();
    if (!after.waiting) return outcome;
    if (after.progress === before) {
      throw new Error(`order ${orderId} is still run at build and the turn did not advance`);
    }
  }
}

export async function runOrderCommandLive(
  db: Database,
  args: string[],
  defaultProject: string | null = null,
  cwd = process.cwd(),
  env: Env = process.env,
): Promise<unknown> {
  if (args[0] !== "plan" && args[0] !== "build" && args[0] !== "review")
    return runOrderCommand(db, args, defaultProject, cwd, env);
  const [, orderId, ...rest] = args;
  if (!orderId) throw new UsageError("order takes a subcommand and an order id");
  const given = flags(rest, ["--harness"]);
  const operator = resolveWorker(db);
  assertOperator(db, operator, `delegate ${args[0]}`);
  requireCurrentHooks(env);
  registerRunnerBarrier(db);
  try {
    const harness = stationHarness(db, orderId, args[0], operator, namedHarness(given));
    if (args[0] === "plan") {
      const outcome = await runOrderPlanLive(db, orderId, { dir: cwd, env, harness, parentWorker: operator });
      return `${outcome.body}\n\n---\nPlanner: ${outcome.planner}`;
    }
    if (args[0] === "build") {
      const outcome = await runRemainingBuilds(
        orderId,
        () => {
          const state = orderState(db, orderId);
          return {
            waiting: state.station === "build" && state.next === "run",
            progress: `${nextOrderSlice(db, orderId)?.id ?? "none"}:${latestOrderCommit(db, orderId)?.sha ?? ""}`,
          };
        },
        () => runOrderBuildLive(db, orderId, operator, { dir: cwd, env, harness }),
      );
      return `build completed by ${outcome.builder}`;
    }
    const outcome = await runOrderReviewLive(db, orderId, operator, { dir: cwd, env, harness });
    return outcome.outcome === "aborted"
      ? `review aborted: ${outcome.reviewer} did not finish, so nothing it left is a clean reading; dim order review runs it again`
      : outcome.findings === 0
        ? "review raised no findings; approve the Review artifact to ship"
        : `review raised ${outcome.findings} finding${outcome.findings === 1 ? "" : "s"}; dim order build answers them`;
  } finally {
    clearRunnerBarrier(db);
  }
}

export const orderCommand: Command = {
  name: "order",
  usage: ORDER_USAGE,
  summary: "add, run, approve and ship factory orders",
  async run(args) {
    const root = checkoutRoot(process.cwd());
    const db = openDb(dbPath());
    try {
      return await runOrderCommandLive(db, args, root ? labelFor(root) : null);
    } finally {
      closeDb(db);
    }
  },
};
