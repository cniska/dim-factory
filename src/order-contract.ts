import { z } from "zod";
import { refuser } from "./coded-error";
import { HarnessName } from "./harness-name";
import { SLICE_CODES } from "./slice-contract";

export const STATIONS = ["plan", "build", "review"] as const;
export const Station = z.enum(STATIONS);
export type Station = z.infer<typeof Station>;

export const Decider = z.enum(["owner", "operator"]);
export type Decider = z.infer<typeof Decider>;

export const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

export const ORDER_ID_LENGTH = 8;

export const OrderId = z.string().regex(new RegExp(`^[${CROCKFORD}]{${ORDER_ID_LENGTH}}$`));

export const Status = z.enum(["queued", "running", "shipped", "cancelled"]);
export type Status = z.infer<typeof Status>;

export const Next = z.enum(["run", "approve", "update"]);
export type Next = z.infer<typeof Next>;

export const RunKind = z.enum(["station", "ship"]);
export type RunKind = z.infer<typeof RunKind>;

type OrderRefusalMeta = {
  readonly no_order: { readonly order: string };
  readonly not_next_step: { readonly order: string; readonly next: Next | null };
  readonly order_busy: { readonly order: string; readonly run: RunKind };
  readonly plan_approved: { readonly order: string };
  readonly no_reason: { readonly order: string; readonly act: string };
  readonly no_checkout: { readonly project: string };
  readonly no_default_branch: { readonly checkout: string };
};

const ADD_ORDER = "dim order add --title <title> --description <description>";

const STEP: Readonly<Record<Next, (order: string) => string>> = {
  run: (order) => `dim order run ${order}`,
  approve: (order) => `dim order approve ${order} --reason <reason> --decided owner|operator`,
  update: (order) => `dim order update ${order} --description <description>`,
};

export const refuseOrder = refuser<OrderRefusalMeta>({
  no_order: { message: ({ order }) => `no order ${order} is on record`, resolve: () => ADD_ORDER },
  not_next_step: {
    message: ({ order, next }) =>
      next === null
        ? `order ${order} has ended, so nothing more happens to it`
        : `order ${order} waits on ${next}, and that is the only step it takes now`,
    resolve: ({ order, next }) => (next === null ? `dim order show ${order}` : STEP[next](order)),
  },
  order_busy: {
    message: ({ order, run }) =>
      run === "ship"
        ? `order ${order} is shipping, and nothing else happens to it until the ship ends`
        : `a station is working on order ${order}, and nothing else happens to it until its worker ends`,
    resolve: ({ order }) => `dim order show ${order}`,
  },
  no_reason: {
    message: ({ order, act }) =>
      `a decision records why it was taken, and this ${act} of order ${order} gives no reason`,
    resolve: ({ order, act }) => `dim order ${act} ${order} --reason <reason> --decided owner|operator`,
  },
  plan_approved: {
    message: ({ order }) =>
      `order ${order}'s plan is approved, so its title and description stay; cancel it and add a new order instead`,
    resolve: ({ order }) => `dim order cancel ${order} --reason <reason>`,
  },
  no_checkout: {
    message: ({ project }) =>
      `no session on record ran in a checkout of ${project}, so its settings cannot be read; add the order from inside that checkout`,
    resolve: () => ADD_ORDER,
  },
  no_default_branch: {
    message: ({ checkout }) =>
      `${checkout} names no default branch; set it with \`git remote set-head origin --auto\``,
    resolve: () => "dim doctor",
  },
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
export type Severity = z.infer<typeof Severity>;

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

const evidence = z.array(Evidence);

const entry = <A extends string, D extends z.ZodRawShape>(action: A, details: D) =>
  z.object({ action: z.literal(action), details: z.object(details) });

const stop = <A extends string, C extends string, D extends z.ZodRawShape>(action: A, code: C, details: D) =>
  z.object({ action: z.literal(action), code: z.literal(code), details: z.object(details) });

const session = { session: z.string() };
const tip = { tip: z.string() };
const decision = { station: Station, reason: text, decidedBy: Decider };

export const Decision = z.object({ reason: z.string(), decidedBy: Decider });
export type Decision = z.infer<typeof Decision>;
const message = { to: z.string(), text };

export const Plan = z.object({ body: text, slices: z.array(Slice).min(1) });
export type Plan = z.infer<typeof Plan>;

export const OrderAdded = entry("order_added", { title: text, description: text, project: text });
export type OrderAdded = z.infer<typeof OrderAdded>;

export const Later = z.union([
  entry("order_updated", { title: text, description: text }),
  entry("order_run", {}),
  entry("workspace_created", { base: z.string() }),
  entry("order_cancelled", { reason: text }),
  entry("artifact_approved", decision),
  entry("artifact_returned", decision),
  entry("order_returned", { station: Station, reason: text }),
  entry("plan_returned", Plan.shape),
  entry("slice_submitted", tip),
  entry("slice_committed", { commit: z.string() }).extend({ evidence }),
  z.object({
    action: z.literal("slice_refused"),
    code: z.enum(SLICE_CODES),
    details: z.object(tip),
    evidence,
  }),
  entry("finding_answered", { finding: z.string(), answer: Answer, reason: text }),
  entry("build_returned", { artifact: text }),
  entry("review_returned", {
    returned: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("findings"), findings: z.array(RecordedFinding).min(1) }),
      z.object({ kind: z.literal("artifact"), artifact: ReviewArtifact }),
    ]),
  }),
  entry("message_sent", message),
  entry("message_refused", message),
  entry("session_started", { worker: z.string(), session: z.string(), harness: HarnessName }),
  z.discriminatedUnion("code", [
    stop("session_died", "usage_limit", { ...session, resetsAt: z.string().nullable() }),
    stop("session_died", "killed", session),
    stop("session_died", "resume_failed", session),
  ]),
  z.discriminatedUnion("code", [
    stop("station_failed", "no_return", session),
    stop("station_failed", "return_missed", { ...session, missed: text }),
    stop("station_failed", "session_died", session),
  ]),
  entry("ship_started", {}),
  entry("branch_rebased", { head: z.string() }),
  z.discriminatedUnion("code", [
    stop("ship_stopped", "ship_unset", {}),
    stop("ship_stopped", "checkout_dirty", { checkout: z.string() }),
    stop("ship_stopped", "ship_conflict", { commit: z.string(), paths: z.array(z.string()).min(1) }),
    stop("ship_stopped", "ship_check_failed", { head: z.string() }).extend({ evidence }),
    stop("ship_stopped", "ship_no_check", { head: z.string() }).extend({ evidence }),
  ]),
  entry("ship_landed", {
    head: z.string(),
    kept: z.array(z.object({ path: z.string(), reason: z.string() })),
  }).extend({ evidence }),
  entry("cleaned_up", {}),
]);
export type Later = z.infer<typeof Later>;

export const Detailed = z.union([OrderAdded, Later]);
export type Detailed = z.infer<typeof Detailed>;

export type Action = Detailed["action"];

type Shared = { readonly seq: number; readonly at: string; readonly by: Actor };

export type LogEntry = Shared & Detailed;

export type LaterEntry = Shared & Later;

export type EntryOf<A extends Action> = Extract<LogEntry, { readonly action: A }>;
