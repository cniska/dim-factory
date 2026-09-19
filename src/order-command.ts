import type { Database } from "bun:sqlite";
import {
  appendOrderEvent,
  claimOrder,
  isOrderRole,
  moveOrder,
  ORDER_PRIORITIES,
  ORDER_ROLES,
  type OrderEventKind,
  type OrderPriority,
  type OrderRole,
  type OrderStatus,
  queueOrder,
  recordOrderCheck,
  recordOrderCommit,
  recordOrderDocument,
  recordOrderFile,
  recordOrderFinding,
  setOrderFence,
  setOrderPriority,
} from "./factory-order";
import { readFlags, requiredFlag } from "./flags";
import { fencedOrders, readyOrders } from "./order-ready";

export class OrderCommandError extends Error {}

export const ORDER_USAGE = `usage: dim order add <order-id> --title "..." [--description "..."]
                     [--priority <${ORDER_PRIORITIES.join("|")}>] [--fence "..."] [--project <owner/repo>]
       dim order ready [--limit <n>] [--project <owner/repo>]
       dim order claim <order-id> --run <id> [--agent <id>] [--role <planner|builder|reviewer>]
                      [--session <id>] [--station <name>]
       dim order priority <order-id> <${ORDER_PRIORITIES.join("|")}>
       dim order fence <order-id> --reason "..."
       dim order release <order-id>
       dim order move <order-id> --station <name>
       dim order commit <order-id> --sha <sha> [--subject "..."]
       dim order file <order-id> --path <path> [--added <n>] [--removed <n>]
       dim order check <order-id> --command "..." --exit <code> [--result "..."]
       dim order finding <order-id> --dimension <name> --summary "..." --answer <fixed|refused>
                       [--resolution "..."]
       dim order document <order-id> --path <path>
       dim order stop <order-id> <completed|failed> [--reason "..."]

An order defaults to this checkout's owner/repo, so work belongs to the project it
is built in rather than to wherever the command was typed.`;

const CLAIM_FLAGS = ["--run", "--agent", "--role", "--session", "--station"];
const ADD_FLAGS = ["--title", "--description", "--priority", "--fence", "--project"];

const fail = (message: string): Error => new OrderCommandError(message);

function flags(args: string[], allowed: string[]): Map<string, string> {
  return readFlags(args, allowed, fail);
}

function required(given: Map<string, string>, flag: string): string {
  return requiredFlag(given, flag, fail);
}

/**
 * What the worker was called in as, which the operator knows when it spawns one and
 * nothing downstream can recover: a station says where the work is, never who holds it.
 */
function role(given: string | undefined): OrderRole | undefined {
  if (given === undefined) return undefined;
  if (!isOrderRole(given)) {
    throw new OrderCommandError(
      `${given} is not a role a worker holds an order as; one of ${ORDER_ROLES.join(", ")}`,
    );
  }
  return given;
}

function priority(given: string | undefined): OrderPriority | undefined {
  if (given === undefined) return undefined;
  if (!(ORDER_PRIORITIES as readonly string[]).includes(given)) {
    throw new OrderCommandError(`${given} is not a priority; one of ${ORDER_PRIORITIES.join(", ")}`);
  }
  return given as OrderPriority;
}

function add(db: Database, orderId: string, args: string[], defaultProject: string | null): string {
  const given = flags(args, ADD_FLAGS);
  const project = given.get("--project") ?? defaultProject;
  if (!project) throw fail("--project is required outside a checkout with a remote");
  queueOrder(db, {
    id: orderId,
    project,
    title: required(given, "--title"),
    description: given.get("--description"),
    priority: priority(given.get("--priority")),
    fence: given.get("--fence"),
  });
  return `queued ${orderId} on ${project}`;
}

function claim(db: Database, orderId: string, args: string[]): string {
  const given = flags(args, CLAIM_FLAGS);
  claimOrder(db, orderId, {
    runId: required(given, "--run"),
    agentId: given.get("--agent"),
    role: role(given.get("--role")),
    sessionId: given.get("--session"),
    station: given.get("--station"),
  });
  return `${orderId} is working`;
}

/**
 * Read as digits rather than through `Number`, which turns "" and " " into 0 and
 * "1e3" into 1000: a check that never ran would be recorded as one that passed.
 */
function exitCode(given: Map<string, string>): number {
  const spec = required(given, "--exit");
  if (!/^-?\d+$/.test(spec)) throw new OrderCommandError(`--exit ${spec} is not an exit code`);
  return Number(spec);
}

/**
 * A count git reported, read as digits for the same reason an exit code is: a
 * line that says `-`, which is what numstat gives for a binary file, is not zero
 * lines changed and is recorded as no count at all.
 */
function lineCount(given: Map<string, string>, flag: string): number | undefined {
  const spec = given.get(flag);
  if (spec === undefined || spec === "-") return undefined;
  if (!/^\d+$/.test(spec)) throw new OrderCommandError(`${flag} ${spec} is not a line count`);
  return Number(spec);
}

