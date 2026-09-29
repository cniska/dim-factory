import { CodedError } from "./coded-error";
import { HARNESSES, type HarnessName } from "./harness-name";
import type { Role } from "./worker-roles";

const STATIONS = ["plan", "build", "review"] as const;

export type Station = (typeof STATIONS)[number];

export const STATIONS_SQL = STATIONS.map((station) => `'${station}'`).join(",");

export type StationRole = Exclude<Role, "operator">;

export const STATION_ROLES = {
  plan: "planner",
  build: "builder",
  review: "reviewer",
} as const satisfies Record<Station, StationRole>;

type Turn = { orderId: string; station: Station };

const rerun = (m: Turn): string =>
  `\`dim order ${m.station} ${m.orderId}\` briefs a new ${STATION_ROLES[m.station]} from the record`;

export type Proof = { tests: readonly string[]; base: string };

const proved = (proof: Proof | null): string =>
  proof === null ? "" : `the proof of ${proof.tests.join(", ")} at ${proof.base} was refused: `;

const MESSAGES = {
  usage_limited: (m: { harness: HarnessName; resetsAt: string | null }) =>
    `${m.harness} stopped at its usage limit ${m.resetsAt ? `until ${m.resetsAt}` : "with no reset given"}; delegate again after the reset with --harness ${m.harness}, or name another of <${HARNESSES.join("|")}>`,
  turn_unfinished: (m: Turn & { detail: string | null }) =>
    `${STATION_ROLES[m.station]} did not finish${m.detail === null ? "" : `: ${m.detail}`}; ${rerun(m)}`,
  turn_unstarted: (m: Turn) =>
    `order ${m.orderId} ${STATION_ROLES[m.station]} did not start a turn; ${rerun(m)}`,
  worker_sessionless: (m: { orderId: string; role: StationRole; worker: string }) =>
    `order ${m.orderId} ${m.role} ${m.worker} accepted its assignment with no harness session, which a rebuild with the order in flight leaves; \`dim order drop ${m.orderId}\` ends the order`,
  worktree_missing: (m: { orderId: string; worktree: string }) =>
    `order ${m.orderId} has no worktree at ${m.worktree}; the first \`dim order plan ${m.orderId}\` starts it and makes one`,
  worktree_not_checkout: (m: { orderId: string; worktree: string }) =>
    `order ${m.orderId}'s worktree at ${m.worktree} is not a git checkout, so the builder has no workspace to read; \`dim order drop ${m.orderId}\` ends the order`,
  not_a_repo: (m: { dir: string }) => `${m.dir} is not a git repo that can be read`,
  worktree_dirty: (m: { dir: string }) =>
    `${m.dir} has uncommitted changes, and a round reads a commit: commit them or put them aside`,
  no_commit: (m: { orderId: string }) =>
    `order ${m.orderId} recorded no commit, so there is no slice to read; \`dim order build ${m.orderId}\` commits one`,
  head_unrecorded: (m: { orderId: string; head: string }) =>
    `${m.head} is not a commit order ${m.orderId} recorded; only a build turn's commit can be reviewed`,
  harness_bound: (m: { orderId: string; role: StationRole; harness: HarnessName }) =>
    `order ${m.orderId} ${m.role} runs under the ${m.harness} harness; delegate it with --harness ${m.harness}`,
  no_declared_check: (m: { trunk: string }) =>
    `${m.trunk} declares no check, so the builder's turn cannot be verified`,
  check_redefined: (m: { task: string; source: string; trunk: string }) =>
    `the turn redefines ${m.task} in ${m.source}, the check ${m.trunk} declares; restore it, since a change to the check lands on ${m.trunk} before an order is checked by it`,
  empty_artifact: (_m: Record<string, never>) => "the final slice's turn returned an empty Build artifact",
  rebase_in_progress: (m: { worktree: string }) =>
    `${m.worktree} is mid-rebase, and a commit made there would land inside the rebase rather than on the order's branch`,
  builder_committed: (m: { branch: string | null; head: string; orderId: string; base: string }) =>
    `worktree HEAD is ${m.branch ?? "detached"} at ${m.head}, not refs/heads/${m.orderId} at ${m.base}; the runner commits a turn, so leave changes uncommitted`,
  nested_repository: (m: { nested: string; act: "stage" | "rebase"; proof: Proof | null }) =>
    `${proved(m.proof)}${m.nested} is a git repository inside the worktree, which ${m.act === "rebase" ? "a rebase there would run git in" : "the runner does not stage"}`,
  check_changed_tree: (m: { command: string; proof: Proof | null }) =>
    `${proved(m.proof)}the check changed the worktree while it ran, so it did not run over the tree it was handed: ${m.command}`,
  attributes_changed: (m: { changed: readonly string[]; trunk: string }) =>
    `the turn changes ${m.changed.join(", ")}, which decides the files the comment ban reads;\nrestore it, since a change to it lands on ${m.trunk} before an order is held to it`,
  comment_added: (m: { label: string; found: readonly { path: string; line: number }[] }) =>
    [
      `the turn adds a code comment, which ${m.label} bans:`,
      ...m.found.map(({ path, line }) => `  ${path}:${line}`),
      "put the why in a name, a test, or the doc that owns the subject",
    ].join("\n"),
  proof_unnamed: (_m: Record<string, never>) =>
    "a fix order's slice turn names no test; name in tests each test file the slice adds or changes to prove the defect",
  proof_untouched: (m: { tests: readonly string[] }) =>
    `the turn names test ${m.tests.join(", ")}, which the slice does not add or change; name only test files the slice adds or changes`,
  proof_green: (m: { command: string; base: string; tests: readonly string[]; output: string }) =>
    `${m.command} passed at ${m.base} with only ${m.tests.join(", ")} laid over it, so the named tests do not fail without the fix:\n${m.output}`,
  answer_not_owed: (m: { findings: readonly number[] }) =>
    `the turn answers finding ${m.findings.join(", ")}, which its brief did not hand over as work or answers twice`,
  finding_unanswered: (m: { findings: readonly number[] }) =>
    `the turn leaves finding ${m.findings.join(", ")} unanswered; answer each finding the brief lists as work, fixed or refused`,
  commit_refused: (m: { stderr: string }) => `git refused the commit: ${m.stderr}`,
  check_failed: (m: { command: string; exitCode: number; checkId: number }) =>
    `${m.command} exited ${m.exitCode} in the check sandbox; its output is on check ${m.checkId}`,
  no_change: (m: { fixed: readonly number[] }) =>
    m.fixed.length === 0
      ? "the turn left no change in the worktree to commit"
      : `the turn answers finding ${m.fixed.join(", ")} fixed and left no change in the worktree; refuse a finding that needs no change, with the reason`,
  rebase_mismatch: (m: { worktree: string; orderId: string; oldHead: string; newBase: string }) =>
    `${m.worktree} is not mid-rebase of ${m.orderId} from ${m.oldHead} onto ${m.newBase}, the rebase its ship recorded`,
  rebase_moved: (m: {
    worktree: string;
    branch: string | null;
    head: string;
    orderId: string;
    oldHead: string;
  }) =>
    `${m.worktree} is at ${m.branch ?? "a detached HEAD"} ${m.head}, not refs/heads/${m.orderId} at ${m.oldHead}, the head its ship recorded`,
  conflict_marked: (m: { paths: readonly string[] }) =>
    `the resolution still carries conflict markers in ${m.paths.join(", ")}, so the rebase was not continued`,
  conflict_emptied: (m: { paths: readonly string[] }) =>
    `the resolution leaves the replayed commit empty, dropping the order's change in ${m.paths.join(", ")}; keep that change alongside the trunk's`,
  rebase_check_failed: (m: { command: string; exitCode: number; head: string; checkId: number }) =>
    `${m.command} exited ${m.exitCode} at the rebased head ${m.head}; the rebase was taken back and is reopened next turn; its output is on check ${m.checkId}`,
};

type StationErrorCode = keyof typeof MESSAGES;
type StationErrorMeta<Code extends StationErrorCode> = Parameters<(typeof MESSAGES)[Code]>[0];

export function fail<Code extends StationErrorCode>(
  code: Code,
  meta: StationErrorMeta<Code>,
): CodedError<Code, StationErrorMeta<Code>> {
  const message = (MESSAGES[code] as (m: StationErrorMeta<Code>) => string)(meta);
  return new CodedError(code, message, meta);
}
