import { join } from "node:path";
import { unreachable } from "./assert";
import { listedEnv, PASSED_THROUGH } from "./check";
import type { Models } from "./config";
import { type OrderState, openFindings, slicesOf } from "./order";
import { type Later, Plan, type Station } from "./order-contract";
import type { Env } from "./paths";
import {
  type BuildReturn,
  type FindingAnswer,
  type OrderReturn,
  type PlanReturn,
  refuseStation,
  TurnRequest,
} from "./station-contract";
import type { StationRole } from "./worker-contract";

export const TURN_SOCKET_ENV = "DIM_TURN_SOCKET";

export const STATIONS: readonly Station[] = ["plan", "build", "review"];

export const SKILLS: Readonly<Record<Station, string>> = {
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

export type Policy =
  | { readonly kind: "read"; readonly writable: readonly string[]; readonly denied: readonly string[] }
  | {
      readonly kind: "edit";
      readonly writable: readonly string[];
      readonly denied: readonly string[];
      readonly editDenied: readonly string[];
    };

export type Places = { readonly workspace: string; readonly checkout: string; readonly turn: Turn };

export function policyAt(station: Station, { workspace, checkout, turn }: Places): Policy {
  const checkoutGit = join(checkout, ".git");
  if (station !== "build") return { kind: "read", writable: [turn.tmp], denied: [workspace, checkoutGit] };
  const workspaceGit = join(workspace, ".git");
  return {
    kind: "edit",
    writable: [turn.tmp],
    denied: [join(workspaceGit, "hooks"), checkoutGit],
    editDenied: [workspaceGit, checkoutGit],
  };
}

const orderFacts = (state: OrderState) => ({
  id: state.id,
  title: state.title,
  project: state.project,
  description: state.description,
});

export type BriefedStation = Exclude<Station, "review">;

export function briefAt(station: BriefedStation, state: OrderState, workspace: string): string {
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
        conflict: null,
      });
    default:
      return unreachable(station);
  }
}

export type WorkRequest = Exclude<TurnRequest, { readonly act: "order_show" | "slice_submit" }>;

export type BranchFacts = { readonly tip: string; readonly clean: boolean };

export type WorkContext = {
  readonly station: Station;
  readonly state: OrderState;
  readonly branch: BranchFacts;
};

type Work<R> = {
  readonly stations: readonly Station[];
  readonly command: string;
  entry(request: R, context: WorkContext): Later;
};

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

export function buildMissing(state: OrderState, branch: BranchFacts, artifact: string): readonly string[] {
  const unbuilt = slicesOf(state).filter((slice) => slice.commit === undefined);
  const open = openFindings(state);
  return [
    ...unbuilt.map((slice) => `slice "${slice.title}" has no commit`),
    ...(branch.tip === state.head ? [] : ["the branch holds a commit the gates have not taken"]),
    ...(branch.clean ? [] : ["the workspace holds changes no slice commits"]),
    ...open.map((finding) => `finding ${finding.id} is not answered`),
    ...(artifact.trim() === "" ? ["the Build artifact is empty"] : []),
  ];
}

const PLAN_RETURN = "dim plan return <file>";
const ORDER_RETURN = "dim order return --reason <reason>";
const FINDING_ANSWER = "dim finding answer <finding> fixed|refused --reason <reason>";
const BUILD_RETURN = "dim build return <file>";

export const WORK: { readonly [A in WorkRequest["act"]]: Work<Extract<WorkRequest, { readonly act: A }>> } = {
  plan_return: {
    stations: ["plan"],
    command: PLAN_RETURN,
    entry: (request: PlanReturn) => ({ action: "plan_returned", details: planOf(request.plan, PLAN_RETURN) }),
  },
  order_return: {
    stations: STATIONS,
    command: ORDER_RETURN,
    entry: (request: OrderReturn, { station }) => ({
      action: "order_returned",
      details: { station, reason: reasonOf(request.reason, ORDER_RETURN) },
    }),
  },
  finding_answer: {
    stations: ["build"],
    command: FINDING_ANSWER,
    entry: (request: FindingAnswer, { state }) => {
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
    },
  },
  build_return: {
    stations: ["build"],
    command: BUILD_RETURN,
    entry: (request: BuildReturn, { state, branch }) => {
      const missed = buildMissing(state, branch, request.artifact);
      if (missed.length > 0) {
        throw refuseStation("not_done", {
          station: "build",
          missed: missed.join("; "),
          command: BUILD_RETURN,
        });
      }
      return { action: "build_returned", details: { artifact: request.artifact } };
    },
  },
};

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

function entryAt<R>(work: Work<R>, request: R, context: WorkContext): Later {
  if (!work.stations.includes(context.station)) {
    throw refuseStation("wrong_station", { act: work.command, station: context.station });
  }
  return work.entry(request, context);
}

export function workEntry(request: WorkRequest, context: WorkContext): Later {
  switch (request.act) {
    case "plan_return":
      return entryAt(WORK.plan_return, request, context);
    case "order_return":
      return entryAt(WORK.order_return, request, context);
    case "finding_answer":
      return entryAt(WORK.finding_answer, request, context);
    case "build_return":
      return entryAt(WORK.build_return, request, context);
    default:
      return unreachable(request);
  }
}

export function sliceSubmitAllowed(station: Station): void {
  if (station !== "build") throw refuseStation("wrong_station", { act: "dim slice submit", station });
}

export type TurnEnd = "returned" | "no_return" | "closed";

export function turnEnd(state: OrderState, station: Station): TurnEnd {
  if (state.status !== "running") return "closed";
  const { phase } = state;
  return phase.kind === "run" && phase.station === station ? "no_return" : "returned";
}
