import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { assertOperator } from "./factory-operator";
import {
  amendOrder,
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
  recordOrderBuild,
  recordOrderCheck,
  recordOrderCommit,
  recordOrderDocument,
  recordOrderFile,
  recordOrderReviewArtifact,
  recoverOrderFailure,
  returnOrderArtifact,
  setOrderHold,
  setOrderPriority,
  shipOrder,
} from "./factory-order";
import { resolveWorker } from "./factory-worker";
import { readFlags, requiredFlag } from "./flags";
import { HARNESSES, type HarnessName, parseHarness } from "./harness-name";
import { requireCurrentHooks } from "./hooks";
import { recordedHarness } from "./operator-harness";
import { runOrderBuildLive } from "./order-build";
import { recordOwnerRuling } from "./order-finding";
import { isOrderLine, ORDER_LINES } from "./order-line";
import { runOrderPlan, runOrderPlanLive } from "./order-plan";
import { heldOrders, readyOrders } from "./order-ready";
import { runOrderReview, runOrderReviewLive } from "./order-review";
import type { Env } from "./paths";
import type { ShipOutcome } from "./ship";
import { resolveAssignedWorker } from "./worker-assignment";
import { removeWorktree, repoRoot } from "./wt-command";

export class OrderCommandError extends Error {}

export const ORDER_USAGE = `usage: dim order add <order-id> --title "..." [--line <${ORDER_LINES.join("|")}>] [--description "..."]
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
       dim order build-artifact <order-id> --body-file <path> --head <sha>
       dim order review-artifact <order-id> --body "..."
       dim order review <order-id> [--harness <${HARNESSES.join("|")}>]
       dim order rule <finding-id> --uphold|--overturn --reason "..."
       dim order document <order-id> --path <path>
       dim order plan <order-id> [--harness <${HARNESSES.join("|")}>]
       dim order build <order-id> [--harness <${HARNESSES.join("|")}>]
       dim order approve <order-id>
       dim order approve <order-id> [--reason "..."]
       dim order return <order-id> --reason "..."
       dim order ship <order-id>
       dim order stop <order-id> <completed|failed> [--reason "..."]
       dim order amend <order-id> [--title "..."] [--description "..."]
       dim order drop <order-id> --reason "..."

An order defaults to this checkout's owner/repo, so work belongs to the project it
is built in rather than to wherever the command was typed.`;

const CLAIM_FLAGS = ["--run", "--session", "--station"];
const ADD_FLAGS = ["--title", "--line", "--description", "--priority", "--hold", "--project"];

const fail = (message: string): Error => new OrderCommandError(message);

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
      hold: given.get("--hold"),
    },
    worker,
  );
  return `queued ${orderId} on ${project}`;
}

function claim(db: Database, orderId: string, args: string[], worker: string, env: Env, cwd: string): string {
  const given = flags(args, CLAIM_FLAGS);
  assertOperator(db, worker, "claim an order");
  requireCurrentHooks(env);
  claimOrder(
    db,
    orderId,
    {
      runId: required(given, "--run"),
      sessionId: given.get("--session"),
      station: given.get("--station"),
      operatorWorker: worker,
    },
    worker,
    undefined,
    cwd,
  );
  return `${orderId} is working`;
}

function exitCode(given: Map<string, string>): number {
  const spec = required(given, "--exit");
  if (!/^-?\d+$/.test(spec)) throw new OrderCommandError(`--exit ${spec} is not an exit code`);
  return Number(spec);
}

function lineCount(given: Map<string, string>, flag: string): number | undefined {
  const spec = given.get(flag);
  if (spec === undefined || spec === "-") return undefined;
  if (!/^\d+$/.test(spec)) throw new OrderCommandError(`${flag} ${spec} is not a line count`);
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
        throw new OrderCommandError("provide exactly one of --body or --body-file");
      }
      const buildId = recordOrderBuild(
        db,
        id,
        body === undefined ? readFileSync(bodyFile as string, "utf8") : markdownBody(body),
        required(given, "--head"),
        worker,
      );
      return `${id} recorded build artifact ${buildId}`;
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

function ship(
  db: Database,
  orderId: string,
  args: string[],
  worktree: string,
  env: Env,
  worker: string,
): string {
  flags(args, []);
  const outcome = shipOrder(db, orderId, worktree, worker, { env });
  return `${orderId} is ${SHIP_OUTCOME_TEXT[outcome.landed]}`;
}

const STOP_KINDS = ["completed", "failed"] as const;

function stop(db: Database, orderId: string, args: string[], cwd: string, worker: string): string {
  const [kind, ...rest] = args;
  if (!kind) throw new OrderCommandError("stop needs how the order stopped");
  if (!(STOP_KINDS as readonly string[]).includes(kind)) {
    throw new OrderCommandError(`${kind} is not a way an order can stop`);
  }
  const given = flags(rest, ["--reason"]);
  if (kind === "failed") {
    assertOperator(db, worker, "recover a failed order");
    recoverOrderFailure(db, orderId, worker, given.get("--reason"), undefined, repoRoot(cwd));
    return `${orderId} is queued again`;
  }
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
  assertOperator(db, worker, "drop an order");
  const reason = required(flags(args, ["--reason"]), "--reason");
  dropOrder(db, orderId, reason, worker);
  return `${orderId} is dropped: ${reason}`;
}

