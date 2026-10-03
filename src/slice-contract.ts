import { refuser } from "./coded-error";
import type { StopMeta } from "./order-contract";

const SUBMIT = () => "git add -A && git commit && dim slice submit";

export const refuseSlice = refuser<StopMeta<"slice_refused">>({
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
    message: ({ order, tip }) =>
      `${tip} declares no check task, so no slice of order ${order} can be judged; the project needs one such as a verify script`,
    resolve: () => 'dim order return --reason "the project declares no check task"',
  },
  not_rebased: {
    message: ({ tip, onto, commits }) =>
      `${tip} is not the order's ${commits} commits rebased onto ${onto} with the rebase finished, so the branch is back at the recorded head`,
    resolve: ({ onto }) => `git rebase --reapply-cherry-picks --empty=keep ${onto} && dim slice submit`,
  },
});
