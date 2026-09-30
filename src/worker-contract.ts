import { CodedError } from "./coded-error";
import type { Station } from "./order-contract";

type WorkerRefusalMeta = {
  readonly no_session: { readonly cwd: string };
  readonly no_project: { readonly cwd: string };
  readonly operator_live: { readonly project: string; readonly operator: string };
  readonly not_operator: { readonly project: string };
};

export type WorkerRefusalCode = keyof WorkerRefusalMeta;

const MESSAGES: { readonly [Code in WorkerRefusalCode]: (meta: WorkerRefusalMeta[Code]) => string } = {
  no_session: ({ cwd }) =>
    `no live harness session of this project runs above this process in ${cwd}; register from inside the operator's session`,
  no_project: ({ cwd }) => `${cwd} is not inside a checkout whose origin remote names an owner/repo project`,
  operator_live: ({ project, operator }) =>
    `${operator} is the live operator of ${project}; a second one waits until that session ends`,
  not_operator: ({ project }) =>
    `this process runs under no registered operator session of ${project}, and only the operator takes order actions`,
};

export function refuse<Code extends WorkerRefusalCode>(
  code: Code,
  meta: WorkerRefusalMeta[Code],
): CodedError<Code, WorkerRefusalMeta[Code]> {
  return new CodedError(code, MESSAGES[code](meta), meta);
}

export const ROLES = ["operator", "planner", "builder", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export type StationRole = Exclude<Role, "operator">;

export const ROLE_OF_STATION: Readonly<Record<Station, StationRole>> = {
  plan: "planner",
  build: "builder",
  review: "reviewer",
};

export type ProcessId = { readonly pid: number; readonly startedAt: string };

export type ProcessRow = ProcessId & { readonly ppid: number };

export type Worker =
  | { readonly role: "operator"; readonly name: string; readonly project: string }
  | {
      readonly role: StationRole;
      readonly name: string;
      readonly project: string;
      readonly order: string;
      readonly createdBy: string;
    };

export type WorkerSession = {
  readonly id: string;
  readonly worker: string;
  readonly harness: string;
  readonly process: ProcessId;
};