function ruleOnRefusal(
  db: Database,
  findingSpec: string | undefined,
  args: string[],
  worker: string,
): string {
  if (findingSpec === undefined || !/^[1-9]\d*$/.test(findingSpec)) {
    throw fail(
      "rule names the finding it settles: `dim order rule <finding-id> --uphold|--overturn --reason ...`",
    );
  }
  const upheld = args.includes("--uphold");
  const overturned = args.includes("--overturn");
  if (upheld === overturned) throw fail("rule takes exactly one of --uphold or --overturn");
  const reason = required(
    flags(
      args.filter((arg) => arg !== "--uphold" && arg !== "--overturn"),
      ["--reason"],
    ),
    "--reason",
  );
  const ruling = upheld ? "refusal_upheld" : "refusal_overturned";
  recordOwnerRuling(db, Number(findingSpec), { ruling, reason }, worker);
  return upheld
    ? `finding ${findingSpec}: refusal upheld`
    : `finding ${findingSpec}: refusal overturned, back to the builder`;
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
  const worker = env.DIM_WORKER_ASSIGNMENT_ID ? resolveAssignedWorker(db, env) : resolveWorker(db, env);
  if (command === "add") return add(db, orderId, rest, defaultProject, worker);
  if (command === "claim") return claim(db, orderId, rest, worker, env, cwd);
  if (command === "priority") {
    const [level] = rest;
    const chosen = priority(level);
    if (!chosen) throw fail("priority takes the level to set");
    setOrderPriority(db, orderId, chosen, worker);
    return `${orderId} is ${chosen}`;
  }
  if (command === "hold") {
    const reason = required(flags(rest, ["--reason"]), "--reason");
    setOrderHold(db, orderId, reason, worker);
    return `${orderId} is held: ${reason}`;
  }
  if (command === "release") {
    flags(rest, []);
    setOrderHold(db, orderId, null, worker);
    return `${orderId} is released`;
  }
  if (command === "return") {
    const reason = required(flags(rest, ["--reason"]), "--reason");
    returnOrderArtifact(db, orderId, worker, reason);
    return `${orderId} artifact returned to its station`;
  }
  if (command === "move") {
    const station = required(flags(rest, ["--station"]), "--station");
    moveOrder(db, orderId, station, worker);
    return `${orderId} moved to ${station}`;
  }
  if (command === "plan") {
    const harness = selectedHarness(db, flags(rest, ["--harness"]), worker);
    assertOperator(db, worker, "delegate planning");
    const outcome = runOrderPlan(db, orderId, { dir: cwd, env, harness });
    return `${outcome.body}\n\n---\nPlanner: ${outcome.planner}`;
  }
  if (command === "approve") {
    const station = db
      .query<{ station: string | null }, [string]>("SELECT station FROM factory_order WHERE id = ?")
      .get(orderId)
      ?.station?.replace("dim-station-", "");
    if (station === "plan") {
      flags(rest, []);
      approveOrderPlan(db, orderId, worker);
      return `${orderId} plan approved by ${worker}`;
    }
    if (station === "build") {
      const given = flags(rest, ["--reason"]);
      approveOrderBuild(db, orderId, worker, required(given, "--reason"));
      return `${orderId} build approved by ${worker}`;
    }
    if (station === "review") {
      flags(rest, []);
      approveOrderReview(db, orderId, worker);
      return `${orderId} review approved by ${worker}`;
    }
    throw new OrderCommandError(`${orderId} is not at an approvable station`);
  }
  if (Object.hasOwn(EVIDENCE, command)) {
    const evidence = EVIDENCE[command] as Evidence;
    return evidence.record(db, orderId, flags(rest, evidence.flags), worker);
  }
  if (command === "ship") return ship(db, orderId, rest, cwd, env, worker);
  if (command === "stop") return stop(db, orderId, rest, cwd, worker);
  if (command === "amend") return amend(db, orderId, rest);
  if (command === "drop") return drop(db, orderId, rest, worker);
  if (command === "rule") return ruleOnRefusal(db, orderId, rest, worker);
  if (command === "review") {
    const harness = selectedHarness(db, flags(rest, ["--harness"]), worker);
    assertOperator(db, worker, "delegate review");
    const done = runOrderReview(db, orderId, worker, { dir: cwd, env, harness });
    return done.outcome === "aborted"
      ? `review ${done.review} aborted: ${done.reviewer} did not finish, so nothing it left is a clean reading`
      : `review ${done.review} closed with ${done.findings} finding${done.findings === 1 ? "" : "s"}`;
  }
  throw new OrderCommandError(`${command} is not an order subcommand`);
}

export async function runOrderCommandLive(
  db: Database,
  args: string[],
  defaultProject: string | null = null,
  cwd = process.cwd(),
  env: Env = process.env,
): Promise<string> {
  if (args[0] !== "plan" && args[0] !== "build" && args[0] !== "review")
    return runOrderCommand(db, args, defaultProject, cwd, env);
  const [, orderId, ...rest] = args;
  if (!orderId) throw new OrderCommandError("order takes a subcommand and an order id");
  const given = flags(rest, ["--harness"]);
  const operator = resolveWorker(db, env);
  const harness = selectedHarness(db, given, operator);
  if (args[0] === "plan") {
    const outcome = await runOrderPlanLive(db, orderId, { dir: cwd, env, harness });
    return `${outcome.body}\n\n---\nPlanner: ${outcome.planner}`;
  }
  assertOperator(db, operator, `delegate ${args[0]}`);
  if (args[0] === "build") {
    const outcome = await runOrderBuildLive(db, orderId, operator, { dir: cwd, env, harness });
    return `build completed by ${outcome.builder}`;
  }
  const outcome = await runOrderReviewLive(db, orderId, operator, { dir: cwd, env, harness });
  return outcome.outcome === "aborted"
    ? `review ${outcome.review} aborted: ${outcome.reviewer} did not finish, so nothing it left is a clean reading`
    : `review ${outcome.review} closed with ${outcome.findings} finding${outcome.findings === 1 ? "" : "s"}`;
}
