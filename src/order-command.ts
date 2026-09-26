import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { type Command, UsageError } from "./cli-contract";
import { readFlags, requiredFlag } from "./cli-flags";
import { closeDb, openDb } from "./db";
import { assertOperator } from "./factory-operator";
import { checkoutRoot } from "./git-checkout";
import { labelFor } from "./git-remote";
import { HARNESSES, type HarnessName, parseHarness } from "./harness-name";
import { recordedHarness } from "./harness-operator";
import { requireCurrentHooks } from "./hooks";
import { approveOrder, returnOrderArtifact } from "./order-approval";
import { recordOrderBuild } from "./order-artifacts";
import { recordOrderCheck, recordOrderCommit, recordOrderDocument, recordOrderFile } from "./order-evidence";
import { amendOrder, dropOrder, queueOrder, setOrderPriority } from "./order-lifecycle";
import { isOrderLine, ORDER_LINES } from "./order-line";
import { readyOrders } from "./order-ready";
import { recordOrderReviewArtifact } from "./order-review";
import { shipOrder } from "./order-ship";
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
       dim order commit <order-id> --sha <sha> [--subject "..."]
       dim order file <order-id> --path <path> [--added <n>] [--removed <n>]
       dim order check <order-id> --command "..." --exit <code> [--result "..."]
       dim order build-artifact <order-id> --body-file <path> --head <sha>
       dim order review-artifact <order-id> --body "..."
       dim order review <order-id> [--harness <${HARNESSES.join("|")}>]
       dim order document <order-id> --path <path>
       dim order plan <order-id> [--harness <${HARNESSES.join("|")}>]
       dim order build <order-id> [--harness <${HARNESSES.join("|")}>]
       dim order approve <order-id> [--reason "..."]
       dim order return <order-id> --reason "..."
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

function markdownBody(value: string): string {
  return value.replaceAll("\\r\\n", "\n").replaceAll("\\n", "\n").replaceAll("\\r", "\r");
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

function exitCode(given: Map<string, string>): number {
  const spec = required(given, "--exit");
  if (!/^-?\d+$/.test(spec)) throw new UsageError(`--exit ${spec} is not an exit code`);
  return Number(spec);
}

function lineCount(given: Map<string, string>, flag: string): number | undefined {
  const spec = given.get(flag);
  if (spec === undefined || spec === "-") return undefined;
  if (!/^\d+$/.test(spec)) throw new UsageError(`${flag} ${spec} is not a line count`);
  return Number(spec);
}

type Evidence = {
  flags: string[];
  record: (db: Database, id: string, given: Map<string, string>, worker: string) => string;
};

const EVIDENCE: Record<string, Evidence> = {
  commit: {
    flags: ["--sha", "--subject"],
    record: (db, id, given, worker) => {
      const sha = required(given, "--sha");
      recordOrderCommit(db, id, sha, worker, given.get("--subject"));
      return `${id} recorded commit ${sha}`;
    },
  },
  file: {
    flags: ["--path", "--added", "--removed"],
    record: (db, id, given, worker) => {
      const path = required(given, "--path");
      const added = lineCount(given, "--added");
      const removed = lineCount(given, "--removed");
      recordOrderFile(db, id, { path, added, removed }, worker);
      const counted =
        added === undefined && removed === undefined ? "" : ` (+${added ?? 0}/-${removed ?? 0})`;
      return `${id} recorded ${path}${counted}`;
    },
  },
  check: {
    flags: ["--command", "--exit", "--result"],
    record: (db, id, given, worker) => {
      const command = required(given, "--command");
      const code = exitCode(given);
      recordOrderCheck(db, id, { command, exitCode: code, result: given.get("--result") }, worker);
      return `${id} recorded ${command} (${code})`;
    },
  },
  "build-artifact": {
    flags: ["--body", "--body-file", "--head"],
    record: (db, id, given, worker) => {
      const body = given.get("--body");
      const bodyFile = given.get("--body-file");
      if ((body === undefined) === (bodyFile === undefined)) {
        throw new UsageError("provide exactly one of --body or --body-file");
      }
      const artifactId = recordOrderBuild(
        db,
        id,
        body === undefined ? readFileSync(bodyFile as string, "utf8") : markdownBody(body),
        required(given, "--head"),
        worker,
      );
      return `${id} recorded Build artifact ${artifactId}`;
    },
  },
  "review-artifact": {
    flags: ["--body"],
    record: (db, id, given, worker) => {
      const artifactId = recordOrderReviewArtifact(db, id, markdownBody(required(given, "--body")), worker);
      return `${id} recorded Review artifact ${artifactId}`;
    },
  },
  document: {
    flags: ["--path"],
    record: (db, id, given, worker) => {
      const path = required(given, "--path");
      recordOrderDocument(db, id, path, worker);
      return `${id} recorded ${path}`;
    },
  },
};

const SHIP_OUTCOME_TEXT: Record<ShipOutcome["landed"], string> = {
  already: "already on the trunk",
  fast_forward: "fast-forwarded onto the trunk",
  rebased: "rebased onto the trunk, re-checked and fast-forwarded",
};

function ship(db: Database, orderId: string, args: string[], cwd: string, env: Env, worker: string): string {
  flags(args, []);
  const outcome = shipOrder(db, orderId, cwd, worker, { env });
  return `${orderId} is ${SHIP_OUTCOME_TEXT[outcome.landed]} and done`;
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
    const reason = required(flags(rest, ["--reason"]), "--reason");
    const station = returnOrderArtifact(db, orderId, worker, reason);
    return `${orderId} ${station} artifact returned to its worker`;
  }
  if (command === "approve") {
    const station = approveOrder(db, orderId, worker, flags(rest, ["--reason"]).get("--reason"));
    const approved = `${orderId} ${station} approved by ${worker}`;
    if (station !== "review") return approved;
    return `${approved}; ${ship(db, orderId, [], cwd, env, worker)}`;
  }
  if (Object.hasOwn(EVIDENCE, command)) {
    const evidence = EVIDENCE[command] as Evidence;
    return evidence.record(db, orderId, flags(rest, evidence.flags), worker);
  }
  if (command === "ship") return ship(db, orderId, rest, cwd, env, worker);
  if (command === "amend") return amend(db, orderId, rest);
  if (command === "drop") return drop(db, orderId, rest, worker);
  throw new UsageError(`${command} is not an order subcommand`);
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
    requireCurrentHooks(env);
    const outcome = await runOrderPlanLive(db, orderId, { dir: cwd, env, harness });
    return `${outcome.body}\n\n---\nPlanner: ${outcome.planner}`;
  }
  if (args[0] === "build") {
    const outcome = await runOrderBuildLive(db, orderId, operator, { dir: cwd, env, harness });
    return `build completed by ${outcome.builder}`;
  }
  const outcome = await runOrderReviewLive(db, orderId, operator, { dir: cwd, env, harness });
  return outcome.outcome === "aborted"
    ? `review ${outcome.review} aborted: ${outcome.reviewer} did not finish, so nothing it left is a clean reading`
    : `review ${outcome.review} closed with ${outcome.findings} finding${outcome.findings === 1 ? "" : "s"}`;
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
