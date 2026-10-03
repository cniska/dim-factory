import { z } from "zod";
import { refuser } from "./coded-error";
import { HarnessName } from "./harness-contract";
import type { Role } from "./worker-contract";
import type { Kept } from "./workspace";

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
  readonly not_admitted: {
    readonly order: string;
    readonly act: ActKind;
    readonly admits: readonly ActKind[];
    readonly next: Next | null;
  };
  readonly not_at_station: { readonly order: string; readonly station: Station };
  readonly order_busy: { readonly order: string; readonly run: RunKind };
  readonly no_checkout: { readonly project: string };
  readonly no_default_branch: { readonly checkout: string };
  readonly no_git_identity: { readonly checkout: string };
  readonly no_worker: { readonly order: string; readonly station: Station };
  readonly workspace_kept: { readonly order: string; readonly root: string; readonly kept: readonly Kept[] };
};

const ADD_ORDER = "dim order add --title <title> --description <description>";

const STEP: Readonly<Record<Next, (order: string) => string>> = {
  run: (order) => `dim order run ${order}`,
  approve: (order) => `dim order approve ${order} --reason <reason> --decided owner|operator`,
  update: (order) => `dim order update ${order} --description <description>`,
};

export const refuseOrder = refuser<OrderRefusalMeta>({
  no_order: { message: ({ order }) => `no order ${order} is on record`, resolve: () => ADD_ORDER },
  not_admitted: {
    message: ({ order, act, admits }) =>
      admits.length === 0
        ? `order ${order} has ended, so nothing more happens to it`
        : `order ${order} admits ${admits.join(", ")} now, and ${act} is not among them`,
    resolve: ({ order, next }) => (next === null ? `dim order show ${order}` : STEP[next](order)),
  },
  not_at_station: {
    message: ({ order, station }) =>
      `order ${order} is not at its ${station} station, so this act records nothing`,
    resolve: ({ order }) => `dim order show ${order}`,
  },
  order_busy: {
    message: ({ order, run }) =>
      run === "ship"
        ? `order ${order} is shipping, and nothing else happens to it until the ship ends`
        : `a station is working on order ${order}, and nothing else happens to it until its worker ends`,
    resolve: ({ order }) => `dim order show ${order}`,
  },
  no_checkout: {
    message: ({ project }) =>
      `no session on record ran in a checkout of ${project}, so its settings cannot be read; add the order from inside that checkout`,
    resolve: () => ADD_ORDER,
  },
  no_git_identity: {
    message: ({ checkout }) =>
      `git names no user.name and user.email in ${checkout}, and every commit the factory makes carries the owner's identity; set both with git config --global, then run the order again`,
    resolve: () =>
      "ask the owner to set user.name and user.email with git config --global; never set them yourself",
  },
  no_worker: {
    message: ({ order, station }) =>
      `order ${order} has no ${station} worker yet, so there is no session to message; one starts when the order runs its ${station} station`,
    resolve: ({ order }) => `dim order show ${order}`,
  },
  workspace_kept: {
    message: ({ order, kept }) =>
      `order ${order} is cancelled, but ${kept
        .map((left) =>
          left.kind === "workspace"
            ? `its worktree at ${left.dir} could not be removed: ${left.reason}`
            : `its branch ${left.branch} could not be deleted: ${left.reason}`,
        )
        .join("; ")}`,
    resolve: ({ root, kept }) =>
      kept
        .map((left) =>
          left.kind === "workspace"
            ? `git -C ${root} worktree remove --force ${left.dir}`
            : `git -C ${root} branch -D ${left.branch}`,
        )
        .join(" && "),
  },
  no_default_branch: {
    message: ({ checkout }) =>
      `${checkout} names no default branch; set it with \`git remote set-head origin --auto\``,
    resolve: ({ checkout }) => `git -C ${checkout} remote set-head origin --auto`,
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
  covered: z.array(text).min(1).readonly(),
  setAside: z.array(text).readonly(),
  unverified: z.array(text).readonly(),
});
export type ReviewArtifact = z.infer<typeof ReviewArtifact>;

export const Answer = z.enum(["fixed", "refused"]);
export type Answer = z.infer<typeof Answer>;

export const Evidence = z.object({
  kind: z.literal("check"),
  command: z.string(),
  exitCode: z.number().int().nullable(),
  output: z.string(),
});
export type Evidence = z.infer<typeof Evidence>;

const evidence = z.array(Evidence).readonly();
const checked = z.tuple([Evidence]).readonly();

const Moved = z.object({ from: z.string(), to: z.string() });

const entry = <A extends string, D extends z.ZodRawShape>(action: A, details: D) =>
  z.object({ action: z.literal(action), details: z.object(details) });

const stop = <A extends string, C extends string, D extends z.ZodRawShape>(action: A, code: C, details: D) =>
  z.object({ action: z.literal(action), code: z.literal(code), details: z.object(details) });

const session = { session: z.string() };
const dying = { ...session, copied: z.boolean() };
const tip = { tip: z.string() };
const exited = { command: z.string(), exitCode: z.number().int().nullable() };
const decision = { station: Station, reason: text, decidedBy: Decider };

export const Reason = text;

export const Decision = z.object({ reason: Reason, decidedBy: Decider });
export type Decision = z.infer<typeof Decision>;

export type OperatorAct =
  | { readonly kind: "run" }
  | { readonly kind: "approve"; readonly decision: Decision }
  | { readonly kind: "return"; readonly decision: Decision }
  | { readonly kind: "update"; readonly title?: string; readonly description?: string }
  | { readonly kind: "cancel"; readonly reason: string }
  | { readonly kind: "message"; readonly to: string; readonly text: string };

export type ActKind = OperatorAct["kind"];

const message = { to: z.string(), text };

export const Plan = z.object({ body: text, slices: z.array(Slice).min(1).readonly() });
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
  z.discriminatedUnion("code", [
    stop("slice_refused", "head_moved", { ...tip, head: z.string() }),
    stop("slice_refused", "check_changed", tip),
    stop("slice_refused", "workspace_dirty", tip),
    stop("slice_refused", "no_check", tip),
    stop("slice_refused", "check_failed", { ...tip, ...exited }).extend({ evidence: checked }),
    stop("slice_refused", "check_rewrote", { ...tip, command: z.string() }).extend({ evidence: checked }),
    stop("slice_refused", "not_rebased", { ...tip, onto: z.string(), commits: z.number().int() }),
  ]),
  entry("finding_answered", { finding: z.string(), answer: Answer, reason: text }),
  entry("build_returned", { artifact: text }),
  entry("review_returned", {
    returned: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("findings"), findings: z.array(RecordedFinding).min(1).readonly() }),
      z.object({ kind: z.literal("artifact"), artifact: ReviewArtifact }),
    ]),
  }),
  entry("message_sent", message),
  stop("message_refused", "not_to_operator", message),
  entry("session_started", { worker: z.string(), session: z.string(), harness: HarnessName }),
  z.discriminatedUnion("code", [
    stop("session_died", "usage_limit", { ...dying, resetsAt: z.string().nullable() }),
    stop("session_died", "killed", dying),
    stop("session_died", "resume_failed", dying),
  ]),
  z.discriminatedUnion("code", [
    stop("station_failed", "no_return", session),
    stop("station_failed", "return_missed", { ...session, missed: text }),
    stop("station_failed", "session_died", session),
    stop("station_failed", "git_config_changed", session),
    stop("station_failed", "install_failed", { command: z.string(), output: z.string() }),
  ]),
  entry("ship_started", {}),
  entry("branch_rebased", { head: z.string(), onto: z.string(), commits: z.array(Moved).readonly() }).extend({
    evidence,
  }),
  z.discriminatedUnion("code", [
    stop("ship_stopped", "ship_unset", {}),
    stop("ship_stopped", "checkout_dirty", { checkout: z.string(), reason: text }),
    stop("ship_stopped", "ship_conflict", { onto: z.string(), paths: z.array(z.string()).min(1).readonly() }),
    stop("ship_stopped", "rebase_failed", { onto: z.string(), reason: text }),
    stop("ship_stopped", "ship_check_failed", { head: z.string(), ...exited }).extend({ evidence: checked }),
    stop("ship_stopped", "ship_no_check", { head: z.string() }),
  ]),
  entry("ship_landed", {
    head: z.string(),
    kept: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("workspace"), dir: z.string(), reason: z.string() }),
          z.object({ kind: z.literal("branch"), branch: z.string(), reason: z.string() }),
        ]),
      )
      .readonly(),
  }).extend({ evidence: checked }),
]);
export type Later = z.infer<typeof Later>;

