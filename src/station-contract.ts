import { CodedError } from "./coded-error";
import { HARNESSES, type HarnessName } from "./harness-name";
import type { Role } from "./worker-roles";

const STATIONS = ["plan", "build", "review"] as const;

export type Station = (typeof STATIONS)[number];

export const STATIONS_SQL = STATIONS.map((station) => `'${station}'`).join(",");

export type StationRole = Exclude<Role, "operator">;

export const STATION_ROLES = {
  plan: "planner",
  build: "builder",
  review: "reviewer",
} as const satisfies Record<Station, StationRole>;

type Turn = { orderId: string; station: Station };

const rerun = (m: Turn): string =>
  `\`dim order ${m.station} ${m.orderId}\` briefs a new ${STATION_ROLES[m.station]} from the record`;

const MESSAGES = {
  usage_limited: (m: { harness: HarnessName; resetsAt: string | null }) =>
    `${m.harness} stopped at its usage limit ${m.resetsAt ? `until ${m.resetsAt}` : "with no reset given"}; delegate again after the reset with --harness ${m.harness}, or name another of <${HARNESSES.join("|")}>`,
  turn_unfinished: (m: Turn & { detail: string | null }) =>
    `${STATION_ROLES[m.station]} did not finish${m.detail === null ? "" : `: ${m.detail}`}; ${rerun(m)}`,
  turn_unstarted: (m: Turn) =>
    `order ${m.orderId} ${STATION_ROLES[m.station]} did not start a turn; ${rerun(m)}`,
  worker_sessionless: (m: { orderId: string; role: StationRole; worker: string }) =>
    `order ${m.orderId} ${m.role} ${m.worker} accepted its assignment with no harness session, which a rebuild with the order in flight leaves; \`dim order drop ${m.orderId}\` ends the order`,
  worktree_missing: (m: { orderId: string; worktree: string }) =>
    `order ${m.orderId} has no worktree at ${m.worktree}; the first \`dim order plan ${m.orderId}\` starts it and makes one`,
  worktree_not_checkout: (m: { orderId: string; worktree: string }) =>
    `order ${m.orderId}'s worktree at ${m.worktree} is not a git checkout, so the builder has no workspace to read; \`dim order drop ${m.orderId}\` ends the order`,
  not_a_repo: (m: { dir: string }) => `${m.dir} is not a git repo that can be read`,
  worktree_dirty: (m: { dir: string }) =>
    `${m.dir} has uncommitted changes, and a round reads a commit: commit them or put them aside`,
  no_commit: (m: { orderId: string }) =>
    `order ${m.orderId} recorded no commit, so there is no slice to read; \`dim order build ${m.orderId}\` commits one`,
  head_unrecorded: (m: { orderId: string; head: string }) =>
    `${m.head} is not a commit order ${m.orderId} recorded; only a build turn's commit can be reviewed`,
  harness_bound: (m: { orderId: string; role: StationRole; harness: HarnessName }) =>
    `order ${m.orderId} ${m.role} runs under the ${m.harness} harness; delegate it with --harness ${m.harness}`,
};

type StationErrorCode = keyof typeof MESSAGES;
type StationErrorMeta<Code extends StationErrorCode> = Parameters<(typeof MESSAGES)[Code]>[0];

export function fail<Code extends StationErrorCode>(
  code: Code,
  meta: StationErrorMeta<Code>,
): CodedError<Code, StationErrorMeta<Code>> {
  const message = (MESSAGES[code] as (m: StationErrorMeta<Code>) => string)(meta);
  return new CodedError(code, message, meta);
}
