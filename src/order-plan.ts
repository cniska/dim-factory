import type { Database } from "bun:sqlite";
import type { Capability } from "./capabilities";
import { recordOrderPlan } from "./factory-order";
import {
  mintWorker,
  newWorkerSession,
  WORKER_NAME_VAR,
  WORKER_SESSION_VAR,
  WORKER_TOKEN_VAR,
} from "./factory-worker";
import { route } from "./routing";
import { readSpawnProfile, spawnArgv } from "./spawn-profile";

/** Reads and searches the repository, its history and the record — never edits, never raises a finding. */
export const PLANNER_CAPABILITIES: Capability[] = ["read-files", "read-history", "ask-dim"];

export type PlannerSpawn = (
  argv: string[],
  env: Record<string, string>,
) => {
  exitCode: number;
  stdout: string;
};

const spawnPlanner: PlannerSpawn = (argv, env) => {
  const run = Bun.spawnSync(argv, {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "inherit",
  });
  return { exitCode: run.exitCode ?? 1, stdout: run.stdout.toString() };
};

export function plannerBrief(order: { id: string; title: string; description: string | null }): string {
  return [
    `You are the planner for factory order ${order.id} in this repository.`,
    "",
    `# ${order.title}`,
    order.description ?? "",
    "",
    "Read the repository rules and prior decisions before proposing work.",
    "Write one plain Markdown plan for the owner to read on the factory wall.",
    "Include the outcome, evidence, contracts, independently verifiable slices, risks, holds, and non-goals.",
    "Return only the Markdown plan. Do not edit files, commit, or run mutation commands.",
  ].join("\n");
}

export type PlanOutcome = { planner: string; body: string };

export function runOrderPlan(
  db: Database,
  orderId: string,
  options: {
    env?: Record<string, string | undefined>;
    spawn?: PlannerSpawn;
  } = {},
): PlanOutcome {
  const order = db
    .query<{ id: string; title: string; description: string | null }, [string]>(
      "SELECT id, title, description FROM factory_order WHERE id = ?",
    )
    .get(orderId);
  if (!order) throw new Error(`order not found: ${orderId}`);
  const parentSession = options.env?.[WORKER_SESSION_VAR] ?? newWorkerSession("parent");
  const minted = mintWorker(db, {
    role: "planner",
    sessionId: `${parentSession}/planner/${orderId}`,
  });
  const { model } = route("planner", options.env);
  const profile = readSpawnProfile(options.env);
  const spawn = options.spawn ?? spawnPlanner;
  const run = spawn(
    spawnArgv(profile, { model, brief: plannerBrief(order), capabilities: PLANNER_CAPABILITIES }),
    {
      [WORKER_NAME_VAR]: minted.name,
      [WORKER_TOKEN_VAR]: minted.token,
      [WORKER_SESSION_VAR]: minted.sessionId,
    },
  );
  if (run.exitCode !== 0) throw new Error(`${minted.name} did not finish planning`);
  const body = run.stdout.trim();
  recordOrderPlan(db, orderId, body, minted.name);
  return { planner: minted.name, body };
}
