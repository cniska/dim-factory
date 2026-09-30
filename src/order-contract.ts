import { z } from "zod";
import { refuser } from "./coded-error";

export const STATIONS = ["plan", "build", "review"] as const;
export const Station = z.enum(STATIONS);
export type Station = z.infer<typeof Station>;

export const Decider = z.enum(["owner", "operator"]);
export type Decider = z.infer<typeof Decider>;

export const OrderId = z.string().regex(/^[0-9a-hjkmnp-tv-z]{8}$/);

export type Status = "queued" | "running" | "shipped" | "cancelled";

export type Next = "run" | "approve" | "update";

export type OrderRefusalMeta = {
  readonly no_order: { readonly order: string };
  readonly not_next_step: { readonly order: string; readonly next: Next | null };
  readonly plan_approved: { readonly order: string };
  readonly no_checkout: { readonly project: string };
  readonly no_default_branch: { readonly checkout: string };
};

export type OrderRefusalCode = keyof OrderRefusalMeta;

export const refuse = refuser<OrderRefusalMeta>({
  no_order: ({ order }) => `no order ${order} is on record`,
  not_next_step: ({ order, next }) =>
    next === null
      ? `order ${order} has ended, so nothing more happens to it`
      : `order ${order} waits on ${next}, and that is the only step it takes now`,
  plan_approved: ({ order }) =>
    `order ${order}'s plan is approved, so its title and description stay; cancel it and add a new order instead`,
  no_checkout: ({ project }) =>
    `no session on record ran in a checkout of ${project}, so its settings cannot be read; add the order from inside that checkout`,
  no_default_branch: ({ checkout }) =>
    `${checkout} names no default branch; set it with \`git remote set-head origin --auto\``,
});

export const Actor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("worker"), worker: z.string(), session: z.string() }),
  z.object({ kind: z.literal("factory"), version: z.string(), cause: z.number().int().positive() }),
]);
export type Actor = z.infer<typeof Actor>;

const text = z.string().trim().min(1);

export const Slice = z.object({ title: text, outcome: text });
export type Slice = z.infer<typeof Slice>;

export const Severity = z.enum(["critical", "high", "medium"]);

export const Finding = z.object({
  area: text,
  file: text,
  line: z.number().int().positive(),
  failure: text,
  fix: text,
  severity: Severity,
});
export type Finding = z.infer<typeof Finding>;

export const RecordedFinding = Finding.extend({ id: z.string() });
export type RecordedFinding = z.infer<typeof RecordedFinding>;

export const ReviewArtifact = z.object({
  body: text,
  covered: z.array(text).min(1),
  setAside: z.array(text),
  unverified: z.array(text),
});
export type ReviewArtifact = z.infer<typeof ReviewArtifact>;

export const Answer = z.enum(["fixed", "refused"]);
export type Answer = z.infer<typeof Answer>;

const CheckEvidence = z.object({
  kind: z.literal("check"),
  command: z.string(),
  exitCode: z.number().int().nullable(),
  output: z.string(),
});

const RebaseEvidence = z.object({
  kind: z.literal("rebase"),
  onto: z.string(),
  commits: z.array(z.object({ from: z.string(), to: z.string() })),
});

export const Evidence = z.discriminatedUnion("kind", [CheckEvidence, RebaseEvidence]);
export type Evidence = z.infer<typeof Evidence>;

const session = z.object({ session: z.string() });

const StationFailed = z.discriminatedUnion("code", [
  z.object({ action: z.literal("station_failed"), code: z.literal("no_return"), details: session }),
  z.object({
    action: z.literal("station_failed"),
    code: z.literal("return_missed"),
    details: session.extend({ missed: text }),
  }),
  z.object({ action: z.literal("station_failed"), code: z.literal("session_died"), details: session }),
]);

