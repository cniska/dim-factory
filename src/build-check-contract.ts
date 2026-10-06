import { refuser } from "./coded-error";
import type { StopMeta } from "./order-contract";

const FIX = () => "git add -A && git commit && dim slice submit && dim build return <file>";

export const refuseBuild = refuser<StopMeta<"build_refused">>({
  check_failed: {
    message: ({ head, command, exitCode }) =>
      `\`${command}\` failed on the build's head ${head} (exit ${exitCode}), so the build was not returned; the check's output is on the refused build's log entry`,
    resolve: FIX,
  },
  check_rewrote: {
    message: ({ head, command }) =>
      `\`${command}\` passed on the build's head ${head} but changed the workspace, so the committed code is not what it judged and the build was not returned`,
    resolve: FIX,
  },
  no_check: {
    message: ({ order, head }) =>
      `${head} declares no check task, so order ${order}'s build cannot be judged; the project needs one`,
    resolve: () => 'dim order return --reason "the project declares no check task"',
  },
});
