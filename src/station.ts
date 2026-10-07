import { join } from "node:path";
import type { z } from "zod";
import { invariant, unreachable } from "./assert";
import { listedEnv, PASSED_THROUGH } from "./check";
import { type CodedError, recordOf } from "./coded-error";
import type { Models } from "./config-contract";
import type { Identity } from "./git";
import type { Adapter, Outcome, Policy } from "./harness-contract";
import { atStation, type OrderState, openFindings, slicesOf } from "./order";
import { type DeathCode, type Later, Plan, ReviewArtifact, STATIONS, type Station } from "./order-contract";
import { type Env, xdgHomes } from "./paths";
import {
  type BuildReturn,
  type FindingAnswer,
  type OrderReturn,
  type PlanReturn,
  ReviewFindings,
  type ReviewReturn,
  refuseStation,
  type TurnReply,
  TurnRequest,
  WORKER_COMMAND,
} from "./station-contract";
import type { StationRole } from "./worker-contract";

export const TURN_SOCKET_ENV = "DIM_TURN_SOCKET";

export function modelOf(models: Models | undefined, role: StationRole): string | null {
  return models?.[role] ?? models?.default ?? null;
}

export type Turn = {
  readonly dir: string;
  readonly home: string;
  readonly tmp: string;
  readonly socket: string;
};

export function workerEnv(
  owner: Env,
  turn: Turn,
  identity: Identity,
  { signIn, tempRoot }: Pick<Adapter, "signIn" | "tempRoot">,
): Record<string, string> {
  return {
    ...listedEnv(owner, [...PASSED_THROUGH, ...signIn]),
    ...xdgHomes(owner),
    HOME: turn.home,
    TMPDIR: turn.tmp,
    [tempRoot]: turn.tmp,
    [TURN_SOCKET_ENV]: turn.socket,
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "false",
  };
}

export type WorkspaceAccess = "edit" | "run" | "read";

export function policyOf({
  access,
  web,
  workspace,
  checkoutGit,
  turn,
}: {
  readonly access: WorkspaceAccess;
  readonly web: boolean;
  readonly workspace: string;
  readonly checkoutGit: string;
  readonly turn: Turn;
}): Policy {
  const hooks = join(checkoutGit, "hooks");
  switch (access) {
    case "edit":
      return { writable: [turn.tmp], denied: [hooks], edits: true, web };
    case "run":
      return { writable: [turn.tmp], denied: [hooks], edits: false, web };
    case "read":
      return { writable: [turn.tmp], denied: [workspace, checkoutGit], edits: false, web };
    default:
      return unreachable(access);
  }
}

const orderFacts = (state: OrderState) => ({
  id: state.id,
  title: state.title,
  project: state.project,
  description: state.description,
});

type BriefFacts = {
  readonly state: OrderState;
  readonly workspace: string;
  readonly diff: string | null;
  readonly check: string | null;
};

type StationTurn = {
  readonly briefsDiff: boolean;
  readonly briefsCheck: boolean;
  readonly brief: (facts: BriefFacts) => Readonly<Record<string, unknown>>;
};

const STATION_TURNS: Readonly<Record<Station, StationTurn>> = {
  plan: {
    briefsDiff: false,
    briefsCheck: false,
    brief: ({ state, workspace }) => ({
      order: orderFacts(state),
      workspace,
      returned: state.returned,
      committed: state.commits,
    }),
  },
  build: {
    briefsDiff: false,
    briefsCheck: true,
    brief: ({ state, workspace, check }) => ({
      order: orderFacts(state),
      workspace,
      check,
      plan: state.plan === null ? null : { body: state.plan.body, slices: slicesOf(state) },
      returned: state.returned,
      findings: openFindings(state).map(({ id, area, file, line, failure, fix, severity }) => ({
        id,
        area,
        file,
        line,
        failure,
        fix,
        severity,
      })),
      conflict: state.conflict,
    }),
  },
  review: {
    briefsDiff: true,
    briefsCheck: false,
    brief: ({ state, workspace, diff }) => {
      invariant(diff !== null, `order ${state.id}'s review is briefed with its diff`);
      return {
        order: orderFacts(state),
        workspace,
        build: state.buildArtifact,
        diff,
        answers: state.findings.flatMap(({ id, file, line, answered }) =>
          answered === null ? [] : [{ finding: id, file, line, ...answered }],
        ),
        returned: state.returned,
      };
    },
  },
};

const STATIONS_OF: Readonly<Record<TurnRequest["act"], readonly Station[]>> = {
  order_show: STATIONS,
  order_return: STATIONS,
  message_send: STATIONS,
  plan_return: ["plan"],
  slice_submit: ["build"],
  finding_answer: ["build"],
  build_return: ["build"],
  review_return: ["review"],
};