function answer(given: Map<string, string>): "fixed" | "refused" {
  const value = required(given, "--answer");
  if (value !== "fixed" && value !== "refused") {
    throw new OrderCommandError(`${value} is not an answer a finding can end on`);
  }
  return value;
}

/**
 * Each of these records one row and returns what it wrote, because the caller is a
 * skill reading its own shell output back rather than a caller holding a value.
 */
type Evidence = {
  flags: string[];
  record: (db: Database, id: string, given: Map<string, string>) => string;
};

const EVIDENCE: Record<string, Evidence> = {
  commit: {
    flags: ["--sha", "--subject"],
    record: (db, id, given) => {
      const sha = required(given, "--sha");
      recordOrderCommit(db, id, sha, given.get("--subject"));
      return `${id} recorded commit ${sha}`;
    },
  },
  file: {
    flags: ["--path", "--added", "--removed"],
    record: (db, id, given) => {
      const path = required(given, "--path");
      const added = lineCount(given, "--added");
      const removed = lineCount(given, "--removed");
      recordOrderFile(db, id, { path, added, removed });
      const counted =
        added === undefined && removed === undefined ? "" : ` (+${added ?? 0}/-${removed ?? 0})`;
      return `${id} recorded ${path}${counted}`;
    },
  },
  check: {
    flags: ["--command", "--exit", "--result"],
    record: (db, id, given) => {
      const command = required(given, "--command");
      const code = exitCode(given);
      recordOrderCheck(db, id, { command, exitCode: code, result: given.get("--result") });
      return `${id} recorded ${command} (${code})`;
    },
  },
  finding: {
    flags: ["--dimension", "--summary", "--answer", "--resolution"],
    record: (db, id, given) => {
      const dimension = required(given, "--dimension");
      const ended = answer(given);
      recordOrderFinding(db, id, {
        dimension,
        summary: required(given, "--summary"),
        answer: ended,
        resolution: given.get("--resolution"),
      });
      return `${id} recorded a ${ended} finding on ${dimension}`;
    },
  },
  document: {
    flags: ["--path"],
    record: (db, id, given) => {
      const path = required(given, "--path");
      recordOrderDocument(db, id, path);
      return `${id} recorded ${path}`;
    },
  },
};

/** How an order can stop: it landed, or it did not and goes back among the work
 *  nobody holds, carrying why. */
const STOP_KINDS = ["completed", "failed"] as const;

function stop(db: Database, orderId: string, args: string[], worktree: string): string {
  const [kind, ...rest] = args;
  if (!kind) throw new OrderCommandError("stop needs how the order stopped");
  if (!(STOP_KINDS as readonly string[]).includes(kind)) {
    throw new OrderCommandError(`${kind} is not a way an order can stop`);
  }
  const given = flags(rest, ["--reason"]);
  appendOrderEvent(
    db,
    orderId,
    {
      kind: kind as OrderEventKind,
      ...(kind === "completed" ? { status: "completed" as OrderStatus } : {}),
      reason: given.get("--reason"),
    },
    undefined,
    worktree,
  );
  return kind === "completed" ? `${orderId} is completed` : `${orderId} is queued again`;
}

export function runOrderCommand(
  db: Database,
  args: string[],
  defaultProject: string | null = null,
  worktree = process.cwd(),
): string {
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
    // JSON because a station reads this rather than a person: an order's own words reach
    // the worker unedited only if nothing in between reformats them.
    return JSON.stringify(
      {
        ready: readyOrders(db, project, limit === undefined ? undefined : Number(limit)),
        fenced: fencedOrders(db, project),
      },
      null,
      2,
    );
  }
  if (!command || !orderId) throw new OrderCommandError("order takes a subcommand and an order id");
  if (command === "add") return add(db, orderId, rest, defaultProject);
  if (command === "claim") return claim(db, orderId, rest);
  if (command === "priority") {
    const [level] = rest;
    const chosen = priority(level);
    if (!chosen) throw fail("priority takes the level to set");
    setOrderPriority(db, orderId, chosen);
    return `${orderId} is ${chosen}`;
  }
  if (command === "fence") {
    const reason = required(flags(rest, ["--reason"]), "--reason");
    setOrderFence(db, orderId, reason);
    return `${orderId} is fenced: ${reason}`;
  }
  if (command === "release") {
    flags(rest, []);
    setOrderFence(db, orderId, null);
    return `${orderId} is released`;
  }
  if (command === "move") {
    const station = required(flags(rest, ["--station"]), "--station");
    moveOrder(db, orderId, station);
    return `${orderId} moved to ${station}`;
  }
  // Own property only: an object literal inherits `toString` and `constructor`, and
  // `dim order toString` would reach one instead of the refusal every other name gets.
  if (Object.hasOwn(EVIDENCE, command)) {
    const evidence = EVIDENCE[command] as Evidence;
    return evidence.record(db, orderId, flags(rest, evidence.flags));
  }
  if (command === "stop") return stop(db, orderId, rest, worktree);
  throw new OrderCommandError(`${command} is not an order subcommand`);
}
