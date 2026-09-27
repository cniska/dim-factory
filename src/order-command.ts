import type { Database } from "bun:sqlite";
import { type Command, UsageError } from "./cli-contract";
import { readFlags, requiredFlag } from "./cli-flags";
import { closeDb, openDb } from "./db";
import { assertOperator } from "./factory-operator";
import { checkoutRoot } from "./git-checkout";
import { labelFor } from "./git-remote";
import { HARNESSES, type HarnessName, parseHarness } from "./harness-name";
import { recordedHarness } from "./harness-operator";
import { requireCurrentHooks } from "./hooks";
import { approveOrder, returnApprovedPlan, returnOrderArtifact, returnReviewToBuild } from "./order-approval";
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
import { resolveWorker } from "./worker";
import { resolveAssignedWorker } from "./worker-assignment";

export const ORDER_USAGE = `usage: dim order add <order-id> --title "..." [--line <${ORDER_LINES.join("|")}>] [--description "..."]
                     [--priority <${ORDER_PRIORITIES.join("|")}>] [--project <owner/repo>]
       dim order ready [--limit <n>] [--project <owner/repo>]
       dim order priority <order-id> <${ORDER_PRIORITIES.join("|")}>
       dim order review <order-id> [--harness <${HARNESSES.join("|")}>]
       dim order plan <order-id> [--harness <${HARNESSES.join("|")}>]
       dim order build <order-id> [--harness <${HARNESSES.join("|")}>]
       dim order approve <order-id> [--reason "..."]
       dim order return <order-id> --reason "..." [--to plan|build]
       dim order ship <order-id>
       dim order amend <order-id> [--title "..."] [--description "..."]
       dim order drop <order-id> --reason "..."

An order defaults to this checkout's owner/repo, so work belongs to the project it
is built in rather than to wherever the command was typed.`;

const ADD_FLAGS = ["--title", "--line", "--description", "--priority", "--project"];

const fail = (message: string): Error => new UsageError(message);

function selectedHarness(db: Database, given: Map<string, string>, operator: string): HarnessName {
  const named = given.get("--harness");
  if (named !== undefined) return parseHarness(named, fail);
  const recorded = recordedHarness(db, operator);
  if (recorded) return recorded;
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

function ship(db: Database, orderId: string, args: string[], cwd: string, env: Env, worker: string): string {
  flags(args, []);
  const outcome = shipOrder(db, orderId, cwd, worker, { env });
  return `${orderId} is ${SHIP_OUTCOME_TEXT[outcome.landed]} and shipped`;
}

const AMEND_FLAGS = ["--title", "--description"];

function amend(db: Database, orderId: string, args: string[]): string {
  const given = flags(args, AMEND_FLAGS);
  const title = given.get("--title");
  const description = given.get("--description");
  if (title === undefined && description === undefined) {
    throw fail("amend needs --title or --description; nothing to change is not a call");
  }
  amendOrder(db, orderId, { title, description });
  return `${orderId} amended`;
}

function drop(db: Database, orderId: string, args: string[], worker: string): string {
  assertOperator(db, worker, "drop an order");
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
  const worker = env.DIM_WORKER_ASSIGNMENT_ID ? resolveAssignedWorker(db, env) : resolveWorker(db, env);
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
    if (destination === "plan") {
      returnApprovedPlan(db, orderId, worker, reason);
      return `${orderId} approved plan returned to its planner`;
    }
    if (destination === "build") {
      returnReviewToBuild(db, orderId, worker, reason);
      return `${orderId} review returned to its builder`;
    }
    if (destination !== undefined) throw fail("--to must name plan or build");
    const station = returnOrderArtifact(db, orderId, worker, reason);
    return `${orderId} ${station} artifact returned to its worker`;
  }
  if (command === "approve") {
    const station = approveOrder(db, orderId, worker, flags(rest, ["--reason"]).get("--reason"));
    const approved = `${orderId} ${station} approved by ${worker}`;
    if (station !== "review") return approved;
    return `${approved}; ${ship(db, orderId, [], cwd, env, worker)}`;
  }
  if (command === "ship") return ship(db, orderId, rest, cwd, env, worker);
  if (command === "amend") return amend(db, orderId, rest);
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
  const operator = resolveWorker(db, env);
  const harness = selectedHarness(db, given, operator);
  if (args[0] === "plan") {
    assertOperator(db, operator, "delegate planning");
    requireCurrentHooks(env);
    const outcome = await runOrderPlanLive(db, orderId, { dir: cwd, env, harness });
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
