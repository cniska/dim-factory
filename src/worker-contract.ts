import { refuser } from "./coded-error";

type WorkerRefusalMeta = {
  readonly no_session: { readonly cwd: string };
  readonly no_project: { readonly cwd: string };
  readonly operator_live: { readonly project: string; readonly operator: string };
  readonly not_operator: { readonly project: string };
  readonly not_station_worker: { readonly order: string; readonly station: string };
  readonly no_process_table: { readonly detail: string };
  readonly unknown_session: { readonly session: string };
};

const REGISTER = () => "dim operator register";

export const refuseWorker = refuser<WorkerRefusalMeta>({
  no_session: {
    message: ({ cwd }) =>
      `no live harness session of this project runs above this process in ${cwd}; register from inside the operator's session`,
    resolve: REGISTER,
  },
  no_project: {
    message: ({ cwd }) => `${cwd} is not inside a checkout whose origin remote names an owner/repo project`,
    resolve: () => "dim order add --title <title> --description <description> --project <owner>/<repo>",
  },
  operator_live: {
    message: ({ project, operator }) =>
      `${operator} is the live operator of ${project}; a second one waits until that session ends`,
    resolve: REGISTER,
  },
  not_operator: {
    message: ({ project }) =>
      `this process runs under no registered operator session of ${project}, and only the operator takes order actions`,
    resolve: REGISTER,
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
    resolve: () => "dim doctor",
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
  readonly harness: string;
  readonly process: ProcessId;
};

export type Acting = { readonly worker: Worker; readonly session: WorkerSession };

export type Caller = {
  readonly acting: Acting | null;
  readonly self: ProcessId;
  readonly running: readonly ProcessId[];
};

export type WorkerRecord = { readonly worker: Worker; readonly sessions: readonly WorkerSession[] };
