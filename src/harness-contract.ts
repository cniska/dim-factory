import { refuser } from "./coded-error";

export type Policy = {
  readonly kind: "read" | "edit";
  readonly writable: readonly string[];
  readonly denied: readonly string[];
};

export type SessionStart =
  | { readonly kind: "new"; readonly id: string }
  | { readonly kind: "resume"; readonly id: string }
  | { readonly kind: "fork"; readonly id: string; readonly from: string };

export type Outcome =
  | { readonly kind: "finished" }
  | { readonly kind: "died"; readonly code: "killed" | "resume_failed" }
  | { readonly kind: "died"; readonly code: "usage_limit"; readonly resetsAt: string | null };

export type Start = {
  readonly session: SessionStart;
  readonly model: string;
  readonly policy: Policy;
  readonly socket: string;
};

export type Ended = {
  readonly lines: readonly string[];
  readonly stderr: string;
  readonly exitCode: number | null;
};

export type Spawned = {
  readonly pid: number;
  prompt(text: string): void;
  kill(): void;
  readonly ended: Promise<Ended>;
};

export type Adapter = {
  readonly signIn: readonly string[];
  readonly tempRoot: string;
  argv(start: Start): readonly string[];
  transcript(home: string, workspace: string, session: string): string;
  outcome(ended: Ended, session: SessionStart): Outcome;
};

type HarnessRefusalMeta = {
  readonly no_adapter: { readonly harness: string };
};

export const refuseHarness = refuser<HarnessRefusalMeta>({
  no_adapter: {
    message: ({ harness }) =>
      `dim cannot start a station worker under ${harness}; Claude Code is the harness built`,
    resolve: () => "dim config set harness claude",
  },
});
