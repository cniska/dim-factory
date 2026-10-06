import { refuser } from "./coded-error";

export const GATE_NAMES = ["commit-subject", "check", "no-comments"] as const;

export type GateName = (typeof GATE_NAMES)[number];

export function isGateName(name: string): name is GateName {
  return GATE_NAMES.some((gate) => gate === name);
}

export const HOOKS_DIR = ".githooks";

export const PREPARE = `git config core.hooksPath ${HOOKS_DIR}`;

export const SCANNER_DIR = `${HOOKS_DIR}/no-comments`;

const INSTALL = `dim gates install <gate>..., choosing from ${GATE_NAMES.join(", ")}`;

export const refuseGates = refuser<{
  readonly not_a_checkout: { readonly cwd: string };
  readonly no_gates_chosen: { readonly root: string };
  readonly no_check: { readonly root: string };
  readonly no_ecosystem: {
    readonly root: string;
    readonly gate: GateName;
    readonly ecosystems: readonly string[];
  };
  readonly prepare_occupied: { readonly path: string; readonly prepare: string };
  readonly hooks_path_occupied: { readonly root: string; readonly hooksPath: string };
}>({
  not_a_checkout: {
    message: ({ cwd }) =>
      `${cwd} is not inside a git checkout, so there is no project to install the gates into`,
    resolve: () => "cd into the project's checkout, then dim gates install",
  },
  no_gates_chosen: {
    message: ({ root }) => `${root} has chosen no gates, so there is nothing to install or judge`,
    resolve: () => `stop and ask the owner which gates the project runs, then ${INSTALL}`,
  },
  no_check: {
    message: ({ root }) => `${root} declares no check, so the check gate has nothing to run before a commit`,
    resolve: () =>
      "stop and ask the owner which declared task is the project's check, then dim config set tasks.check <task> --project, or choose the gates without check",
  },
  no_ecosystem: {
    message: ({ root, gate, ecosystems }) =>
      `${root} tracks no ${ecosystems.join(" or ")} manifest, so the ${gate} gate has nothing it can read`,
    resolve: ({ gate }) => `stop and ask the owner whether to choose the gates without ${gate}`,
  },
  prepare_occupied: {
    message: ({ path, prepare }) =>
      `${path} runs \`${prepare}\` as its prepare script, so a fresh clone would not wire the gates`,
    resolve: ({ path }) =>
      `stop and hand this error to the owner: ${path}'s prepare script must become \`${PREPARE}\` before the gates install`,
  },
  hooks_path_occupied: {
    message: ({ root, hooksPath }) =>
      `${root} runs its git hooks from ${hooksPath}, so the gates in ${HOOKS_DIR} would never run`,
    resolve: ({ root }) =>
      `stop and hand this error to the owner: ${root}'s hooks must move to ${HOOKS_DIR} before the gates install`,
  },
});
