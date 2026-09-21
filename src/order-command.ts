import type { Database } from "bun:sqlite";
import { assertOperator } from "./factory-operator";
import {
  amendOrder,
  answerOrderFinding,
  appendOrderEvent,
  approveOrderBuild,
  approveOrderPlan,
  approveOrderReview,
  claimOrder,
  dropOrder,
  moveOrder,
  ORDER_PRIORITIES,
  type OrderEventKind,
  type OrderPriority,
  type OrderStatus,
  queueOrder,
  raiseOrderFinding,
  recordOrderCheck,
  recordOrderCommit,
  recordOrderDocument,
  recordOrderFile,
  setOrderHold,
  setOrderPriority,
  shipOrder,
} from "./factory-order";
import { resolveWorker } from "./factory-worker";
import { readFlags, requiredFlag } from "./flags";
import { requireCurrentHooks } from "./hooks";
import { runOrderBuild } from "./order-build";
import { runOrderPlan } from "./order-plan";
import { heldOrders, readyOrders } from "./order-ready";
import { runOrderReview } from "./order-review";
import type { Env } from "./paths";
import { removeWorktree, repoRoot } from "./wt-command";

export class OrderCommandError extends Error {}

export const ORDER_USAGE = `usage: dim order add <order-id> --title "..." [--description "..."]
                     [--priority <${ORDER_PRIORITIES.join("|")}>] [--hold "..."] [--project <owner/repo>]
       dim order ready [--limit <n>] [--project <owner/repo>]
       dim order claim <order-id> --run <id> [--session <id>] [--station <name>]
       dim order priority <order-id> <${ORDER_PRIORITIES.join("|")}>
       dim order hold <order-id> --reason "..."
       dim order release <order-id>
       dim order move <order-id> --station <name>
       dim order commit <order-id> --sha <sha> [--subject "..."]
       dim order file <order-id> --path <path> [--added <n>] [--removed <n>]
       dim order check <order-id> --command "..." --exit <code> [--result "..."]
       dim order review <order-id>
       dim order finding <order-id> --dimension <name> --summary "..."
       dim order answer <finding-id> --answer <fixed|refused>
                       [--resolution "..."]
       dim order document <order-id> --path <path>
       dim order plan <order-id>
       dim order build <order-id>
       dim order approve <order-id>
       dim order approve-build <order-id> --reason "..."
       dim order approve-review <order-id>
       dim order ship <order-id>
       dim order stop <order-id> <completed|failed> [--reason "..."]
       dim order amend <order-id> [--title "..."] [--description "..."]
       dim order drop <order-id> --reason "..."

An order defaults to this checkout's owner/repo, so work belongs to the project it
is built in rather than to wherever the command was typed.`;

const CLAIM_FLAGS = ["--run", "--session", "--station"];
const ADD_FLAGS = ["--title", "--description", "--priority", "--hold", "--project"];

const fail = (message: string): Error => new OrderCommandError(message);

function flags(args: string[], allowed: string[]): Map<string, string> {
  return readFlags(args, allowed, fail);
}

function required(given: Map<string, string>, flag: string): string {
  return requiredFlag(given, flag, fail);
}

