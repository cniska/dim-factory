import { z } from "zod";
import type { Action, WorkerRole } from "./vocabulary";

const Station = z.enum(["plan", "build", "review"]);

const Actor = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("worker"), worker: z.string(), session: z.string() }),
  z.strictObject({ kind: z.literal("factory"), version: z.string(), cause: z.number() }),
]);

const Evidence = z.strictObject({
  kind: z.literal("check"),
  command: z.string(),
  exitCode: z.number().nullable(),
  output: z.string(),
});

const evidence = { evidence: z.array(Evidence).readonly() };

const checked = { evidence: z.tuple([Evidence]).readonly() };

const shared = { seq: z.number(), ts: z.string(), by: Actor };

const entry = <A extends string, D extends z.ZodRawShape>(action: A, details: D) =>
  z.strictObject({ ...shared, action: z.literal(action), details: z.strictObject(details) });

const stop = <A extends string, C extends string, D extends z.ZodRawShape>(action: A, code: C, details: D) =>
  z.strictObject({
    ...shared,
    action: z.literal(action),
    code: z.literal(code),
    details: z.strictObject(details),
  });

const decision = { station: Station, reason: z.string(), decidedBy: z.enum(["owner", "operator"]) };
const session = { session: z.string() };
const dying = { ...session, copied: z.boolean() };
const tip = { tip: z.string() };
const exited = { command: z.string(), exitCode: z.number().nullable() };
const message = { to: z.string(), text: z.string() };
const slice = z.strictObject({ title: z.string(), outcome: z.string() });

const Finding = z.strictObject({
  id: z.string(),
  area: z.string(),
  file: z.string(),
  line: z.number(),
  failure: z.string(),
  fix: z.string(),
  severity: z.enum(["critical", "high", "medium"]),
});

const LogEntry = z.union([
  entry("order_added", { title: z.string(), description: z.string(), project: z.string() }),
  entry("order_updated", { title: z.string(), description: z.string() }),
  entry("order_run", {}),
  entry("workspace_created", { base: z.string() }),
  entry("order_cancelled", { reason: z.string() }),
  entry("artifact_approved", decision),
  entry("artifact_returned", decision),
  entry("order_returned", { station: Station, reason: z.string() }),
  entry("plan_returned", { body: z.string(), slices: z.array(slice).readonly() }),
  entry("slice_submitted", tip),
  entry("slice_accepted", { commit: z.string() }).extend(evidence),
  stop("slice_refused", "head_moved", { ...tip, head: z.string() }),
  stop("slice_refused", "check_changed", tip),
  stop("slice_refused", "workspace_dirty", tip),
  stop("slice_refused", "no_check", tip),
  stop("slice_refused", "check_failed", { ...tip, ...exited }).extend(checked),
  stop("slice_refused", "check_rewrote", { ...tip, command: z.string() }).extend(checked),
  stop("slice_refused", "not_rebased", { ...tip, onto: z.string(), commits: z.number() }),
  entry("finding_answered", {
    finding: z.string(),
    answer: z.enum(["fixed", "refused"]),
    reason: z.string(),
  }),
  entry("build_returned", { artifact: z.string() }),
  entry("review_returned", {
    returned: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("findings"), findings: z.array(Finding).readonly() }),
      z.strictObject({
        kind: z.literal("artifact"),
        artifact: z.strictObject({
          body: z.string(),
          covered: z.array(z.string()).readonly(),
          setAside: z.array(z.string()).readonly(),
          unverified: z.array(z.string()).readonly(),
        }),
      }),
    ]),
  }),
  entry("message_sent", message),
  stop("message_refused", "not_to_operator", message),
  entry("session_started", { worker: z.string(), session: z.string(), harness: z.enum(["codex", "claude"]) }),
  stop("session_died", "usage_limit", { ...dying, resetsAt: z.string().nullable() }),
  stop("session_died", "killed", dying),
  stop("session_died", "resume_failed", dying),
  stop("station_failed", "no_return", session),
  stop("station_failed", "return_missed", { ...session, missed: z.string() }),
  stop("station_failed", "session_died", session),
  stop("station_failed", "git_config_changed", session),
  stop("station_failed", "install_failed", { command: z.string(), output: z.string() }),
  entry("ship_started", {}),
  entry("branch_rebased", {
    head: z.string(),
    onto: z.string(),
    commits: z.array(z.strictObject({ from: z.string(), to: z.string() })).readonly(),
  }).extend(evidence),
  stop("ship_stopped", "ship_unset", {}),
  stop("ship_stopped", "checkout_dirty", { checkout: z.string(), reason: z.string() }),
  stop("ship_stopped", "ship_conflict", { onto: z.string(), paths: z.array(z.string()).readonly() }),
  stop("ship_stopped", "rebase_failed", { onto: z.string(), reason: z.string() }),
  stop("ship_stopped", "ship_check_failed", { head: z.string(), ...exited }).extend(checked),
  stop("ship_stopped", "ship_no_check", { head: z.string() }),
  entry("ship_landed", {
    head: z.string(),
    kept: z
      .array(
        z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("workspace"), dir: z.string(), reason: z.string() }),
          z.strictObject({ kind: z.literal("branch"), branch: z.string(), reason: z.string() }),
        ]),
      )
      .readonly(),
  }).extend(checked),
]);