const SessionDied = z.discriminatedUnion("code", [
  z.object({
    action: z.literal("session_died"),
    code: z.literal("usage_limit"),
    details: session.extend({ resetsAt: z.string().nullable() }),
  }),
  z.object({ action: z.literal("session_died"), code: z.literal("killed"), details: session }),
  z.object({ action: z.literal("session_died"), code: z.literal("resume_failed"), details: session }),
]);

export const SLICE_REFUSALS = [
  "head_moved",
  "check_changed",
  "workspace_dirty",
  "check_failed",
  "check_rewrote",
] as const;

const ShipStopped = z.discriminatedUnion("code", [
  z.object({ action: z.literal("ship_stopped"), code: z.literal("ship_unset"), details: z.object({}) }),
  z.object({
    action: z.literal("ship_stopped"),
    code: z.literal("checkout_dirty"),
    details: z.object({ checkout: z.string() }),
  }),
  z.object({
    action: z.literal("ship_stopped"),
    code: z.literal("ship_conflict"),
    details: z.object({ commit: z.string(), paths: z.array(z.string()).min(1) }),
  }),
  z.object({
    action: z.literal("ship_stopped"),
    code: z.literal("ship_check_failed"),
    details: z.object({ head: z.string() }),
    evidence: z.array(Evidence),
  }),
]);

const ReviewReturned = z.object({
  action: z.literal("review_returned"),
  returned: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("findings"), findings: z.array(RecordedFinding).min(1) }),
    z.object({ kind: z.literal("artifact"), artifact: ReviewArtifact }),
  ]),
});

const message = z.object({ to: z.string(), text });

export const Detailed = z.union([
  z.object({ action: z.literal("order_added"), title: text, description: text, project: text }),
  z.object({ action: z.literal("order_updated"), title: text, description: text }),
  z.object({ action: z.literal("order_run") }),
  z.object({ action: z.literal("workspace_created"), details: z.object({ base: z.string() }) }),
  z.object({ action: z.literal("order_cancelled"), reason: text }),
  z.object({ action: z.literal("artifact_approved"), station: Station, reason: text, decidedBy: Decider }),
  z.object({ action: z.literal("artifact_returned"), station: Station, reason: text, decidedBy: Decider }),
  z.object({ action: z.literal("order_returned"), station: Station, reason: text }),
  z.object({ action: z.literal("plan_returned"), body: text, slices: z.array(Slice).min(1) }),
  z.object({ action: z.literal("slice_submitted"), details: z.object({ tip: z.string() }) }),
  z.object({
    action: z.literal("slice_committed"),
    details: z.object({ commit: z.string() }),
    evidence: z.array(Evidence),
  }),
  z.object({
    action: z.literal("slice_refused"),
    code: z.enum(SLICE_REFUSALS),
    details: z.object({ tip: z.string() }),
    evidence: z.array(Evidence),
  }),
  z.object({ action: z.literal("finding_answered"), finding: z.string(), answer: Answer, reason: text }),
  z.object({ action: z.literal("build_returned"), artifact: text }),
  ReviewReturned,
  z.object({ action: z.literal("message_sent"), details: message }),
  z.object({ action: z.literal("message_refused"), details: message }),
  z.object({
    action: z.literal("session_started"),
    details: z.object({ session: z.string(), harness: z.string() }),
  }),
  SessionDied,
  StationFailed,
  z.object({ action: z.literal("ship_started") }),
  z.object({ action: z.literal("branch_rebased"), details: z.object({ head: z.string() }) }),
  ShipStopped,
  z.object({
    action: z.literal("ship_landed"),
    details: z.object({ head: z.string(), kept: z.array(z.string()) }),
    evidence: z.array(Evidence),
  }),
  z.object({ action: z.literal("cleaned_up") }),
]);
export type Detailed = z.infer<typeof Detailed>;

export type Action = Detailed["action"];

export type LogEntry = { readonly seq: number; readonly at: string; readonly by: Actor } & Detailed;

export type EntryOf<A extends Action> = Extract<LogEntry, { readonly action: A }>;
