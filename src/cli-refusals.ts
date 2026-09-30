import type { ConfigErrorCode } from "./config-error";
import type { GateErrorCode } from "./gate-contract";

export type RefusalCode =
  | "usage"
  | "command_failed"
  | "record_version"
  | "no_database"
  | "lock_held"
  | GateErrorCode
  | ConfigErrorCode;

export type ResolveContext = { readonly command: string; readonly usage: string };

const SHOW_CONFIG = () => "dim config";
const INSTALL_GATE = () => "dim gate install --owner <host>/<account>";

const RESOLVE: { readonly [Code in RefusalCode]: (context: ResolveContext) => string } = {
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
};

export function isRefusalCode(code: string): code is RefusalCode {
  return Object.hasOwn(RESOLVE, code);
}

export function resolveOf(code: RefusalCode, context: ResolveContext): string {
  return RESOLVE[code](context);
}