export type LogEntry = z.infer<typeof LogEntry>;

type EntryOf<A extends Action> = Extract<LogEntry, { readonly action: A }>;

type Stop = Extract<LogEntry, { readonly code: string }>;

const SessionView = z.strictObject({
  id: z.string(),
  harness: z.enum(["codex", "claude"]),
  pid: z.number(),
  died: z.strictObject({ code: z.string() }).optional(),
});

type SessionView = z.infer<typeof SessionView>;

const WorkerView = z.strictObject({
  name: z.string(),
  role: z.enum(["operator", "planner", "builder", "reviewer"]),
  createdBy: z.string().optional(),
  sessions: z.array(SessionView).readonly(),
});

type WorkerView = z.infer<typeof WorkerView>;

export const OrderView = z.strictObject({
  id: z.string(),
  title: z.string(),
  project: z.string(),
  description: z.string(),
  status: z.enum(["queued", "running", "shipped", "cancelled"]),
  station: Station.nullable(),
  next: z.enum(["run", "approve", "update"]).nullable(),
  admits: z.array(z.enum(["run", "approve", "return", "update", "cancel", "message"])).readonly(),
  branch: z.string(),
  workspace: z.string(),
  log: z.array(LogEntry).readonly(),
  workers: z.array(WorkerView).readonly(),
  slices: z.array(slice.extend({ commit: z.string().nullable() })).readonly(),
  findings: z.array(Finding.extend({ answer: z.enum(["fixed", "refused"]).optional() })).readonly(),
});

export type OrderView = z.infer<typeof OrderView>;

export function workerOf(order: OrderView, role: WorkerRole): WorkerView {
  const found = order.workers.find((worker) => worker.role === role);
  if (!found) throw new Error(`order ${order.id} has no ${role}`);
  return found;
}

export function sessionOf(worker: WorkerView, n: number): SessionView {
  const found = worker.sessions[n];
  if (!found) throw new Error(`${worker.name} has no session ${n + 1}`);
  return found;
}

export function entriesOf<A extends Action>(order: OrderView, action: A): readonly EntryOf<A>[] {
  return order.log.filter((entry): entry is EntryOf<A> => entry.action === action);
}

export function entryOf<A extends Action>(order: OrderView, action: A): EntryOf<A> {
  const [found] = entriesOf(order, action);
  if (!found) throw new Error(`order ${order.id}'s log holds no ${action}`);
  return found;
}

export function causeOf(order: OrderView, entry: LogEntry): LogEntry {
  if (entry.by.kind !== "factory") throw new Error(`${entry.action} was not the factory's`);
  const { cause } = entry.by;
  const found = order.log.find((candidate) => candidate.seq === cause);
  if (!found) throw new Error(`${entry.action} names cause ${cause}, which the log does not hold`);
  return found;
}

export function finalStop(order: OrderView): Stop {
  const last = order.log.at(-1);
  if (last === undefined || !("code" in last))
    throw new Error(
      `order ${order.id} (${order.status}, next ${order.next}) ends its log in ${actions(order).slice(-6).join(", ")}, not a stop`,
    );
  return last;
}

export function actions(order: OrderView): readonly Action[] {
  return order.log.map((entry) => entry.action);
}