export type DeathCode = Extract<Later, { readonly action: "session_died" }>["code"];

type Coded = Extract<Later, { readonly code: string }>;

export type StopAction = Coded["action"];

export type StopOf<A extends StopAction> = Extract<Coded, { readonly action: A }>;

export type StopMeta<A extends StopAction> = {
  readonly [S in StopOf<A> as S["code"]]: { readonly order: string } & S["details"];
};
export const Detailed = z.union([OrderAdded, Later]);
export type Detailed = z.infer<typeof Detailed>;

export type Action = Detailed["action"];

type Shared = { readonly seq: number; readonly ts: string; readonly by: Actor };

export type LogEntry = Shared & Detailed;

export type LaterEntry = Shared & Later;

export type EntryOf<A extends Action> = Extract<LogEntry, { readonly action: A }>;

export type SliceView = { readonly title: string; readonly outcome: string; readonly commit: string | null };

export type SessionView = {
  readonly id: string;
  readonly harness: string;
  readonly pid: number;
  readonly died?: { readonly code: string };
};

export type WorkerView = {
  readonly name: string;
  readonly role: Role;
  readonly createdBy?: string;
  readonly sessions: readonly SessionView[];
};

type FindingView = {
  readonly id: string;
  readonly area: string;
  readonly file: string;
  readonly line: number;
  readonly failure: string;
  readonly fix: string;
  readonly severity: Severity;
  readonly answer?: Answer;
};

export type OrderView = {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly description: string;
  readonly status: Status;
  readonly station: Station | null;
  readonly next: Next | null;
  readonly admits: readonly ActKind[];
  readonly branch: string;
  readonly workspace: string;
  readonly log: readonly LogEntry[];
  readonly workers: readonly WorkerView[];
  readonly slices: readonly SliceView[];
  readonly findings: readonly FindingView[];
};
