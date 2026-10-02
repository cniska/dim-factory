import type { HarnessName } from "./harness-registry";

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
  | { readonly kind: "finished"; readonly result: string | null }
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

export type Spawn = {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly session: string;
};

export type Spawned = {
  readonly pid: number;
  prompt(text: string): void;
  kill(): void;
  readonly ended: Promise<Ended>;
};

export type Adapter = {
  readonly name: HarnessName;
  readonly signIn: readonly string[];
  readonly tempRoot: string;
  argv(start: Start): readonly string[];
  transcript(home: string, workspace: string, session: string): string;
  outcome(ended: Ended, session: SessionStart): Outcome;
};
