import { CodedError } from "./coded-error";

export type Replay = { worktree: string; oldBase: string; newBase: string; oldHead: string };

export type Rewrite = Replay & {
  newHead: string;
  commits: { from: string; to: string }[];
  patchEqual: boolean;
};

const MESSAGES = {
  git_failed: (m: { dir: string; args: readonly string[]; stderr: string }) =>
    `git ${m.args.join(" ")} failed in ${m.dir}: ${m.stderr}`,
  rebase_failed: (m: { worktree: string; stderr: string }) =>
    `git could not rebase in ${m.worktree}: ${m.stderr}`,
  rebase_unpaired: (m: { worktree: string; from: number; to: number }) =>
    `the rebase in ${m.worktree} turned ${m.from} commits into ${m.to}, so no replayed commit can be paired with the one it replaced; the rebase was taken back`,
  rebase_unrestored: (m: { worktree: string; oldHead: string; stderr: string }) =>
    `the rebase could not be taken back, so ${m.worktree} is not at ${m.oldHead}: ${m.stderr}`,
  rebase_unaborted: (m: { worktree: string; stderr: string }) =>
    `the rebase in ${m.worktree} could not be aborted: ${m.stderr}`,
};

export type RebaseErrorCode = keyof typeof MESSAGES;
export type RebaseErrorMeta<Code extends RebaseErrorCode> = Parameters<(typeof MESSAGES)[Code]>[0];

export function fail<Code extends RebaseErrorCode>(
  code: Code,
  meta: RebaseErrorMeta<Code>,
): CodedError<Code, RebaseErrorMeta<Code>> {
  const message = (MESSAGES[code] as (m: RebaseErrorMeta<Code>) => string)(meta);
  return new CodedError(code, message, meta);
}
