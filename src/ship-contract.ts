import { refuser } from "./coded-error";

type ShipRefusalMeta = {
  readonly ship_unset: { readonly order: string; readonly project: string };
  readonly checkout_dirty: { readonly order: string; readonly checkout: string };
  readonly ship_conflict: {
    readonly order: string;
    readonly commit: string;
    readonly paths: readonly string[];
  };
  readonly ship_check_failed: {
    readonly order: string;
    readonly head: string;
    readonly command: string;
    readonly exitCode: number | null;
  };
  readonly ship_no_check: { readonly order: string; readonly head: string };
};

export const refuseShip = refuser<ShipRefusalMeta>({
  ship_unset: {
    message: ({ order, project }) =>
      `${project}'s settings on its default branch say nothing about how it ships, so order ${order} waits to ship`,
    resolve: () => "dim config set ship default-branch --project",
  },
  checkout_dirty: {
    message: ({ order, checkout }) =>
      `the checkout ${checkout} holds uncommitted changes, so order ${order} does not land there yet`,
    resolve: ({ order }) => `dim order run ${order}`,
  },
  ship_conflict: {
    message: ({ order, commit, paths }) =>
      `order ${order}'s commit ${commit} conflicts with the default branch in ${paths.join(", ")}, so the order is back at build with the merge in its workspace`,
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
    resolve: () => "dim doctor",
  },
});