export type Answering = "return" | "reply";

export type Purpose = {
  readonly answers: Answering;
  readonly access: WorkspaceAccess;
  readonly web: boolean;
  readonly briefsDiff: boolean;
  readonly briefsCheck: boolean;
  readonly prompt: (facts: BriefFacts) => string;
  readonly refusal: (act: TurnRequest["act"]) => CodedError | null;
};

export function stationPurpose(station: Station): Purpose {
  const { briefsDiff, briefsCheck, brief } = STATION_TURNS[station];
  return {
    answers: "return",
    access: station === "build" ? "edit" : "run",
    web: station === "plan",
    briefsDiff,
    briefsCheck,
    prompt: (facts) => JSON.stringify(brief(facts)),
    refusal: (act) =>
      STATIONS_OF[act].includes(station) ? null : refuseStation("wrong_station", { act, station }),
  };
}

export function messagePurpose(text: string): Purpose {
  return {
    answers: "reply",
    access: "read",
    web: false,
    briefsDiff: false,
    briefsCheck: false,
    prompt: () => text,
    refusal: (act) => (act === "order_show" ? null : refuseStation("message_turn", { act })),
  };
}

type BranchFacts = { readonly tip: string; readonly clean: boolean };

type WorkContext = { readonly station: Station; readonly state: OrderState; readonly branch: BranchFacts };

type Returning = { readonly station: Station; readonly what: string; readonly command: string };

type Issue = { readonly path: readonly PropertyKey[]; readonly message: string };

type JsonParsed<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly issues: readonly Issue[] };

function parseJson<T>(text: string, schema: z.ZodType<T>): JsonParsed<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, issues: [{ path: [], message: `not JSON: ${error}` }] };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, issues: parsed.error.issues };
}

function parsedAs<T>(text: string, schema: z.ZodType<T>, { station, what, command }: Returning): T {
  const parsed = parseJson(text, schema);
  if (parsed.ok) return parsed.data;
  const missed = parsed.issues.map(
    (issue) => `${[what, ...issue.path.map(String)].join(".")}: ${issue.message}`,
  );
  throw refuseStation("not_done", { station, missed: missed.join("; "), command });
}

function buildMissing(state: OrderState, branch: BranchFacts, artifact: string): readonly string[] {
  const unbuilt = slicesOf(state).filter((slice) => slice.commit === null);
  return [
    ...unbuilt.map((slice) => `slice "${slice.title}" has no commit`),
    ...(branch.tip === state.head ? [] : ["the branch holds a commit the gates have not taken"]),
    ...(branch.clean ? [] : ["the workspace holds changes no slice commits"]),
    ...openFindings(state).map((finding) => `finding ${finding.id} is not answered`),
    ...(artifact.trim() === "" ? ["the Build artifact is empty"] : []),
  ];
}

function planReturned(request: PlanReturn): Later {
  const plan = parsedAs(request.plan, Plan, {
    station: "plan",
    what: "plan",
    command: WORKER_COMMAND.plan_return,
  });
  return { action: "plan_returned", details: plan };
}

function orderReturned(request: OrderReturn, { station }: WorkContext): Later {
  return {
    action: "order_returned",
    details: { station, reason: request.reason },
  };
}

function findingAnswered(request: FindingAnswer, { state }: WorkContext): Later {
  const finding = state.findings.find((one) => one.id === request.finding);
  if (finding === undefined) throw refuseStation("no_finding", { finding: request.finding });
  if (finding.answered !== null) throw refuseStation("finding_answered", { finding: request.finding });
  return {
    action: "finding_answered",
    details: {
      finding: finding.id,
      answer: request.answer,
      reason: request.reason,
    },
  };
}

export function requireBuildDone(request: BuildReturn, { state, branch }: WorkContext): void {
  const missed = buildMissing(state, branch, request.artifact);
  if (missed.length > 0) {
    throw refuseStation("not_done", {
      station: "build",
      missed: missed.join("; "),
      command: WORKER_COMMAND.build_return,
    });
  }
}

function buildReturned(request: BuildReturn, context: WorkContext): Later {
  requireBuildDone(request, context);
  return { action: "build_returned", details: { artifact: request.artifact } };
}

