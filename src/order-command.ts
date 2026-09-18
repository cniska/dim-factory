import type { Database } from "bun:sqlite";
import {
  appendOrderEvent,
  createOrder,
  isOrderRole,
  isTerminalOrderStatus,
  moveOrder,
  ORDER_ROLES,
  type OrderEventKind,
  type OrderRole,
  type OrderStatus,
  recordOrderCheck,
  recordOrderCommit,
  recordOrderDocument,
  recordOrderFile,
  recordOrderFinding,
  TERMINAL_ORDER_STATUSES,
} from "./factory-order";

export class OrderCommandError extends Error {}

export const ORDER_USAGE = `usage: dim order claim <order-id> --run <id> --queue <id> --item <id> --title "..."
                      [--description "..."] [--agent <id>] [--role <planner|builder|reviewer>]
                      [--session <id>] [--station <name>]
                      [--worktree <path>] [--branch <name>]
       dim order start <order-id>
       dim order move <order-id> --station <name>
       dim order commit <order-id> --sha <sha> [--subject "..."]
       dim order file <order-id> --path <path>
       dim order check <order-id> --command "..." --exit <code> [--result "..."]
       dim order finding <order-id> --dimension <name> --summary "..." --answer <fixed|refused>
                       [--resolution "..."]
       dim order document <order-id> --path <path>
       dim order stop <order-id> <${TERMINAL_ORDER_STATUSES.join("|")}> [--reason "..."]`;

const CLAIM_FLAGS = [
  "--run",
  "--queue",
  "--item",
  "--title",
  "--description",
  "--agent",
  "--role",
  "--session",
  "--station",
  "--worktree",
  "--branch",
];

/**
 * A flag given twice is refused rather than resolved to either value: a skill
 * assembles these from a shell line, and a title that silently lost half of
 * itself reads on the wall as an order nobody can match back to its item.
 */
function flags(args: string[], allowed: string[]): Map<string, string> {
  const given = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] as string;
    const value = args[index + 1];
    if (!allowed.includes(flag)) throw new OrderCommandError(`${flag} is not an option this takes`);
    if (value === undefined) throw new OrderCommandError(`${flag} needs a value`);
    // A value that reads as a flag is refused rather than taken, so a missing
    // argument cannot quietly consume the next option as its own text.
    if (value.startsWith("--")) throw new OrderCommandError(`${flag} needs a value that is not an option`);
    if (given.has(flag)) throw new OrderCommandError(`${flag} may be given once`);
    given.set(flag, value);
  }
  return given;
}

function required(given: Map<string, string>, flag: string): string {
  const value = given.get(flag);
  if (value === undefined) throw new OrderCommandError(`${flag} is required`);
  return value;
}

/**
 * What the worker was called in as, which the driver knows when it spawns one and
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

function claim(db: Database, orderId: string, args: string[]): string {
  const given = flags(args, CLAIM_FLAGS);
  const itemId = required(given, "--item");
  const queueId = required(given, "--queue");
  createOrder(db, {
    id: orderId,
    runId: required(given, "--run"),
    queueId,
    itemId,
    title: required(given, "--title"),
    description: given.get("--description"),
    agentId: given.get("--agent"),
    role: role(given.get("--role")),
    sessionId: given.get("--session"),
    worktree: given.get("--worktree"),
    branch: given.get("--branch"),
    station: given.get("--station"),
  });
  return `claimed ${orderId} for ${itemId} on ${queueId}`;
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
    flags: ["--path"],
    record: (db, id, given) => {
      const path = required(given, "--path");
      recordOrderFile(db, id, path);
      return `${id} recorded ${path}`;
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

function stop(db: Database, orderId: string, args: string[]): string {
  const [status, ...rest] = args;
  if (!status) throw new OrderCommandError("stop needs the status the order stopped at");
  const terminal = status as OrderStatus;
  if (!isTerminalOrderStatus(terminal)) {
    throw new OrderCommandError(`${status} is not a status an order can stop at`);
  }
  const given = flags(rest, ["--reason"]);
  appendOrderEvent(db, orderId, {
    kind: terminal as OrderEventKind,
    status: terminal,
    reason: given.get("--reason"),
  });
  return `${orderId} stopped as ${terminal}`;
}

export function runOrderCommand(db: Database, args: string[]): string {
  const [command, orderId, ...rest] = args;
  if (!command || !orderId) throw new OrderCommandError("order takes a subcommand and an order id");
  if (command === "claim") return claim(db, orderId, rest);
  if (command === "start") {
    flags(rest, []);
    appendOrderEvent(db, orderId, { kind: "started", status: "running" });
    return `${orderId} is running`;
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
  if (command === "stop") return stop(db, orderId, rest);
  throw new OrderCommandError(`${command} is not an order subcommand`);
}
