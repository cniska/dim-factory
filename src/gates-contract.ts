import { refuser } from "./coded-error";

export const HOOKS_DIR = ".githooks";

export const PREPARE = `git config core.hooksPath ${HOOKS_DIR}`;

export const refuseGates = refuser<{
  readonly not_a_checkout: { readonly cwd: string };
  readonly no_check: { readonly root: string };
  readonly prepare_occupied: { readonly path: string; readonly prepare: string };
  readonly hooks_path_occupied: { readonly root: string; readonly hooksPath: string };
}>({
  not_a_checkout: {
    message: ({ cwd }) =>
      `${cwd} is not inside a git checkout, so there is no project to install the gates into`,
    resolve: () => "cd into the project's checkout, then dim gates install",
  },
  no_check: {
    message: ({ root }) => `${root} declares no check, so no gate can run it before a commit`,
    resolve: () =>
      "stop and hand this error to the owner: the project must declare a verify, check, ci, validate or test task in package.json, mise.toml or a Makefile",
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
