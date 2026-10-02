import { refuser } from "./coded-error";

export const refuseGit = refuser<{
  readonly git_unreadable: { readonly root: string; readonly what: string; readonly detail: string };
  readonly git_output_malformed: { readonly command: string; readonly problem: string };
}>({
  git_unreadable: {
    message: ({ root, what, detail }) => `cannot read ${what} in ${root}: ${detail}`,
    resolve: ({ root }) => `git -C ${root} status`,
  },
  git_output_malformed: {
    message: ({ command, problem }) => `${command} printed ${problem}`,
    resolve: () => "git --version",
  },
});
