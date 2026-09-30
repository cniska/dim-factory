import { CodedError } from "./coded-error";
import type { Env } from "./paths";

export const REFUSED_EXIT = 3;

export const SKIP_CHECK_ENV = "DIM_SKIP_CHECK";

export const GATE_HOOKS = ["commit-msg", "pre-commit", "pre-push"] as const;

export type GateHook = (typeof GATE_HOOKS)[number];

export type GateInput = {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Env;
  readonly stdin: () => string;
  readonly say: (line: string) => void;
};

export type Gate = {
  readonly owner: (input: GateInput) => string | null;
  readonly refusal: (input: GateInput) => readonly string[];
};

export const GATE_ERROR = {
  unreadableUpdate: "gate_unreadable_update",
  unreadableOwners: "gate_unreadable_owners",
  gitConfigUnreadable: "gate_git_config_unreadable",
  hooksPathTaken: "gate_hooks_path_taken",
  commitsUnenumerable: "gate_commits_unenumerable",
} as const;

type GateErrorMeta = {
  [GATE_ERROR.unreadableUpdate]: { readonly line: string };
  [GATE_ERROR.unreadableOwners]: { readonly path: string };
  [GATE_ERROR.gitConfigUnreadable]: { readonly args: string; readonly root: string; readonly detail: string };
  [GATE_ERROR.hooksPathTaken]: { readonly existing: string };
  [GATE_ERROR.commitsUnenumerable]: { readonly range: string; readonly detail: string };
};

type GateErrorCode = keyof GateErrorMeta;

const MESSAGES: { readonly [Code in GateErrorCode]: (meta: GateErrorMeta[Code]) => string } = {
  [GATE_ERROR.unreadableUpdate]: ({ line }) =>
    `git passed pre-push an update line that does not hold four fields, so the push is not judged: ${line}`,
  [GATE_ERROR.unreadableOwners]: ({ path }) =>
    `${path} names no readable owners, so this is not judged; dim install-commit-gate --owner=<host>/<account> --write rewrites it`,
  [GATE_ERROR.gitConfigUnreadable]: ({ args, root, detail }) =>
    `git config ${args} failed in ${root}: ${detail}`,
  [GATE_ERROR.hooksPathTaken]: ({ existing }) =>
    `git's global core.hooksPath is already ${existing}; git honors one hooks directory and there is no merge, so installing here would disable it. Point that directory at this hook, or unset it with \`git config --global --unset core.hooksPath\`.`,
  [GATE_ERROR.commitsUnenumerable]: ({ range, detail }) =>
    `cannot enumerate the commits of ${range}: ${detail}`,
};

export function fail<Code extends GateErrorCode>(
  code: Code,
  meta: GateErrorMeta[Code],
): CodedError<Code, GateErrorMeta[Code]> {
  return new CodedError(code, MESSAGES[code](meta), meta);
}
