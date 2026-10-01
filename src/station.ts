import { join } from "node:path";
import type { z } from "zod";
import { invariant, unreachable } from "./assert";
import { listedEnv, PASSED_THROUGH } from "./check";
import { type CodedError, recordOf } from "./coded-error";
import type { Models } from "./config";
import type { Identity } from "./git-tree";
import type { Adapter, Policy } from "./harness-contract";
import { atStation, type OrderState, openFindings, slicesOf } from "./order";
import { type Later, Plan, ReviewArtifact, STATIONS, type Station } from "./order-contract";
import type { Env } from "./paths";
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

const SKILLS: Readonly<Record<Station, string>> = {
  plan: "dim-plan",
  build: "dim-build",
  review: "dim-review",
};

export function modelOf(models: Models | undefined, role: StationRole): string | null {
  return models?.[role] ?? models?.default ?? null;
}

const XDG = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const;

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
    ...listedEnv(owner, [...PASSED_THROUGH, ...XDG, ...signIn]),
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

type Places = { readonly workspace: string; readonly checkoutGit: string; readonly turn: Turn };

export function policyOf(kind: Policy["kind"], { workspace, checkoutGit, turn }: Places): Policy {
  switch (kind) {
    case "read":
      return { kind, writable: [turn.tmp], denied: [workspace, checkoutGit] };
    case "edit":
      return { kind, writable: [turn.tmp], denied: [join(checkoutGit, "hooks")] };
    default:
      return unreachable(kind);
  }
}

const orderFacts = (state: OrderState) => ({
  id: state.id,
  title: state.title,
  project: state.project,
  description: state.description,
});

export type BriefFacts = {
  readonly state: OrderState;
  readonly workspace: string;
  readonly diff: string | null;
};

export function briefAt(station: Station, { state, workspace, diff }: BriefFacts): string {
  switch (station) {
    case "plan":
      return JSON.stringify({
        skill: SKILLS.plan,
        order: orderFacts(state),
        workspace,
        returned: state.returned,
        committed: state.commits,
      });
    case "build":
      return JSON.stringify({
        skill: SKILLS.build,
        order: orderFacts(state),
        workspace,
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
      });
    case "review":
      invariant(diff !== null, `order ${state.id}'s review is briefed with its diff`);
      return JSON.stringify({
        skill: SKILLS.review,
        order: orderFacts(state),
        workspace,
        build: state.buildArtifact,
        diff,
        answers: state.findings.flatMap(({ id, file, line, answered }) =>
          answered === null ? [] : [{ finding: id, file, line, ...answered }],
        ),
        returned: state.returned,
      });
    default:
      return unreachable(station);
  }
}

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

export type Purpose = {
  readonly policy: Policy["kind"];
  readonly prompt: (facts: BriefFacts) => string;
  readonly refusal: (act: TurnRequest["act"]) => CodedError | null;
};

export function stationPurpose(station: Station): Purpose {
  return {
    policy: station === "build" ? "edit" : "read",
    prompt: (facts) => briefAt(station, facts),
    refusal: (act) =>
      STATIONS_OF[act].includes(station) ? null : refuseStation("wrong_station", { act, station }),
  };
}

export function messagePurpose(text: string): Purpose {
  return {
    policy: "read",
    prompt: () => text,
    refusal: (act) => (act === "order_show" ? null : refuseStation("message_turn", { act })),
  };
}

type BranchFacts = { readonly tip: string; readonly clean: boolean };

type WorkContext = { readonly station: Station; readonly state: OrderState; readonly branch: BranchFacts };

type Returning = { readonly station: Station; readonly what: string; readonly command: string };

function parsedAs<T>(text: string, schema: z.ZodType<T>, { station, what, command }: Returning): T {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw refuseStation("not_done", { station, missed: `the ${what} is not JSON: ${error}`, command });
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const missed = parsed.error.issues.map((issue) => `${[what, ...issue.path].join(".")}: ${issue.message}`);
  throw refuseStation("not_done", { station, missed: missed.join("; "), command });
}

function reasonOf(reason: string, command: string): string {
  if (reason.trim() === "") throw refuseStation("no_reason", { command });
  return reason;
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
    details: { station, reason: reasonOf(request.reason, WORKER_COMMAND.order_return) },
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
      reason: reasonOf(request.reason, WORKER_COMMAND.finding_answer),
    },
  };
}

function buildReturned(request: BuildReturn, { state, branch }: WorkContext): Later {
  const missed = buildMissing(state, branch, request.artifact);
  if (missed.length > 0) {
    throw refuseStation("not_done", {
      station: "build",
      missed: missed.join("; "),
      command: WORKER_COMMAND.build_return,
    });
  }
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

export type WorkRequest = Exclude<
  TurnRequest,
  { readonly act: "order_show" | "slice_submit" | "message_send" }
>;

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
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    throw refuseStation("bad_request", { issues: `not JSON: ${error}` });
  }
  const request = TurnRequest.safeParse(raw);
  if (request.success) return request.data;
  throw refuseStation("bad_request", {
    issues: request.error.issues.map((issue) => issue.message).join("; "),
  });
}

export const MISSES_TO_FAIL = 2;

export type Refused = {
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

export type TurnEnd = "returned" | "no_return" | "closed";

export function turnEnd(state: OrderState, station: Station): TurnEnd {
  if (state.status !== "running") return "closed";
  return atStation(state, station) ? "no_return" : "returned";
}