function priority(given: string | undefined): OrderPriority | undefined {
  if (given === undefined) return undefined;
  if (!(ORDER_PRIORITIES as readonly string[]).includes(given)) {
    throw new OrderCommandError(`${given} is not a priority; one of ${ORDER_PRIORITIES.join(", ")}`);
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
  queueOrder(
    db,
    {
      id: orderId,
      project,
      title: required(given, "--title"),
      description: given.get("--description"),
      priority: priority(given.get("--priority")),
      hold: given.get("--hold"),
    },
    worker,
  );
  return `queued ${orderId} on ${project}`;
}

/**
 * Everything the order records after this is written by a session hook, so a run started
 * behind one that is missing or out of date leaves an order with no evidence under it and
 * nothing says so until the record is read. The claim is where a run begins and the one
 * place that can stop it, so the machine is read here rather than after work has started.
 */
function claim(db: Database, orderId: string, args: string[], worker: string, env: Env, cwd: string): string {
  const given = flags(args, CLAIM_FLAGS);
  requireCurrentHooks(env);
  claimOrder(
    db,
    orderId,
    {
      runId: required(given, "--run"),
      sessionId: given.get("--session"),
      station: given.get("--station"),
    },
    worker,
    undefined,
    cwd,
  );
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
  finding: {
    flags: ["--dimension", "--summary"],
    record: (db, id, given, worker) => {
      const dimension = required(given, "--dimension");
      const raised = raiseOrderFinding(db, id, { dimension, summary: required(given, "--summary") }, worker);
      return `${id} raised finding ${raised} on ${dimension}`;
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

const SHIP_OUTCOME_TEXT: Record<string, string> = {
  already: "already on the trunk",
  fast_forward: "fast-forwarded onto the trunk",
  merged: "merged onto the trunk",
};

function ship(db: Database, orderId: string, args: string[], worktree: string, env: Env): string {
  flags(args, []);
  const outcome = shipOrder(db, orderId, worktree, env);
  return `${orderId} is ${SHIP_OUTCOME_TEXT[outcome.landed]}`;
}

/** How an order can stop: it landed, or it did not and goes back among the work
 *  nobody holds, carrying why. */
const STOP_KINDS = ["completed", "failed"] as const;

/**
 * The completion gate is answered from the primary checkout rather than from the order's
 * own worktree: whether a commit reaches the trunk is a fact about the repository, and
 * `refs/remotes/origin/HEAD` and the trunk branch are shared by every worktree of it. A
 * worktree is one place that fact can be read from and the one place that can be missing —
 * an order worked in the primary checkout never had one, and a completed order's is removed
 * a line below — so reading it there would refuse an order that had plainly landed.
 */
function stop(db: Database, orderId: string, args: string[], cwd: string, worker: string): string {
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
      worker,
      ...(kind === "completed" ? { status: "completed" as OrderStatus } : {}),
      reason: given.get("--reason"),
    },
    undefined,
    repoRoot(cwd),
  );
  // Completing an order lands everything it will, so its worktree is gone; failing
  // one keeps it, because it may hold work no commit has and is claimed again in place.
  if (kind === "completed") removeWorktree(orderId, { cwd });
  return kind === "completed" ? `${orderId} is completed` : `${orderId} is queued again`;
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
  const reason = required(flags(args, ["--reason"]), "--reason");
  dropOrder(db, orderId, reason, worker);
  return `${orderId} is dropped: ${reason}`;
}

/** Named by the finding rather than the order, because answering is a reply to one thing
 *  a reviewer said and an order may be carrying several. */
function answerFinding(
  db: Database,
  findingSpec: string | undefined,
  args: string[],
  worker: string,
): string {
  if (findingSpec === undefined || !/^[1-9]\d*$/.test(findingSpec)) {
    throw fail("answer names the finding it replies to: `dim order answer <finding-id> --answer ...`");
  }
  const given = flags(args, ["--answer", "--resolution"]);
  const ended = answer(given);
  answerOrderFinding(
    db,
    Number(findingSpec),
    { answer: ended, resolution: given.get("--resolution") },
    worker,
  );
  return `finding ${findingSpec} is ${ended}`;
}

export function runOrderCommand(
  db: Database,
  args: string[],
  defaultProject: string | null = null,
  cwd = process.cwd(),
  env: Env = process.env,
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
        held: heldOrders(db, project),
      },
      null,
      2,
    );
  }
  if (!command || !orderId) throw new OrderCommandError("order takes a subcommand and an order id");
  // Resolved once, before anything is written: every act below records who did it, and a
  // caller that cannot say is refused here rather than writing a moment nobody did.
  const worker = resolveWorker(db, env);
  if (command === "add") return add(db, orderId, rest, defaultProject, worker);
  if (command === "claim") return claim(db, orderId, rest, worker, env, cwd);
  if (command === "priority") {
    const [level] = rest;
    const chosen = priority(level);
    if (!chosen) throw fail("priority takes the level to set");
    setOrderPriority(db, orderId, chosen);
    return `${orderId} is ${chosen}`;
  }
  if (command === "hold") {
    const reason = required(flags(rest, ["--reason"]), "--reason");
    setOrderHold(db, orderId, reason);
    return `${orderId} is held: ${reason}`;
  }
  if (command === "release") {
    flags(rest, []);
    setOrderHold(db, orderId, null);
    return `${orderId} is released`;
  }
  if (command === "move") {
    const station = required(flags(rest, ["--station"]), "--station");
    moveOrder(db, orderId, station, worker);
    return `${orderId} moved to ${station}`;
  }
  if (command === "plan") {
    flags(rest, []);
    assertOperator(db, worker, "delegate planning");
    const outcome = runOrderPlan(db, orderId, { env });
    return `${orderId} planning completed by ${outcome.planner}`;
  }
  if (command === "build") {
    flags(rest, []);
    const outcome = runOrderBuild(db, orderId, worker, { dir: cwd, env });
    return `${orderId} building started by ${outcome.builder}`;
  }
  if (command === "approve") {
    flags(rest, []);
    approveOrderPlan(db, orderId, worker);
    return `${orderId} plan approved by ${worker}`;
  }
  if (command === "approve-build") {
    const reason = required(flags(rest, ["--reason"]), "--reason");
    approveOrderBuild(db, orderId, worker, reason);
    return `${orderId} build approved by ${worker}`;
  }
  if (command === "approve-review") {
    flags(rest, []);
    approveOrderReview(db, orderId, worker);
    return `${orderId} review approved by ${worker}`;
  }
  // Own property only: an object literal inherits `toString` and `constructor`, and
  // `dim order toString` would reach one instead of the refusal every other name gets.
  if (Object.hasOwn(EVIDENCE, command)) {
    const evidence = EVIDENCE[command] as Evidence;
    return evidence.record(db, orderId, flags(rest, evidence.flags), worker);
  }
  if (command === "ship") return ship(db, orderId, rest, cwd, env);
  if (command === "stop") return stop(db, orderId, rest, cwd, worker);
  if (command === "amend") return amend(db, orderId, rest);
  if (command === "drop") return drop(db, orderId, rest, worker);
  if (command === "answer") return answerFinding(db, orderId, rest, worker);
  if (command === "review") {
    if (!orderId) throw fail("review takes the order whose slice is to be read");
    assertOperator(db, worker, "delegate review");
    const done = runOrderReview(db, orderId, worker, { dir: cwd, env });
    return done.outcome === "aborted"
      ? `review ${done.review} aborted: ${done.reviewer} did not finish, so nothing it left is a clean reading`
      : `review ${done.review} closed with ${done.findings} finding${done.findings === 1 ? "" : "s"}`;
  }
  throw new OrderCommandError(`${command} is not an order subcommand`);
}