function reviewReturned(request: ReviewReturn, { state }: WorkContext): Later {
  const { returned } = request;
  const returning = { station: "review", command: WORKER_COMMAND.review_return } as const;
  if (returned.kind === "artifact") {
    const artifact = parsedAs(returned.text, ReviewArtifact, { ...returning, what: "Review artifact" });
    return { action: "review_returned", details: { returned: { kind: "artifact", artifact } } };
  }
  const seq = state.lastSeq + 1;
  const findings = parsedAs(returned.text, ReviewFindings, { ...returning, what: "findings" }).map(
    (finding, index) => ({ ...finding, id: `f${seq}-${index + 1}` }),
  );
  return { action: "review_returned", details: { returned: { kind: "findings", findings } } };
}

type WorkRequest = Exclude<TurnRequest, { readonly act: "order_show" | "slice_submit" | "message_send" }>;

export function workEntry(request: WorkRequest, context: WorkContext): Later {
  switch (request.act) {
    case "plan_return":
      return planReturned(request);
    case "order_return":
      return orderReturned(request, context);
    case "finding_answer":
      return findingAnswered(request, context);
    case "build_return":
      return buildReturned(request, context);
    case "review_return":
      return reviewReturned(request, context);
    default:
      return unreachable(request);
  }
}

export function requestOf(line: string): TurnRequest {
  const request = parseJson(line, TurnRequest);
  if (request.ok) return request.data;
  throw refuseStation("bad_request", {
    issues: request.issues.map((issue) => [...issue.path.map(String), issue.message].join(": ")).join("; "),
  });
}

const MISSES_TO_FAIL = 2;

type Refused = {
  readonly reply: TurnReply;
  readonly misses: readonly string[];
  readonly stop: boolean;
};

export function replyTo(refusal: CodedError, misses: readonly string[]): Refused {
  const counted = refusal.code === "not_done" ? [...misses, refusal.message] : misses;
  return {
    reply: { ok: false, error: recordOf(refusal) },
    misses: counted,
    stop: counted.length >= MISSES_TO_FAIL,
  };
}

export type TurnStop =
  | { readonly kind: "missed"; readonly missed: string }
  | { readonly kind: "config_changed" };

export type TurnClose = {
  readonly session: string;
  readonly stop: TurnStop | null;
  readonly outcome: Outcome;
  readonly resumed: boolean;
};

export type Ended =
  | { readonly end: "returned" }
  | { readonly end: "closed" }
  | { readonly end: "replied"; readonly reply: string }
  | { readonly end: "missed"; readonly session: string; readonly missed: string }
  | { readonly end: "died"; readonly session: string; readonly code: DeathCode }
  | { readonly end: "lost"; readonly session: string }
  | { readonly end: "config_changed"; readonly session: string }
  | { readonly end: "no_return"; readonly session: string }
  | { readonly end: "no_reply"; readonly session: string };

type Closed = { readonly ended: Ended; readonly record: readonly Later[] };

function deathOf(session: string, outcome: Extract<Outcome, { readonly kind: "died" }>): Later {
  return outcome.code === "usage_limit"
    ? { action: "session_died", code: outcome.code, details: { session, resetsAt: outcome.resetsAt } }
    : { action: "session_died", code: outcome.code, details: { session } };
}

const failed = (code: "git_config_changed" | "no_return" | "session_died", session: string): Later => ({
  action: "station_failed",
  code,
  details: { session },
});

export function closedTurn(
  state: OrderState,
  station: Station,
  answers: Answering,
  close: TurnClose,
): Closed {
  const { session, stop, outcome, resumed } = close;
  if (state.status !== "running") return { ended: { end: "closed" }, record: [] };
  if (stop?.kind === "config_changed") {
    const record = answers === "return" ? [failed("git_config_changed", session)] : [];
    return { ended: { end: "config_changed", session }, record };
  }
  if (stop?.kind === "missed") {
    invariant(answers === "return", `a message turn on order ${state.id} has no definition of done to miss`);
    const record: readonly Later[] = [
      { action: "station_failed", code: "return_missed", details: { session, missed: stop.missed } },
    ];
    return { ended: { end: "missed", session, missed: stop.missed }, record };
  }
  const returned = answers === "return" && !atStation(state, station);
  if (outcome.kind === "died") {
    const death = deathOf(session, outcome);
    if (returned) return { ended: { end: "returned" }, record: [death] };
    if (outcome.code === "resume_failed" && resumed)
      return { ended: { end: "lost", session }, record: [death] };
    const record = answers === "return" ? [death, failed("session_died", session)] : [death];
    return { ended: { end: "died", session, code: outcome.code }, record };
  }
  if (answers === "reply") {
    return outcome.result === null
      ? { ended: { end: "no_reply", session }, record: [] }
      : { ended: { end: "replied", reply: outcome.result }, record: [] };
  }
  return returned
    ? { ended: { end: "returned" }, record: [] }
    : { ended: { end: "no_return", session }, record: [failed("no_return", session)] };
}
