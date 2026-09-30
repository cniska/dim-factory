import { refuser } from "./coded-error";

type Tip = { readonly order: string; readonly tip: string };

type SliceRefusalMeta = {
  readonly head_moved: Tip & { readonly head: string };
  readonly check_changed: Tip;
  readonly workspace_dirty: Tip;
  readonly check_failed: Tip & { readonly command: string; readonly exitCode: number | null };
  readonly check_rewrote: Tip & { readonly command: string };
  readonly no_check: { readonly order: string };
};

const SUBMIT = () => "git add -A && git commit && dim slice submit";

export const refuseSlice = refuser<SliceRefusalMeta>({
  head_moved: {
    message: ({ tip, head }) =>
      `${tip} is not one new commit on the order's recorded head ${head}, so the branch is back at ${head} and the changes stay in the workspace`,
    resolve: SUBMIT,
  },
  check_changed: {
    message: ({ tip }) =>
      `${tip} changes how the project's check is declared, and a slice may not change what judges it; the branch is back at the recorded head`,
    resolve: SUBMIT,
  },
  workspace_dirty: {
    message: ({ tip }) =>
      `the workspace holds changes ${tip} does not commit, so the check would not judge exactly the committed code; the branch is back at the recorded head`,
    resolve: SUBMIT,
  },
  check_failed: {
    message: ({ tip, command, exitCode }) =>
      `\`${command}\` failed on ${tip} (exit ${exitCode}); its output is on the refused slice's log entry, and the branch is back at the recorded head`,
    resolve: SUBMIT,
  },
  check_rewrote: {
    message: ({ tip, command }) =>
      `\`${command}\` passed on ${tip} but changed the workspace, so the committed code is not what it judged; the branch is back at the recorded head`,
    resolve: SUBMIT,
  },
  no_check: {
    message: ({ order }) =>
      `the project of order ${order} declares no check task, so no slice can be judged; declare one such as a verify script`,
    resolve: () => "dim doctor",
  },
});

export type SliceCode = Exclude<keyof SliceRefusalMeta, "no_check">;
