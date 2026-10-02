import { refuser } from "./coded-error";

export const refuseComments = refuser<{
  readonly not_a_checkout: { readonly cwd: string };
}>({
  not_a_checkout: {
    message: ({ cwd }) => `${cwd} is not inside a git checkout, so it holds no tracked files to purge`,
    resolve: () => "cd into a git checkout, then dim comments purge",
  },
});
