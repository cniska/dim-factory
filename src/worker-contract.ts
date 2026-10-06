import { refuser } from "./coded-error";
import type { HarnessName } from "./harness-contract";
import type { OpenSession } from "./hooks-sessions";

type WorkerRefusalMeta = {
  readonly no_session: { readonly cwd: string };
  readonly no_project: { readonly cwd: string };
  readonly not_operator: { readonly project: string };
  readonly not_station_worker: { readonly order: string; readonly station: string };
  readonly no_process_table: { readonly detail: string };
  readonly unknown_session: { readonly session: string };
};

export const refuseWorker = refuser<WorkerRefusalMeta>({
  no_session: {
    message: ({ cwd }) =>
      `no live harness session of this project runs above this process in ${cwd}, so it cannot act as the project's operator; act from inside a harness session whose hooks dim installed`,
    resolve: () => "dim hooks install",
  },
  no_project: {
    message: ({ cwd }) => `${cwd} is not inside a checkout whose origin remote names an owner/repo project`,
    resolve: () => "dim order add --title <title> --description <description> --project <owner>/<repo>",
  },
  not_operator: {
    message: ({ project }) =>
      `this process runs under no session of ${project}'s operator, whose live session is another one or who is a station worker, and only the operator takes order actions`,
    resolve: () =>
      "take order actions only from the operator's live session; a station worker ends its work with its own return",
  },
  not_station_worker: {
    message: ({ order, station }) =>
      `only order ${order}'s worker at ${station} does that station's work, from inside its turn`,
    resolve: ({ order }) => `dim order show ${order}`,
  },
  unknown_session: {
    message: ({ session }) => `no station worker's session ${session} is on record with a transcript`,
    resolve: () => "dim order show <order>",
  },
  no_process_table: {
    message: ({ detail }) =>
      `ps could not list this machine's processes, so who acts cannot be read: ${detail}`,
    resolve: () => "stop and hand this error to the owner: `ps -A -o pid=,ppid=,lstart=` must run here",
  },
});

export const ROLES = ["operator", "planner", "builder", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export type StationRole = Exclude<Role, "operator">;

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
  readonly harness: HarnessName;
  readonly process: ProcessId;
};

export type Acting = { readonly worker: Worker; readonly session: WorkerSession };

export type Caller = {
  readonly acting: Acting | null;
  readonly cwd: string;
  readonly self: ProcessId;
  readonly running: readonly ProcessId[];
  readonly chain: readonly ProcessId[];
  readonly open: readonly OpenSession[];
};

export type WorkerRecord = { readonly worker: Worker; readonly sessions: readonly WorkerSession[] };

export type Tokens = { readonly input: number; readonly output: number; readonly cachedRead: number };
