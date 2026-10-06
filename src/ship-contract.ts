import { refuser } from "./coded-error";
import type { StopMeta } from "./order-contract";

export const refuseShip = refuser<StopMeta<"ship_stopped">>({
  ship_unset: {
    message: ({ order }) =>
      `the project's settings on its default branch say nothing about how it ships, so order ${order} waits to ship`,
    resolve: () => "dim config set ship default-branch --project",
  },
  checkout_dirty: {
    message: ({ order, checkout, reason }) =>
      `the checkout ${checkout} holds changes the landing would overwrite, so order ${order} does not land there yet: ${reason}`,
    resolve: ({ order }) => `dim order run ${order}`,
  },
  ship_conflict: {
    message: ({ order, onto, paths }) =>
      `order ${order} conflicts with the default branch at ${onto} in ${paths.join(", ")}, so the order is back at build to rebase onto it`,
    resolve: ({ order }) => `dim order run ${order}`,
  },
  rebase_failed: {
    message: ({ order, onto, reason }) =>
      `git could not rebase order ${order} onto ${onto}, so nothing landed and the order waits to ship: ${reason}`,
    resolve: ({ order }) => `dim order run ${order}`,
  },
  ship_check_failed: {
    message: ({ order, head, command, exitCode }) =>
      `\`${command}\` failed on order ${order} rebased onto the default branch (${head}, exit ${exitCode}), so the order is back at build`,
    resolve: ({ order }) => `dim order run ${order}`,
  },
  ship_no_check: {
    message: ({ order, head }) =>
      `order ${order} rebased at ${head} declares no check task, so it cannot be judged before it lands`,
    resolve: ({ order }) =>
      `ask the owner which declared task is the project's check, commit dim config set tasks.check <task> --project on the default branch, then dim order run ${order}`,
  },
});
