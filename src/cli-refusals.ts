import type { ConfigErrorCode, ConfigErrorMeta } from "./config-error";
import type { RecordVersionMeta } from "./db";
import type { GateErrorMeta } from "./gate-contract";
import type { Next, OrderRefusalMeta } from "./order-contract";
import type { WorkerRefusalMeta } from "./worker-contract";

type None = Record<string, never>;

type Metas = {
  readonly usage: None;
  readonly command_failed: None;
  readonly record_version: RecordVersionMeta;
  readonly no_database: { readonly path: string };
  readonly lock_held: { readonly path: string; readonly pid: number };
} & GateErrorMeta & { readonly [Code in ConfigErrorCode]: ConfigErrorMeta } & WorkerRefusalMeta &
  OrderRefusalMeta;

export type RefusalCode = keyof Metas & string;

export type ResolveContext = { readonly command: string; readonly usage: string };

type Resolve<Code extends RefusalCode> = (context: ResolveContext & { readonly meta: Metas[Code] }) => string;

const SHOW_CONFIG = () => "dim config";
const INSTALL_GATE = () => "dim gate install --owner <host>/<account>";
const REGISTER = () => "dim operator register";
const ADD_ORDER = () => "dim order add --title <title> --description <description>";

const STEP: Readonly<Record<Next, (order: string) => string>> = {
  run: (order) => `dim order run ${order}`,
  approve: (order) => `dim order approve ${order} --reason <reason> --decided owner|operator`,
  update: (order) => `dim order update ${order} --description <description>`,
};

const RESOLVE: { readonly [Code in RefusalCode]: Resolve<Code> } = {
  usage: ({ usage }) => usage,
  command_failed: () => "dim doctor",
  record_version: () => "dim rebuild",
  no_database: () => "dim sync",
  lock_held: ({ command }) => `dim ${command}`,
  gate_unreadable_update: () => "dim doctor",
  gate_unreadable_owners: INSTALL_GATE,
  gate_git_config_unreadable: () => "dim doctor",
  gate_hooks_path_taken: INSTALL_GATE,
  gate_commits_unenumerable: () => "dim gate check <range>",
  config_unparsed: SHOW_CONFIG,
  config_invalid: SHOW_CONFIG,
  config_not_an_array: SHOW_CONFIG,
  config_not_an_object: SHOW_CONFIG,
  config_unwritable: SHOW_CONFIG,
  config_absent: SHOW_CONFIG,
  no_session: REGISTER,
  no_project: () => "dim order add --title <title> --description <description> --project <owner>/<repo>",
  operator_live: REGISTER,
  not_operator: REGISTER,
  no_order: ADD_ORDER,
  not_next_step: ({ meta }) =>
    meta.next === null ? `dim order show ${meta.order}` : STEP[meta.next](meta.order),
  plan_approved: ({ meta }) => `dim order cancel ${meta.order} --reason <reason>`,
  no_checkout: ADD_ORDER,
  no_default_branch: () => "dim doctor",
};

export function isRefusalCode(code: string): code is RefusalCode {
  return Object.hasOwn(RESOLVE, code);
}

export function resolveOf(code: RefusalCode, context: ResolveContext, meta: object): string {
  const resolve = RESOLVE[code] as Resolve<RefusalCode>;
  return resolve({ ...context, meta: meta as Metas[RefusalCode] });
}
