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
  not_rebased: {
    message: ({ tip, onto, commits }) =>
      `${tip} is not the order's ${commits} commits rebased onto ${onto} with the rebase finished, so the branch is back at the recorded head`,
    resolve: ({ onto }) => `git rebase --reapply-cherry-picks --empty=keep ${onto} && dim slice submit`,
  },
});
