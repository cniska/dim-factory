import type { Database } from "bun:sqlite";
import type { Capability } from "./capabilities";
import { assertOperator } from "./factory-operator";
import { recordOrderPlan } from "./factory-order";
import { resolveWorker } from "./factory-worker";
import { route } from "./routing";
import { readSpawnProfile, spawnArgv } from "./spawn-profile";
import { invitationProcessEnv, inviteWorker } from "./worker-invitation";

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
    env,
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
    "Your first act must be `dim worker accept $DIM_WORKER_INVITATION_ID` using the invitation in your environment.",
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
  const parentWorker = resolveWorker(db, options.env);
  assertOperator(db, parentWorker, "delegate planning");
  const invitation = inviteWorker(db, { role: "planner", parentWorker });
  const { model } = route("planner", options.env);
  const profile = readSpawnProfile(options.env);
  const spawn = options.spawn ?? spawnPlanner;
  const run = spawn(
    spawnArgv(profile, { model, brief: plannerBrief(order), capabilities: PLANNER_CAPABILITIES }),
    invitationProcessEnv(options.env ?? process.env, invitation),
  );
  if (run.exitCode !== 0) throw new Error("planner did not finish planning");
  const body = run.stdout.trim();
  const planner = db
    .query<{ accepted_worker: string | null }, [string]>(
      "SELECT accepted_worker FROM factory_worker_invitation WHERE id = ?",
    )
    .get(invitation.id)?.accepted_worker;
  if (!planner) throw new Error("planner did not accept its worker invitation");
  recordOrderPlan(db, orderId, body, planner);
  return { planner, body };
}
