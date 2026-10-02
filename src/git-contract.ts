import { refuser } from "./coded-error";

export const refuseGit = refuser<{
  readonly git_failed: {
    readonly repo: string;
    readonly command: string;
    readonly status: number;
    readonly detail: string;
  };
  readonly git_output_malformed: { readonly command: string; readonly problem: string };
}>({
  git_failed: {
    message: ({ repo, command, status, detail }) =>
      `${command} failed in ${repo} with exit ${status}${detail === "" ? "" : `: ${detail}`}`,
    resolve: ({ repo }) => `git -C ${repo} status`,
  },
  git_output_malformed: {
    message: ({ command, problem }) => `${command} printed ${problem}`,
    resolve: () => "git --version",
  },
});
