import { join } from "node:path";
import type { z } from "zod";
import { unreachable } from "./assert";
import { listedEnv, PASSED_THROUGH } from "./check";
import { type CodedError, recordOf } from "./coded-error";
import type { Models } from "./config";
import type { Policy } from "./harness-contract";
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
  worker: string,
  signIn: readonly string[],
): Record<string, string> {
  const email = `${worker}@dim.local`;
  return {
    ...listedEnv(owner, [...PASSED_THROUGH, ...XDG, ...signIn]),
    HOME: turn.home,
    TMPDIR: turn.tmp,
    [TURN_SOCKET_ENV]: turn.socket,
    GIT_AUTHOR_NAME: worker,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: worker,
    GIT_COMMITTER_EMAIL: email,
  };
}

type Places = { readonly workspace: string; readonly checkout: string; readonly turn: Turn };

export function policyAt(station: Station, { workspace, checkout, turn }: Places): Policy {
  const checkoutGit = join(checkout, ".git");
  if (station !== "build") return { kind: "read", writable: [turn.tmp], denied: [workspace, checkoutGit] };
  return { kind: "edit", writable: [turn.tmp], denied: [join(workspace, ".git", "hooks"), checkoutGit] };
}

const orderFacts = (state: OrderState) => ({
  id: state.id,
  title: state.title,
  project: state.project,
  description: state.description,
});

export type BriefFacts = { readonly state: OrderState; readonly workspace: string; readonly diff: string };

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
      return JSON.stringify({
        skill: SKILLS.review,
        order: orderFacts(state),
        workspace,
        build: state.buildArtifact,
        diff,
        answers: state.findings.flatMap(({ id, file, line, answer, reason }) =>
          answer === null ? [] : [{ finding: id, file, line, answer, reason }],
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
  plan_return: ["plan"],
  slice_submit: ["build"],
  finding_answer: ["build"],
  build_return: ["build"],
  review_return: ["review"],
};

export function actAllowed(request: TurnRequest, station: Station): void {
  if (!STATIONS_OF[request.act].includes(station)) {
    throw refuseStation("wrong_station", { act: request.act, station });
  }
}

type BranchFacts = { readonly tip: string; readonly clean: boolean };

type WorkContext = { readonly station: Station; readonly state: OrderState; readonly branch: BranchFacts };

function planOf(text: string, command: string): Plan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw refuseStation("not_done", { station: "plan", missed: `the plan is not JSON: ${error}`, command });
  }
  const plan = Plan.safeParse(raw);
  if (plan.success) return plan.data;
  const missed = plan.error.issues.map((issue) => `${issue.path.join(".") || "plan"}: ${issue.message}`);
  throw refuseStation("not_done", { station: "plan", missed: missed.join("; "), command });
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

const PLAN_RETURN = "dim plan return <file>";
const ORDER_RETURN = "dim order return --reason <reason>";
const FINDING_ANSWER = "dim finding answer <finding> fixed|refused --reason <reason>";
const BUILD_RETURN = "dim build return <file>";

function planReturned(request: PlanReturn): Later {
  return { action: "plan_returned", details: planOf(request.plan, PLAN_RETURN) };
}

function orderReturned(request: OrderReturn, { station }: WorkContext): Later {
  return { action: "order_returned", details: { station, reason: reasonOf(request.reason, ORDER_RETURN) } };
}

function findingAnswered(request: FindingAnswer, { state }: WorkContext): Later {
  const finding = state.findings.find((one) => one.id === request.finding);
  if (finding === undefined) throw refuseStation("no_finding", { finding: request.finding });
  if (finding.answer !== null) throw refuseStation("finding_answered", { finding: request.finding });
  return {
    action: "finding_answered",
    details: {
      finding: finding.id,
      answer: request.answer,
      reason: reasonOf(request.reason, FINDING_ANSWER),
    },
  };
}

function buildReturned(request: BuildReturn, { state, branch }: WorkContext): Later {
  const missed = buildMissing(state, branch, request.artifact);
  if (missed.length > 0) {
    throw refuseStation("not_done", { station: "build", missed: missed.join("; "), command: BUILD_RETURN });
  }
  return { action: "build_returned", details: { artifact: request.artifact } };
}

const REVIEW_RETURN = "dim review return --findings <file> | --artifact <file>";

function parsedAs<T>(text: string, schema: z.ZodType<T>, what: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw refuseStation("not_done", {
      station: "review",
      missed: `the ${what} is not JSON: ${error}`,
      command: REVIEW_RETURN,
    });
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const missed = parsed.error.issues.map((issue) => `${what}.${issue.path.join(".")}: ${issue.message}`);
  throw refuseStation("not_done", { station: "review", missed: missed.join("; "), command: REVIEW_RETURN });
}

function reviewReturned(request: ReviewReturn, { state }: WorkContext): Later {
  const { returned } = request;
  if (returned.kind === "artifact") {
    const artifact = parsedAs(returned.text, ReviewArtifact, "Review artifact");
    return { action: "review_returned", details: { returned: { kind: "artifact", artifact } } };
  }
  const round = state.lastSeq + 1;
  const findings = parsedAs(returned.text, ReviewFindings, "findings").map((finding, index) => ({
    ...finding,
    id: `f${round}-${index + 1}`,
  }));
  return { action: "review_returned", details: { returned: { kind: "findings", findings } } };
}

export type WorkRequest = Exclude<TurnRequest, { readonly act: "order_show" | "slice_submit" }>;

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
